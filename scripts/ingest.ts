/**
 * LLM Wiki ingestion pipeline
 *
 * Pulls data from political APIs, generates plain-English summaries for
 * any bill lacking one, and writes/updates wiki Markdown files.
 *
 * Usage:
 *   npx tsx scripts/ingest.ts [--federal] [--state] [--bills] [--dry-run]
 *
 * Requires these env vars (copy .env.example → .env):
 *   CONGRESS_GOV_API_KEY, OPENSTATES_API_KEY, ANTHROPIC_API_KEY
 *
 * Note: Congress.gov API covers all federal data (members + votes + bills).
 * ProPublica Congress API was removed — it is no longer available.
 */

import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// Resilient fetch: auto-retry with backoff + 30s timeout per request
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // AbortSignal.timeout covers both the TCP handshake AND response body read —
      // unlike clearTimeout-after-fetch, which left res.json() with no deadline.
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000) })
      return res
    } catch (err) {
      if (attempt === retries) throw err
      const delay = attempt * 2000
      console.warn(`  ⚠️  Request failed (attempt ${attempt}/${retries}), retrying in ${delay / 1000}s...`)
      await sleep(delay)
    }
  }
  throw new Error('fetchWithRetry: exhausted retries')
}

const DRY_RUN = process.argv.includes('--dry-run')
const RUN_FEDERAL = process.argv.includes('--federal') || !process.argv.slice(2).some(a => a.startsWith('--'))
const RUN_STATE = process.argv.includes('--state') || !process.argv.slice(2).some(a => a.startsWith('--'))
const RUN_BILLS = process.argv.includes('--bills') || !process.argv.slice(2).some(a => a.startsWith('--'))

const WIKI_DIR = path.join(process.cwd(), 'wiki')
const POLITICIANS_DIR = path.join(WIKI_DIR, 'politicians')
const BILLS_DIR = path.join(WIKI_DIR, 'bills')

