/**
 * LLM Wiki ingestion pipeline
 *
 * Pulls data from political APIs, generates plain-English summaries for
 * any bill lacking one, and writes/updates wiki Markdown files.
 *
 * Usage:
 *   npx tsx scripts/ingest.ts [--federal] [--state] [--bills] [--votes] [--dry-run]
 *
 * Requires these env vars (copy .env.example → .env):
 *   CONGRESS_GOV_API_KEY, OPENSTATES_API_KEY, ANTHROPIC_API_KEY
 */

import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'

// ---------------------------------------------------------------------------
// Resilient fetch helpers
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const res = await fetch(url, { ...options, signal: controller.signal })
      clearTimeout(timer)
      return res
    } catch (err) {
      clearTimeout(timer)
      if (attempt === retries) throw err
      const delay = attempt * 2000
      console.warn(`  ⚠️  Request failed (attempt ${attempt}/${retries}), retrying in ${delay / 1000}s...`)
      await sleep(delay)
    }
  }
  throw new Error('fetchWithRetry: exhausted retries')
}

// Parses JSON body with a hard deadline via Promise.race (avoids Node body-read hangs)
async function fetchJSONWithRetry<T>(
  url: string,
  options: RequestInit = {},
  retries = 3
): Promise<{ status: number; json: T | null }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await Promise.race([
        (async () => {
          const res = await fetch(url, options)
          const json: T | null = res.ok ? await res.json() as T : null
          return { status: res.status, json }
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Request timed out after 60s')), 60_000)
        ),
      ])
      return result
    } catch (err) {
      if (attempt === retries) throw err
      const delay = attempt * 2000
      console.warn(`  ⚠️  Request failed (attempt ${attempt}/${retries}), retrying in ${delay / 1000}s...`)
      await sleep(delay)
    }
  }
  throw new Error('fetchJSONWithRetry: exhausted retries')
}

