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
 *   PROPUBLICA_API_KEY, OPENSTATES_API_KEY,
 *   CONGRESS_GOV_API_KEY, ANTHROPIC_API_KEY
 */

import fs from 'fs'
import path from 'path'

const DRY_RUN = process.argv.includes('--dry-run')
const RUN_FEDERAL = process.argv.includes('--federal') || !process.argv.slice(2).some(a => a.startsWith('--'))
const RUN_STATE = process.argv.includes('--state') || !process.argv.slice(2).some(a => a.startsWith('--'))
const RUN_BILLS = process.argv.includes('--bills') || !process.argv.slice(2).some(a => a.startsWith('--'))

const WIKI_DIR = path.join(process.cwd(), 'wiki')
const POLITICIANS_DIR = path.join(WIKI_DIR, 'politicians')
const BILLS_DIR = path.join(WIKI_DIR, 'bills')

const PROPUBLICA_KEY = process.env.PROPUBLICA_API_KEY
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
  if (!PROPUBLICA_KEY) missing.push('PROPUBLICA_API_KEY')
  if (!OPENSTATES_KEY) missing.push('OPENSTATES_API_KEY')
  if (!CONGRESS_GOV_KEY) missing.push('CONGRESS_GOV_API_KEY')
  if (!ANTHROPIC_KEY) missing.push('ANTHROPIC_API_KEY')

  if (missing.length) {
    console.warn(`⚠️  Missing env vars: ${missing.join(', ')}`)
    console.warn('   Some steps will be skipped. Copy .env.example → .env and add your keys.\n')
  }
}

// ---------------------------------------------------------------------------
// Federal members (ProPublica Congress API)
// ---------------------------------------------------------------------------

async function ingestFederalMembers() {
  if (!PROPUBLICA_KEY) {
    console.log('⏭️  Skipping federal members (no PROPUBLICA_API_KEY)')
    return
  }
  console.log('📥 Fetching federal members from ProPublica...')

  const chambers = ['senate', 'house']
  const CURRENT_CONGRESS = 119

  for (const chamber of chambers) {
    const url = `https://api.propublica.org/congress/v1/${CURRENT_CONGRESS}/${chamber}/members.json`
    const res = await fetch(url, { headers: { 'X-API-Key': PROPUBLICA_KEY } })
    if (!res.ok) {
      console.error(`  ❌ Failed to fetch ${chamber}: ${res.status}`)
      continue
    }

    const json = await res.json() as {
      results: Array<{
        members: Array<{
          id: string
          first_name: string
          last_name: string
          party: string
          state: string
          district?: string
          date_of_birth?: string
          url?: string
          twitter_account?: string
          phone?: string
          in_office: boolean
          roles?: Array<{ title: string; congress: string; state: string; district?: string; start_date: string; end_date?: string }>
        }>
      }>
    }

    const members = json.results?.[0]?.members ?? []
    console.log(`  Found ${members.length} ${chamber} members`)

    for (const member of members) {
      const slug = toSlug(`${member.first_name}-${member.last_name}`)
      const filePath = path.join(POLITICIANS_DIR, `${slug}.md`)

      // Fetch detailed member data including votes
      const detail = await fetchMemberDetail(member.id)
      const votes = await fetchMemberVotes(member.id)

      const frontmatter = buildPoliticianFrontmatter({
        name: `${member.first_name} ${member.last_name}`,
        slug,
        party: expandParty(member.party),
        birthdate: member.date_of_birth,
        state: member.state,
        level: 'federal',
        chamber: chamber === 'senate' ? 'Senate' : 'House',
        office: chamber === 'senate'
          ? `U.S. Senator`
          : `U.S. Representative, ${member.state}-${member.district}`,
        district: member.district ?? null,
        in_office: member.in_office,
        contact: {
          phone: member.phone,
          website: member.url,
          twitter: member.twitter_account,
        },
        votes,
        last_updated: new Date().toISOString().split('T')[0],
      })

      const bio = detail?.biography ?? ''
      const content = `${frontmatter}\n${bio}`

      if (!DRY_RUN) {
        fs.writeFileSync(filePath, content, 'utf8')
        console.log(`  ✍️  Wrote ${filePath}`)
      } else {
        console.log(`  [dry] Would write ${filePath}`)
      }

      // Rate limit: ProPublica allows ~5000 req/day but be polite
      await sleep(200)
    }
  }
}