const OPENSTATES_KEY = process.env.OPENSTATES_API_KEY
const CONGRESS_GOV_KEY = process.env.CONGRESS_GOV_API_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n🗳️  MyReps.info ingestion pipeline${DRY_RUN ? ' (DRY RUN)' : ''}\n`)
  checkEnvVars()

  if (RUN_FEDERAL) await ingestFederalMembers()
  if (RUN_STATE) await ingestStateMembers()
  if (RUN_BILLS) await ingestBills()

  console.log('\n✅ Ingestion complete.\n')
}

function checkEnvVars() {
  const missing: string[] = []
  if (!OPENSTATES_KEY) missing.push('OPENSTATES_API_KEY')
  if (!CONGRESS_GOV_KEY) missing.push('CONGRESS_GOV_API_KEY')
  if (!ANTHROPIC_KEY) missing.push('ANTHROPIC_API_KEY')

  if (missing.length) {
    console.warn(`⚠️  Missing env vars: ${missing.join(', ')}`)
    console.warn('   Some steps will be skipped. Copy .env.example → .env and add your keys.\n')
  }
}

// ---------------------------------------------------------------------------
// Federal members (Congress.gov API)
// ---------------------------------------------------------------------------

async function ingestFederalMembers() {
  if (!CONGRESS_GOV_KEY) {
    console.log('⏭️  Skipping federal members (no CONGRESS_GOV_API_KEY)')
    return
  }
  console.log('📥 Fetching federal members from Congress.gov...')

  const CURRENT_CONGRESS = 119
  const chambers = ['senate', 'house']

  for (const chamber of chambers) {
    let offset = 0
    const limit = 250

    while (true) {
      const url = `https://api.congress.gov/v3/member?congress=${CURRENT_CONGRESS}&chamber=${chamber}&limit=${limit}&offset=${offset}&api_key=${CONGRESS_GOV_KEY}`
      const res = await fetchWithRetry(url)
      if (!res.ok) {
        console.error(`  ❌ Failed to fetch ${chamber}: ${res.status}`)
        break
      }

      const json = await res.json() as {
        members?: Array<{
          bioguideId: string
          name: string
          partyName: string
          state: string
          district?: number
          depiction?: { imageUrl?: string }
          terms?: { item?: Array<{ chamber: string; startYear: number; endYear?: number }> }
        }>
        pagination?: { total: number }
      }

      const members = json.members ?? []
      console.log(`  ${chamber}: fetched ${offset + members.length} / ${json.pagination?.total ?? '?'}`)

      for (const member of members) {
        const nameParts = member.name.split(', ')
        const name = nameParts.length === 2
          ? `${nameParts[1]} ${nameParts[0]}`
          : member.name
        const slug = toSlug(name)
        const filePath = path.join(POLITICIANS_DIR, `${slug}.md`)

        const detail = await fetchCongressMemberDetail(member.bioguideId)
        const votes = await fetchCongressMemberVotes(member.bioguideId)
        const termStart = member.terms?.item?.find(t =>
          t.chamber.toLowerCase() === chamber
        )?.startYear

        const frontmatter = buildPoliticianFrontmatter({
          name,
          slug,
          party: member.partyName,
          state: member.state,
          level: 'federal',
          chamber: chamber === 'senate' ? 'Senate' : 'House',
          office: chamber === 'senate'
            ? 'U.S. Senator'
            : `U.S. Representative, ${member.state}-${member.district ?? 'At Large'}`,
          district: member.district?.toString() ?? null,
          in_office: true,
          photo_url: member.depiction?.imageUrl,
          contact: {
            website: detail?.officialWebsiteUrl,
            phone: detail?.phoneNumber,
          },
          term_start: termStart ? `${termStart}-01-03` : undefined,
          votes,
          last_updated: new Date().toISOString().split('T')[0],
        })

        const bio = detail?.biography ?? ''
        const content = `${frontmatter}\n${bio}`

        if (!DRY_RUN) {
          fs.writeFileSync(filePath, content, 'utf8')
        } else {
          console.log(`  [dry] Would write ${filePath}`)
        }

        await sleep(250)
      }

      if (members.length < limit) break
      offset += limit
    }
  }
}

async function fetchCongressMemberDetail(bioguideId: string) {
  if (!CONGRESS_GOV_KEY) return null
  try {
    const res = await fetchWithRetry(
      `https://api.congress.gov/v3/member/${bioguideId}?api_key=${CONGRESS_GOV_KEY}`
    )
    const json = await res.json() as {
      member?: {
        biography?: string
        officialWebsiteUrl?: string
        phoneNumber?: string
        birthYear?: string
        directOrderName?: string
      }
    }
    return json.member ?? null
  } catch {
    return null
  }
}