// Fetches plain text (for XML files) with timeout + null on 404/error
async function fetchTextWithRetry(url: string, retries = 2): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await Promise.race([
        (async () => {
          const res = await fetch(url)
          if (res.status === 404 || res.status === 403) return null
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return await res.text()
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Fetch timed out after 30s')), 30_000)
        ),
      ])
      return result
    } catch {
      if (attempt === retries) return null
      await sleep(1000)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DRY_RUN   = process.argv.includes('--dry-run')
const hasFlags  = process.argv.slice(2).some(a => a.startsWith('--') && a !== '--dry-run')
const RUN_FEDERAL = process.argv.includes('--federal') || !hasFlags
const RUN_STATE   = process.argv.includes('--state')   || !hasFlags
const RUN_BILLS   = process.argv.includes('--bills')   || !hasFlags
const RUN_VOTES   = process.argv.includes('--votes')   || !hasFlags

const WIKI_DIR       = path.join(process.cwd(), 'wiki')
const POLITICIANS_DIR = path.join(WIKI_DIR, 'politicians')
const BILLS_DIR      = path.join(WIKI_DIR, 'bills')

const OPENSTATES_KEY  = process.env.OPENSTATES_API_KEY
const CONGRESS_GOV_KEY = process.env.CONGRESS_GOV_API_KEY
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VoteRecord = {
  bill_slug: string
  bill_title: string
  date: string
  vote: string
  summary: string
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n🗳️  MyReps.info ingestion pipeline${DRY_RUN ? ' (DRY RUN)' : ''}\n`)
  checkEnvVars()

  if (RUN_FEDERAL) {
    try { await ingestFederalMembers() }
    catch (err) { console.error('❌ Federal ingestion crashed:', err) }
  }
  if (RUN_STATE) {
    try { await ingestStateMembers() }
    catch (err) { console.error('❌ State ingestion crashed:', err) }
  }
  if (RUN_BILLS) {
    try { await ingestBills() }
    catch (err) { console.error('❌ Bills ingestion crashed:', err) }
  }
  if (RUN_VOTES) {
    try { await ingestFederalVotes() }
    catch (err) { console.error('❌ Federal votes ingestion crashed:', err) }
    try { await ingestStateVotes() }
    catch (err) { console.error('❌ State votes ingestion crashed:', err) }
  }

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
  // Track which slugs the API returns so we can mark the rest inactive at the end.
  const writtenSlugs = new Set<string>()

  // Process house first, senate second — so senate data wins when Congress.gov
  // returns the same member under both chamber queries (which happens for senators
  // who previously served in the House during the same Congress).
  const chambers = ['house', 'senate']

  for (const chamber of chambers) {
    let offset = 0
    const limit = 250

    while (true) {
      // currentMember=true limits to ~100 senators + ~435 reps (not 2,250+ historical)
      const url = `https://api.congress.gov/v3/member?congress=${CURRENT_CONGRESS}&chamber=${chamber}&currentMember=true&limit=${limit}&offset=${offset}&api_key=${CONGRESS_GOV_KEY}`

      type MemberListResponse = {
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

      let memberPage: MemberListResponse
      try {
        const { status, json } = await fetchJSONWithRetry<MemberListResponse>(url)
        if (status !== 200 || !json) {
          console.error(`  ❌ Failed to fetch ${chamber} at offset ${offset}: HTTP ${status}`)
          break
        }
        memberPage = json
      } catch (err) {
        console.error(`  ❌ Network error fetching ${chamber} at offset ${offset}:`, err)
        break
      }

      const members = memberPage.members ?? []
      console.log(`  ${chamber}: fetched ${offset + members.length} / ${memberPage.pagination?.total ?? '?'}`)

      for (const member of members) {
        const nameParts = member.name.split(', ')
        const name = nameParts.length === 2
          ? `${nameParts[1]} ${nameParts[0]}`
          : member.name
        const slug = toSlug(name)
        const filePath = path.join(POLITICIANS_DIR, `${slug}.md`)

        let detail: Awaited<ReturnType<typeof fetchCongressMemberDetail>> = null
        try { detail = await fetchCongressMemberDetail(member.bioguideId) } catch { /* skip */ }

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
          bioguide_id: member.bioguideId,
          last_updated: new Date().toISOString().split('T')[0],
        })

        const bio = detail?.biography ?? ''
        const content = `${frontmatter}\n${bio}`

        if (!DRY_RUN) {
          fs.writeFileSync(filePath, content, 'utf8')
        } else {
          console.log(`  [dry] Would write ${filePath}`)
        }
        writtenSlugs.add(slug)

        await sleep(250)
      }

      if (members.length < limit) break
      offset += limit
    }
  }

  // Mark any federal politician no longer returned by the API as inactive.
  if (!DRY_RUN && writtenSlugs.size > 0) {
    const allFiles = fs.readdirSync(POLITICIANS_DIR).filter(f => f.endsWith('.md'))
    let markedInactive = 0
    for (const file of allFiles) {
      const fp = path.join(POLITICIANS_DIR, file)
      const raw = fs.readFileSync(fp, 'utf8')
      if (!raw.includes('level: federal')) continue
      if (!raw.includes('in_office: true')) continue
      const slug = file.replace(/\.md$/, '')
      if (!writtenSlugs.has(slug)) {
        fs.writeFileSync(fp, raw.replace(/^in_office: true$/m, 'in_office: false'), 'utf8')
        markedInactive++
      }
    }
    if (markedInactive > 0) {
      console.log(`  ✅ Marked ${markedInactive} former federal politicians as in_office: false`)
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
    const stateWrittenSlugs = new Set<string>()

    while (page <= maxPage) {
      const url = `https://v3.openstates.org/people?jurisdiction=${state}&per_page=50&page=${page}`

      try {
        type StateResponse = {
          results?: Array<{
            id: string
            name: string
            party: string
            image?: string
            birth_date?: string
            openstates_url?: string
            current_role?: { title?: string; org_classification?: string; district?: string }
          }>
          pagination?: { count: number; per_page: number; page: number; max_page: number; total_items: number }
        }

        const { status, json } = await fetchJSONWithRetry<StateResponse>(url, {
          headers: { 'X-API-KEY': OPENSTATES_KEY },
        })

        if (status === 429) {
          console.warn(`  ⚠️  Rate limited on ${state.toUpperCase()}, waiting 10s...`)
          await sleep(10_000)
          continue
        }
        if (status !== 200 || !json) {
          console.error(`  ❌ OpenStates ${state.toUpperCase()} page ${page}: HTTP ${status}`)
          break
        }

        const members = json.results ?? []
        maxPage = json.pagination?.max_page ?? 1

        if (page === 1) {
          console.log(`  ${state.toUpperCase()}: ${json.pagination?.total_items ?? '?'} state legislators`)
        }

        for (const member of members) {
          if (!member.current_role) continue

          const slug = toSlug(member.name)
          const filePath = path.join(POLITICIANS_DIR, `${slug}.md`)

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
            openstates_id: member.id,
            last_updated: new Date().toISOString().split('T')[0],
          })

          if (!DRY_RUN) {
            fs.writeFileSync(filePath, frontmatter, 'utf8')
          } else {
            console.log(`  [dry] Would write ${filePath}`)
          }
          stateWrittenSlugs.add(slug)
        }

        page++
        await sleep(1_000)
      } catch (err) {
        console.error(`  ❌ OpenStates error for ${state.toUpperCase()} (page ${page}):`, err)
        break
      }
    }

    // Mark state politicians for this state who weren't in the API response as inactive.
    if (!DRY_RUN && stateWrittenSlugs.size > 0) {
      const stateUpper = state.toUpperCase()
      const allFiles = fs.readdirSync(POLITICIANS_DIR).filter(f => f.endsWith('.md'))
      let markedInactive = 0
      for (const file of allFiles) {
        const fp = path.join(POLITICIANS_DIR, file)
        const raw = fs.readFileSync(fp, 'utf8')
        if (!raw.includes('level: state')) continue
        if (!raw.includes(`state: ${stateUpper}`)) continue
        if (!raw.includes('in_office: true')) continue
        const slug = file.replace(/\.md$/, '')
        if (!stateWrittenSlugs.has(slug)) {
          fs.writeFileSync(fp, raw.replace(/^in_office: true$/m, 'in_office: false'), 'utf8')
          markedInactive++
        }
      }
      if (markedInactive > 0) {
        console.log(`  ✅ ${stateUpper}: marked ${markedInactive} former state legislators as in_office: false`)
      }
    }

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
// Federal votes (House Clerk XML + Senate XML)
// ---------------------------------------------------------------------------