async function fetchMemberDetail(memberId: string) {
  if (!PROPUBLICA_KEY) return null
  try {
    const res = await fetch(
      `https://api.propublica.org/congress/v1/members/${memberId}.json`,
      { headers: { 'X-API-Key': PROPUBLICA_KEY } }
    )
    const json = await res.json() as { results?: Array<{ biography?: string }> }
    return json.results?.[0] ?? null
  } catch {
    return null
  }
}

async function fetchMemberVotes(memberId: string) {
  if (!PROPUBLICA_KEY) return []
  try {
    const res = await fetch(
      `https://api.propublica.org/congress/v1/members/${memberId}/votes.json`,
      { headers: { 'X-API-Key': PROPUBLICA_KEY } }
    )
    const json = await res.json() as {
      results?: Array<{
        votes?: Array<{
          bill?: { bill_id?: string; title?: string; number?: string }
          date?: string
          position?: string
          description?: string
        }>
      }>
    }
    const raw = json.results?.[0]?.votes ?? []

    return raw.slice(0, 50).map((v) => ({
      bill_slug: toSlug(v.bill?.bill_id ?? 'unknown'),
      bill_title: v.bill?.title ?? 'Unknown Bill',
      date: v.date ?? '',
      vote: normalizeVote(v.position ?? ''),
      summary: v.description ?? '',
    }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// State members (OpenStates GraphQL API)
// ---------------------------------------------------------------------------

async function ingestStateMembers() {
  if (!OPENSTATES_KEY) {
    console.log('⏭️  Skipping state members (no OPENSTATES_API_KEY)')
    return
  }
  console.log('📥 Fetching state members from OpenStates...')

  const STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
    'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
    'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
    'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
  ]

  for (const state of STATES) {
    const query = `
      query {
        people(memberOf: { state: "${state}", current: true }, first: 200) {
          edges {
            node {
              id name party
              currentMemberships { organization { name } post { label } }
              contactDetails { type value }
            }
          }
        }
      }
    `

    try {
      const res = await fetch('https://v3.openstates.org/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': OPENSTATES_KEY,
        },
        body: JSON.stringify({ query }),
      })

      const json = await res.json() as {
        data?: {
          people?: {
            edges?: Array<{
              node: {
                id: string
                name: string
                party: string
                currentMemberships: Array<{ organization: { name: string }; post?: { label: string } }>
                contactDetails: Array<{ type: string; value: string }>
              }
            }>
          }
        }
      }

      const members = json.data?.people?.edges ?? []
      console.log(`  ${state}: ${members.length} state legislators`)

      for (const { node } of members) {
        const slug = toSlug(node.name)
        const filePath = path.join(POLITICIANS_DIR, `${slug}.md`)

        // Skip if already exists (don't overwrite richer manually-written profiles)
        if (fs.existsSync(filePath)) continue

        const membership = node.currentMemberships?.[0]
        const phone = node.contactDetails?.find((c) => c.type === 'voice')?.value
        const website = node.contactDetails?.find((c) => c.type === 'url')?.value

        const frontmatter = buildPoliticianFrontmatter({
          name: node.name,
          slug,
          party: expandParty(node.party),
          state,
          level: 'state',
          chamber: membership?.organization?.name ?? 'State Legislature',
          office: `${state} ${membership?.organization?.name ?? 'Legislature'}${membership?.post?.label ? ', ' + membership.post.label : ''}`,
          in_office: true,
          contact: { phone, website },
          last_updated: new Date().toISOString().split('T')[0],
        })

        if (!DRY_RUN) {
          fs.writeFileSync(filePath, frontmatter, 'utf8')
        } else {
          console.log(`  [dry] Would write ${filePath}`)
        }
      }

      await sleep(500)
    } catch (err) {
      console.error(`  ❌ OpenStates error for ${state}:`, err)
    }
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
    const res = await fetch(url)
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
    const res = await fetch(url)
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
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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
  contact?: { phone?: string; website?: string; twitter?: string }
  votes?: Array<{ bill_slug: string; bill_title: string; date: string; vote: string; summary: string }>
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

  return `---\nname: ${data.name}\nslug: ${data.slug}\nparty: ${data.party}\n${data.birthdate ? `birthdate: "${data.birthdate}"\n` : ''}${data.state ? `state: ${data.state}\n` : ''}level: ${data.level}\n${data.chamber ? `chamber: ${data.chamber}\n` : ''}office: ${data.office}\n${data.district != null ? `district: ${data.district}\n` : ''}in_office: ${data.in_office}\n${contactLines}${votesLines}last_updated: "${data.last_updated ?? new Date().toISOString().split('T')[0]}"\n---\n`
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