async function fetchCongressMemberVotes(bioguideId: string) {
  if (!CONGRESS_GOV_KEY) return []
  try {
    const res = await fetchWithRetry(
      `https://api.congress.gov/v3/member/${bioguideId}/votes?limit=50&api_key=${CONGRESS_GOV_KEY}`
    )
    const json = await res.json() as {
      votes?: Array<{
        bill?: { number?: string; type?: string; title?: string }
        congress?: number
        date?: string
        votePosition?: string
        description?: string
      }>
    }
    const raw = json.votes ?? []

    return raw.map((v) => {
      const billId = v.bill?.number
        ? `${v.bill.type?.toLowerCase() ?? 'bill'}-${v.bill.number}-${v.congress ?? 119}th`
        : 'unknown'
      return {
        bill_slug: toSlug(billId),
        bill_title: v.bill?.title ?? 'Unknown Bill',
        date: v.date ?? '',
        vote: normalizeVote(v.votePosition ?? ''),
        summary: v.description ?? '',
        congress: v.congress,
      }
    })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// State members (OpenStates REST API)
// ---------------------------------------------------------------------------

async function ingestStateMembers() {
  if (!OPENSTATES_KEY) {
    console.log('⏭️  Skipping state members (no OPENSTATES_API_KEY)')
    return
  }
  console.log('📥 Fetching state members from OpenStates REST API...')

  const STATES = [
    'al','ak','az','ar','ca','co','ct','de','fl','ga',
    'hi','id','il','in','ia','ks','ky','la','me','md',
    'ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
    'nm','ny','nc','nd','oh','ok','or','pa','ri','sc',
    'sd','tn','tx','ut','vt','va','wa','wv','wi','wy',
  ]

  for (const state of STATES) {
    let page = 1
    let maxPage = 1

    while (page <= maxPage) {
      const url = `https://v3.openstates.org/people?jurisdiction=${state}&per_page=50&page=${page}`

      try {
        const res = await fetchWithRetry(url, {
          headers: { 'X-API-KEY': OPENSTATES_KEY },
        })

        if (res.status === 429) {
          console.warn(`  ⚠️  Rate limited on ${state.toUpperCase()}, waiting 10s...`)
          await sleep(10_000)
          continue
        }

        if (!res.ok) {
          console.error(`  ❌ OpenStates ${state.toUpperCase()} page ${page}: HTTP ${res.status}`)
          break
        }

        const json = await res.json() as {
          results?: Array<{
            id: string
            name: string
            party: string
            image?: string
            email?: string
            birth_date?: string
            openstates_url?: string
            current_role?: {
              title?: string
              org_classification?: string
              district?: string
            }
          }>
          pagination?: { count: number; per_page: number; page: number; max_page: number; total_items: number }
        }

        const members = json.results ?? []
        maxPage = json.pagination?.max_page ?? 1

        if (page === 1) {
          console.log(`  ${state.toUpperCase()}: ${json.pagination?.total_items ?? '?'} state legislators`)
        }

        for (const member of members) {
          // Only write people who currently hold a state legislative seat
          if (!member.current_role) continue

          const slug = toSlug(member.name)
          const filePath = path.join(POLITICIANS_DIR, `${slug}.md`)

          if (fs.existsSync(filePath)) continue

          const role = member.current_role
          const isUpper = role.org_classification === 'upper'
          const chamberName = isUpper ? 'Senate' : 'House'
          const office = `${state.toUpperCase()} State ${chamberName}${role.district ? ', District ' + role.district : ''}`

          const frontmatter = buildPoliticianFrontmatter({
            name: member.name,
            slug,
            party: expandParty(member.party),
            state: state.toUpperCase(),
            level: 'state',
            chamber: chamberName,
            office,
            in_office: true,
            birthdate: member.birth_date || undefined,
            photo_url: member.image || undefined,
            contact: { website: member.openstates_url },
            last_updated: new Date().toISOString().split('T')[0],
          })

          if (!DRY_RUN) {
            fs.writeFileSync(filePath, frontmatter, 'utf8')
          } else {
            console.log(`  [dry] Would write ${filePath}`)
          }
        }

        page++
        await sleep(1_000)
      } catch (err) {
        console.error(`  ❌ OpenStates error for ${state.toUpperCase()} (page ${page}):`, err)
        break
      }
    }

    // Pause between states to stay well under rate limit
    await sleep(2_000)
  }
}

// ---------------------------------------------------------------------------
// Bills (Congress.gov API + Claude for missing summaries)
// ---------------------------------------------------------------------------

async function ingestBills() {
  if (!CONGRESS_GOV_KEY) {
    console.log('⏭️  Skipping bills (no CONGRESS_GOV_API_KEY)')
    return
  }
  console.log('📥 Fetching recent bills from Congress.gov...')

  const CURRENT_CONGRESS = 119
  const url = `https://api.congress.gov/v3/bill/${CURRENT_CONGRESS}?limit=250&sort=updateDate+desc&api_key=${CONGRESS_GOV_KEY}`

  try {
    const res = await fetchWithRetry(url)
    const json = await res.json() as {
      bills?: Array<{
        number?: string
        type?: string
        title?: string
        introducedDate?: string
        latestAction?: { actionDate?: string; text?: string }
        sponsors?: Array<{ bioguideId?: string; fullName?: string }>
      }>
    }

    const bills = json.bills ?? []
    console.log(`  Found ${bills.length} bills`)

    for (const bill of bills) {
      const id = `${bill.type}.${bill.number}`
      const slug = toSlug(`${bill.type ?? 'bill'}-${bill.number ?? ''}-${CURRENT_CONGRESS}th`)
      const filePath = path.join(BILLS_DIR, `${slug}.md`)

      if (fs.existsSync(filePath)) {
        console.log(`  ⏭️  ${id} already exists, skipping`)
        continue
      }

      // Fetch full bill detail including CRS summary
      const detail = await fetchBillDetail(CURRENT_CONGRESS, bill.type ?? '', bill.number ?? '')
      const crsSummary = detail?.summaries?.[0]?.text ?? null
      const summary = crsSummary ?? (ANTHROPIC_KEY
        ? await generateSummaryWithClaude(bill.title ?? '', detail?.text ?? '')
        : null)

      const status = mapBillStatus(bill.latestAction?.text ?? '')

      const frontmatter = buildBillFrontmatter({
        id,
        slug,
        title: bill.title ?? 'Unknown Bill',
        congress: CURRENT_CONGRESS,
        chamber: bill.type?.startsWith('H') ? 'House' : 'Senate',
        status,
        date_introduced: bill.introducedDate,
        sponsor_name: bill.sponsors?.[0]?.fullName,
        summary: summary ?? undefined,
        summary_source: crsSummary ? 'crs' : (ANTHROPIC_KEY ? 'claude' : undefined),
        last_updated: new Date().toISOString().split('T')[0],
      })

      if (!DRY_RUN) {
        fs.writeFileSync(filePath, frontmatter, 'utf8')
        console.log(`  ✍️  Wrote ${filePath}`)
      } else {
        console.log(`  [dry] Would write ${filePath}`)
      }

      await sleep(300)
    }
  } catch (err) {
    console.error('  ❌ Congress.gov error:', err)
  }
}

async function fetchBillDetail(congress: number, type: string, number: string) {
  if (!CONGRESS_GOV_KEY) return null
  try {
    const url = `https://api.congress.gov/v3/bill/${congress}/${type.toLowerCase()}/${number}?api_key=${CONGRESS_GOV_KEY}`
    const res = await fetchWithRetry(url)
    const json = await res.json() as {
      bill?: {
        summaries?: Array<{ text?: string; actionDate?: string }>
        textVersions?: Array<{ formats?: Array<{ url?: string; type?: string }> }>
      }
    }
    return {
      summaries: json.bill?.summaries,
      text: json.bill?.textVersions?.[0]?.formats?.find((f) => f.type === 'Formatted Text')?.url,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Claude summary generation
// ---------------------------------------------------------------------------

async function generateSummaryWithClaude(title: string, textUrl: string): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null

  try {
    const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [
          {
            role: 'user',
            content: `You are a nonpartisan legislative assistant. Write a clear, factual, plain-English summary of the following bill. Do not include political opinions or partisan framing. Cover: what the bill proposes, who it affects, and the key provisions. Keep it to 2–3 paragraphs.

Bill title: ${title}
${textUrl ? `Full text URL: ${textUrl}` : '(Full text not available — summarize based on the title.)'}`,
          },
        ],
      }),
    })

    const json = await res.json() as { content?: Array<{ text?: string }> }
    return json.content?.[0]?.text ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPoliticianFrontmatter(data: {
  name: string
  slug: string
  party: string
  birthdate?: string
  state?: string
  level: string
  chamber?: string
  office: string
  district?: string | null
  in_office: boolean
  photo_url?: string
  term_start?: string
  contact?: { phone?: string; website?: string; twitter?: string }
  votes?: Array<{ bill_slug: string; bill_title: string; date: string; vote: string; summary: string; congress?: number }>
  last_updated?: string
}): string {
  const contactLines = data.contact
    ? `contact:\n${data.contact.phone ? `  phone: "${data.contact.phone}"\n` : ''}${data.contact.website ? `  website: "${data.contact.website}"\n` : ''}${data.contact.twitter ? `  twitter: "${data.contact.twitter}"\n` : ''}`
    : ''

  const votesLines = data.votes?.length
    ? `votes:\n${data.votes.map((v) =>
        `  - bill_slug: ${v.bill_slug}\n    bill_title: "${v.bill_title}"\n    date: "${v.date}"\n    vote: "${v.vote}"\n    summary: "${v.summary.replace(/"/g, '\\"')}"`
      ).join('\n')}\n`
    : ''

  return `---\nname: ${data.name}\nslug: ${data.slug}\nparty: ${data.party}\n${data.birthdate ? `birthdate: "${data.birthdate}"\n` : ''}${data.state ? `state: ${data.state}\n` : ''}level: ${data.level}\n${data.chamber ? `chamber: ${data.chamber}\n` : ''}office: ${data.office}\n${data.district != null ? `district: ${data.district}\n` : ''}in_office: ${data.in_office}\n${data.photo_url ? `photo_url: "${data.photo_url}"\n` : ''}${data.term_start ? `term_start: "${data.term_start}"\n` : ''}${contactLines}${votesLines}last_updated: "${data.last_updated ?? new Date().toISOString().split('T')[0]}"\n---\n`
}

function buildBillFrontmatter(data: {
  id: string
  slug: string
  title: string
  congress?: number
  chamber?: string
  status: string
  date_introduced?: string
  sponsor_name?: string
  summary?: string
  summary_source?: string
  last_updated?: string
}): string {
  return `---\nid: ${data.id}\nslug: ${data.slug}\ntitle: "${data.title.replace(/"/g, '\\"')}"\n${data.congress ? `congress: ${data.congress}\n` : ''}${data.chamber ? `chamber: ${data.chamber}\n` : ''}status: ${data.status}\n${data.date_introduced ? `date_introduced: "${data.date_introduced}"\n` : ''}${data.sponsor_name ? `sponsor_name: "${data.sponsor_name.replace(/"/g, '\\"')}"\n` : ''}${data.summary ? `summary: "${data.summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"\n` : ''}${data.summary_source ? `summary_source: ${data.summary_source}\n` : ''}last_updated: "${data.last_updated ?? new Date().toISOString().split('T')[0]}"\n---\n`
}

function toSlug(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function expandParty(code: string): string {
  const MAP: Record<string, string> = {
    D: 'Democrat', R: 'Republican', I: 'Independent',
    ID: 'Independent', L: 'Libertarian', G: 'Green',
  }
  return MAP[code.toUpperCase()] ?? code
}

function normalizeVote(position: string): string {
  const p = position.toLowerCase()
  if (p === 'yes' || p === 'yea') return 'Yea'
  if (p === 'no' || p === 'nay') return 'Nay'
  if (p === 'abstain') return 'Abstain'
  if (p === 'not voting') return 'Not Voting'
  return 'Absent'
}

function mapBillStatus(latestAction: string): string {
  const a = latestAction.toLowerCase()
  if (a.includes('became public law') || a.includes('signed by president')) return 'signed'
  if (a.includes('passed senate')) return 'passed-senate'
  if (a.includes('passed house')) return 'passed-house'
  if (a.includes('reported by committee') || a.includes('ordered reported')) return 'passed-committee'
  if (a.includes('vetoed')) return 'vetoed'
  if (a.includes('failed')) return 'failed'
  return 'introduced'
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