async function ingestFederalVotes() {
  console.log('📥 Ingesting federal votes from House Clerk and Senate XMLs...')

  // Build lookup maps from existing politician files
  const bioguideMap = new Map<string, string>() // bioguideId → filePath
  const senatorMap  = new Map<string, string>() // "lastName|STATE" → filePath

  for (const file of fs.readdirSync(POLITICIANS_DIR).filter(f => f.endsWith('.md'))) {
    const filePath = path.join(POLITICIANS_DIR, file)
    const content  = fs.readFileSync(filePath, 'utf8')

    const bioguide = content.match(/^bioguide_id:\s*(\S+)/m)?.[1]?.trim()
    if (bioguide) bioguideMap.set(bioguide, filePath)

    const chamber = content.match(/^chamber:\s*(\S+)/m)?.[1]
    const level   = content.match(/^level:\s*(\S+)/m)?.[1]
    const state   = content.match(/^state:\s*(\S+)/m)?.[1]
    const name    = content.match(/^name:\s*(.+)/m)?.[1]?.trim()
    if (chamber === 'Senate' && level === 'federal' && state && name) {
      const lastName = name.split(' ').pop() ?? ''
      senatorMap.set(`${lastName.toLowerCase()}|${state.toUpperCase()}`, filePath)
    }
  }

  console.log(`  Indexed ${bioguideMap.size} members by bioguide, ${senatorMap.size} senators by name`)

  // Accumulate votes in memory: filePath → VoteRecord[]
  const memberVotes = new Map<string, VoteRecord[]>()
  const addVote = (filePath: string, vote: VoteRecord) => {
    if (!memberVotes.has(filePath)) memberVotes.set(filePath, [])
    memberVotes.get(filePath)!.push(vote)
  }

  // ---- House Clerk XML: https://clerk.house.gov/evs/{year}/roll{NNN}.xml ----
  for (const year of [2025, 2026]) {
    console.log(`  Fetching House ${year} roll calls...`)
    let misses = 0
    for (let roll = 1; roll <= 600; roll++) {
      const rollStr = String(roll).padStart(3, '0')
      const xml = await fetchTextWithRetry(`https://clerk.house.gov/evs/${year}/roll${rollStr}.xml`)

      if (!xml) { if (++misses >= 5) break; continue }
      misses = 0

      const legislNum = extractXMLTag(xml, 'legis-num')
      // Skip if no bill number (quorum calls, journal votes, etc.)
      if (!legislNum || !legislNum.match(/\d/)) continue

      const billSlug  = legislNumToSlug(legislNum)
      const date      = parseHouseDate(extractXMLTag(xml, 'action-date'))
      const question  = extractXMLTag(xml, 'vote-question')
      const title     = `${legislNum} — ${question}`

      for (const [, block] of xml.matchAll(/<recorded-vote>([\s\S]*?)<\/recorded-vote>/g)) {
        const bioguide = block.match(/name-id="([A-Z0-9]+)"/)?.[1]
        const vote     = block.match(/<vote>([^<]+)<\/vote>/)?.[1]?.trim()
        if (!bioguide || !vote) continue

        const filePath = bioguideMap.get(bioguide)
        if (filePath) addVote(filePath, { bill_slug: billSlug, bill_title: title, date, vote: normalizeVote(vote), summary: question })
      }

      await sleep(80)
    }
  }

  // ---- Senate XML: https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_{NNNNN}.xml ----
  // Continuous numbering for all of 119th Congress session 1 (2025–2026)
  console.log('  Fetching Senate 119th Congress roll calls...')
  let senateMisses = 0
  for (let roll = 1; roll <= 600; roll++) {
    const rollStr = String(roll).padStart(5, '0')
    const xml = await fetchTextWithRetry(
      `https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_${rollStr}.xml`
    )

    if (!xml) { if (++senateMisses >= 5) break; continue }
    senateMisses = 0

    const docType = extractXMLTag(xml, 'document_type')
    const docNum  = extractXMLTag(xml, 'document_number')
    const date    = parseSenateDate(extractXMLTag(xml, 'vote_date'))
    const title   = extractXMLTag(xml, 'vote_document_text') || extractXMLTag(xml, 'vote_question_text')
    const question = extractXMLTag(xml, 'vote_question_text')

    const billSlug = (docType && docNum && docType !== 'PN')
      ? toSlug(`${docType} ${docNum} 119th`)
      : toSlug(`senate-vote-119-${roll}`)

    for (const [, block] of xml.matchAll(/<member>([\s\S]*?)<\/member>/g)) {
      const lastName = extractXMLTag(block, 'last_name')
      const state    = extractXMLTag(block, 'state')
      const vote     = extractXMLTag(block, 'vote_cast')
      if (!lastName || !state || !vote) continue

      const filePath = senatorMap.get(`${lastName.toLowerCase()}|${state.toUpperCase()}`)
      if (filePath) addVote(filePath, { bill_slug: billSlug, bill_title: title, date, vote: normalizeVote(vote), summary: question })
    }

    await sleep(80)
  }

  // Write all accumulated votes to files
  console.log(`  Writing votes for ${memberVotes.size} federal members...`)
  let written = 0
  for (const [filePath, votes] of memberVotes) {
    updateVotesInFile(filePath, votes)
    if (++written % 50 === 0) console.log(`  Progress: ${written}/${memberVotes.size}`)
  }
  console.log(`  ✅ Federal votes written for ${written} members`)
}

// ---------------------------------------------------------------------------
// State votes (OpenStates bills with embedded votes)
// ---------------------------------------------------------------------------

async function ingestStateVotes() {
  if (!OPENSTATES_KEY) {
    console.log('⏭️  Skipping state votes (no OPENSTATES_API_KEY)')
    return
  }
  console.log('📥 Ingesting state votes from OpenStates...')

  // Index state politicians: slug → {filePath, state}
  const stateMemberMap = new Map<string, { filePath: string; state: string }>()
  for (const file of fs.readdirSync(POLITICIANS_DIR).filter(f => f.endsWith('.md'))) {
    const filePath = path.join(POLITICIANS_DIR, file)
    const content  = fs.readFileSync(filePath, 'utf8')
    if (!content.includes('\nlevel: state')) continue
    const state = content.match(/^state:\s*(\S+)/m)?.[1] ?? ''
    stateMemberMap.set(file.replace('.md', ''), { filePath, state })
  }
  console.log(`  Indexed ${stateMemberMap.size} state politicians`)

  const STATES = [
    'al','ak','az','ar','ca','co','ct','de','fl','ga',
    'hi','id','il','in','ia','ks','ky','la','me','md',
    'ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
    'nm','ny','nc','nd','oh','ok','or','pa','ri','sc',
    'sd','tn','tx','ut','vt','va','wa','wv','wi','wy',
  ]

  type OpenStatesBillsResponse = {
    results?: Array<{
      identifier: string
      title: string
      legislative_session?: string
      votes?: Array<{
        start_date?: string
        votes?: Array<{ voter_name?: string; option?: string }>
      }>
    }>
    pagination?: { max_page: number }
  }

  for (const state of STATES) {
    await sleep(2_000)
    const stateVoteBuffer = new Map<string, VoteRecord[]>()
    let page = 1
    let billsProcessed = 0

    while (billsProcessed < 60) {
      const url = `https://v3.openstates.org/bills?jurisdiction=${state}&per_page=20&page=${page}&include=votes&sort=updated_desc`

      try {
        const { status, json } = await fetchJSONWithRetry<OpenStatesBillsResponse>(url, {
          headers: { 'X-API-KEY': OPENSTATES_KEY },
        })

        if (status === 429) { await sleep(10_000); continue }
        if (status !== 200 || !json) break

        const bills = json.results ?? []
        if (bills.length === 0) break

        for (const bill of bills) {
          billsProcessed++
          const billSlug = toSlug(`${state}-${bill.identifier}-${bill.legislative_session ?? ''}`)

          for (const voteEvent of bill.votes ?? []) {
            const date = voteEvent.start_date?.split('T')[0] ?? new Date().toISOString().split('T')[0]

            for (const v of voteEvent.votes ?? []) {
              if (!v.voter_name) continue
              const voterSlug = toSlug(v.voter_name)
              const member = stateMemberMap.get(voterSlug)
              if (!member || member.state.toUpperCase() !== state.toUpperCase()) continue

              if (!stateVoteBuffer.has(member.filePath)) stateVoteBuffer.set(member.filePath, [])
              stateVoteBuffer.get(member.filePath)!.push({
                bill_slug: billSlug,
                bill_title: bill.title,
                date,
                vote: normalizeVote(v.option ?? ''),
                summary: '',
              })
            }
          }
        }

        if (bills.length < 20 || page >= (json.pagination?.max_page ?? 1)) break
        page++
        await sleep(1_000)
      } catch (err) {
        console.error(`  ❌ OpenStates votes error for ${state.toUpperCase()}:`, err)
        break
      }
    }

    for (const [filePath, votes] of stateVoteBuffer) {
      updateVotesInFile(filePath, votes)
    }
    if (stateVoteBuffer.size > 0) {
      console.log(`  ${state.toUpperCase()}: updated ${stateVoteBuffer.size} members with votes`)
    }
  }
  console.log('  ✅ State votes ingestion complete')
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
        messages: [{
          role: 'user',
          content: `You are a nonpartisan legislative assistant. Write a clear, factual, plain-English summary of the following bill. Do not include political opinions or partisan framing. Cover: what the bill proposes, who it affects, and the key provisions. Keep it to 2–3 paragraphs.

Bill title: ${title}
${textUrl ? `Full text URL: ${textUrl}` : '(Full text not available — summarize based on the title.)'}`,
        }],
      }),
    })

    const json = await res.json() as { content?: Array<{ text?: string }> }
    return json.content?.[0]?.text ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// XML helpers (regex-based, no external parser needed)
// ---------------------------------------------------------------------------

function extractXMLTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
  return match?.[1]?.trim() ?? ''
}

function legislNumToSlug(legislNum: string, congress = 119): string {
  // "H.R. 1" → "hr-1-119th", "H.J.Res. 7" → "hjres-7-119th"
  return toSlug(legislNum.replace(/\./g, '').trim() + ` ${congress}th`)
}

function parseHouseDate(dateStr: string): string {
  // "3-Jan-2025" → "2025-01-03"
  const MONTHS: Record<string, string> = {
    Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
    Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12',
  }
  const parts = dateStr.split('-')
  if (parts.length !== 3) return dateStr
  const [day, mon, year] = parts
  return `${year}-${MONTHS[mon] ?? '01'}-${day.padStart(2, '0')}`
}

function parseSenateDate(dateStr: string): string {
  // "March 14, 2025, 11:33 AM" → "2025-03-14"
  const MONTHS: Record<string, string> = {
    January:'01', February:'02', March:'03', April:'04', May:'05', June:'06',
    July:'07', August:'08', September:'09', October:'10', November:'11', December:'12',
  }
  const match = dateStr.match(/(\w+)\s+(\d+),\s+(\d{4})/)
  if (!match) return new Date().toISOString().split('T')[0]
  const [, mon, day, year] = match
  return `${year}-${MONTHS[mon] ?? '01'}-${day.padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Vote file updater — merges new votes into existing frontmatter
// ---------------------------------------------------------------------------

function updateVotesInFile(filePath: string, newVotes: VoteRecord[]): void {
  try {
    const raw    = fs.readFileSync(filePath, 'utf8')
    const parsed = matter(raw)

    const existing: VoteRecord[] = Array.isArray(parsed.data.votes) ? parsed.data.votes : []
    const existingKeys = new Set(existing.map(v => `${v.bill_slug}|${v.date}`))
    const toAdd = newVotes.filter(v => v.bill_slug && !existingKeys.has(`${v.bill_slug}|${v.date}`))

    if (toAdd.length === 0) return

    parsed.data.votes = [...existing, ...toAdd]
    parsed.data.last_updated = new Date().toISOString().split('T')[0]

    if (!DRY_RUN) {
      fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data), 'utf8')
    }
  } catch (err) {
    console.error(`  ❌ Failed to update ${path.basename(filePath)}:`, err)
  }
}

// ---------------------------------------------------------------------------
// Frontmatter builders
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
  votes?: VoteRecord[]
  bioguide_id?: string
  openstates_id?: string
  last_updated?: string
}): string {
  const contactLines = data.contact
    ? `contact:\n${data.contact.phone   ? `  phone: "${data.contact.phone}"\n`   : ''}${data.contact.website ? `  website: "${data.contact.website}"\n` : ''}${data.contact.twitter ? `  twitter: "${data.contact.twitter}"\n` : ''}`
    : ''

  const votesLines = data.votes?.length
    ? `votes:\n${data.votes.map(v =>
        `  - bill_slug: ${v.bill_slug}\n    bill_title: "${v.bill_title.replace(/"/g, '\\"')}"\n    date: "${v.date}"\n    vote: "${v.vote}"\n    summary: "${v.summary.replace(/"/g, '\\"')}"`
      ).join('\n')}\n`
    : ''

  return [
    '---',
    `name: ${data.name}`,
    `slug: ${data.slug}`,
    `party: ${data.party}`,
    ...(data.birthdate     ? [`birthdate: "${data.birthdate}"`]     : []),
    ...(data.state         ? [`state: ${data.state}`]               : []),
    `level: ${data.level}`,
    ...(data.chamber       ? [`chamber: ${data.chamber}`]           : []),
    `office: ${data.office}`,
    ...(data.district != null ? [`district: ${data.district}`]      : []),
    `in_office: ${data.in_office}`,
    ...(data.photo_url     ? [`photo_url: "${data.photo_url}"`]     : []),
    ...(data.term_start    ? [`term_start: "${data.term_start}"`]   : []),
    ...(data.bioguide_id   ? [`bioguide_id: ${data.bioguide_id}`]   : []),
    ...(data.openstates_id ? [`openstates_id: ${data.openstates_id}`] : []),
    contactLines.trimEnd(),
    votesLines.trimEnd(),
    `last_updated: "${data.last_updated ?? new Date().toISOString().split('T')[0]}"`,
    '---',
    '',
  ].filter(line => line !== '').join('\n') + '\n'
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

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function toSlug(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function expandParty(code: string): string {
  const MAP: Record<string, string> = {
    D: 'Democrat', R: 'Republican', I: 'Independent',
    ID: 'Independent', L: 'Libertarian', G: 'Green',
  }
  return MAP[code.toUpperCase()] ?? code
}

function normalizeVote(position: string): string {
  const p = position.toLowerCase().trim()
  if (p === 'yes' || p === 'yea' || p === 'aye')              return 'Yea'
  if (p === 'no'  || p === 'nay')                              return 'Nay'
  if (p === 'abstain' || p === 'present')                      return 'Present'
  if (p === 'not voting' || p === 'not_voting' || p === 'no vote') return 'Not Voting'
  if (p === 'excused' || p === 'absent')                       return 'Absent'
  return 'Not Voting'
}

function mapBillStatus(latestAction: string): string {
  const a = latestAction.toLowerCase()
  if (a.includes('became public law') || a.includes('signed by president')) return 'signed'
  if (a.includes('passed senate'))   return 'passed-senate'
  if (a.includes('passed house'))    return 'passed-house'
  if (a.includes('reported by committee') || a.includes('ordered reported')) return 'passed-committee'
  if (a.includes('vetoed'))  return 'vetoed'
  if (a.includes('failed'))  return 'failed'
  return 'introduced'
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
