import { NextRequest, NextResponse } from 'next/server'
import type { Representative, RepresentativesByLevel } from '@/lib/types'

const CONGRESS_GOV_KEY = process.env.CONGRESS_GOV_API_KEY
const OPENSTATES_KEY = process.env.OPENSTATES_API_KEY

const FIPS_TO_STATE: Record<string, string> = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT',
  '10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL',
  '18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD',
  '25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE',
  '32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND',
  '39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD',
  '47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV',
  '55':'WI','56':'WY',
}

const STATE_NAMES: Record<string, string> = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
  CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',
  FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',
  IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
  MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',
  MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
  OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
}

export async function GET(request: NextRequest) {
  const zip = request.nextUrl.searchParams.get('zip')
  if (!zip || !/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: 'Invalid ZIP code' }, { status: 400 })
  }

  try {
    // Step 1: ZIP → lat/lon (Nominatim, free, no key)
    const location = await geocodeZip(zip)
    if (!location) {
      return NextResponse.json(
        { error: `Could not locate ZIP code ${zip}. Please try again.` },
        { status: 404 }
      )
    }

    // Step 2: lat/lon → state + congressional district (Census Bureau, free)
    const districts = await getCensusDistricts(location.lat, location.lon)

    // Step 3 & 4: fetch federal + state reps in parallel
    const [federal, state] = await Promise.all([
      getFederalReps(districts?.stateAbbr ?? location.stateAbbr, districts?.district),
      getStateReps(location.lat, location.lon),
    ])

    return NextResponse.json({ federal, state, local: [] } as RepresentativesByLevel)
  } catch (err) {
    console.error('Representatives API error:', err)
    return NextResponse.json(
      { error: 'Failed to look up representatives. Please try again.' },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// Step 1: ZIP → lat/lon via Nominatim (OpenStreetMap)
// ---------------------------------------------------------------------------

async function geocodeZip(zip: string): Promise<{ lat: number; lon: number; stateAbbr: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json&limit=1&addressdetails=1`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MyReps.info/1.0 (contact@myreps.info)' },
    })
    const data = await res.json() as Array<{
      lat: string
      lon: string
      address?: { state?: string; state_code?: string }
    }>
    if (!data.length) return null

    const item = data[0]
    const stateAbbr = item.address?.state_code ?? ''
    return { lat: parseFloat(item.lat), lon: parseFloat(item.lon), stateAbbr }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Step 2: lat/lon → state FIPS + congressional district (Census Geocoder)
// ---------------------------------------------------------------------------

async function getCensusDistricts(
  lat: number,
  lon: number
): Promise<{ stateAbbr: string; stateName: string; district: string } | null> {
  try {
    const url = `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&layers=54&format=json`
    const res = await fetch(url)
    const data = await res.json() as {
      result?: {
        geographies?: {
          'Congressional Districts'?: Array<{ GEOID?: string; STATE?: string; CD119FP?: string; NAMELSAD?: string }>
        }
      }
    }

    const districts = data.result?.geographies?.['Congressional Districts']
    if (!districts?.length) return null

    const district = districts[0]
    const stateFips = district.STATE ?? ''
    const stateAbbr = FIPS_TO_STATE[stateFips] ?? ''
    const districtNum = district.CD119FP ?? '00'

    return {
      stateAbbr,
      stateName: STATE_NAMES[stateAbbr] ?? stateAbbr,
      district: districtNum === '00' ? '0' : String(parseInt(districtNum, 10)),
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Step 3: Federal reps from Congress.gov
// ---------------------------------------------------------------------------

async function getFederalReps(stateAbbr: string, district?: string): Promise<Representative[]> {
  if (!CONGRESS_GOV_KEY || !stateAbbr) return []

  try {
    const base = `https://api.congress.gov/v3/member?currentMember=true&stateCode=${stateAbbr}&limit=10&api_key=${CONGRESS_GOV_KEY}`

    const res = await fetch(base)
    const data = await res.json() as {
      members?: Array<{
        name: string
        partyName: string
        state: string
        district?: number
        terms?: { item?: Array<{ chamber: string }> }
        depiction?: { imageUrl?: string }
        url?: string
        bioguideId?: string
      }>
    }

    const members = data.members ?? []
    const reps: Representative[] = []

    for (const m of members) {
      const chamber = m.terms?.item?.[0]?.chamber ?? ''
      const isSenator = chamber.toLowerCase().includes('senate')
      const isHouse = chamber.toLowerCase().includes('house')

      // Include both senators + the rep for this district
      if (isSenator || (isHouse && (district === undefined || String(m.district ?? 0) === district))) {
        const nameParts = m.name.split(', ')
        const name = nameParts.length === 2 ? `${nameParts[1]} ${nameParts[0]}` : m.name
        const slug = toSlug(name)

        reps.push({
          name,
          slug,
          party: m.partyName as Representative['party'],
          office: isSenator
            ? `U.S. Senator`
            : `U.S. Representative, ${stateAbbr}-${m.district ?? 'At Large'}`,
          level: 'federal',
          state: STATE_NAMES[stateAbbr] ?? stateAbbr,
          photo_url: m.depiction?.imageUrl,
          website: m.url,
        })
      }
    }

    return reps
  } catch (err) {
    console.error('Congress.gov error:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Step 4: State reps from OpenStates geo lookup
// ---------------------------------------------------------------------------

async function getStateReps(lat: number, lon: number): Promise<Representative[]> {
  if (!OPENSTATES_KEY) return []

  const query = `
    query {
      people(
        location: { lat: ${lat}, lng: ${lon} }
        memberOf: { current: true }
        first: 10
      ) {
        edges {
          node {
            name
            party
            currentMemberships {
              organization { name classification }
              post { label }
            }
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

    const data = await res.json() as {
      data?: {
        people?: {
          edges?: Array<{
            node: {
              name: string
              party: string
              currentMemberships: Array<{
                organization: { name: string; classification: string }
                post?: { label: string }
              }>
              contactDetails: Array<{ type: string; value: string }>
            }
          }>
        }
      }
    }

    const edges = data.data?.people?.edges ?? []

    return edges
      .filter(({ node }) =>
        // exclude federal members (OpenStates sometimes includes them)
        !node.currentMemberships.some((m) =>
          m.organization.name.includes('U.S. Senate') ||
          m.organization.name.includes('U.S. House')
        )
      )
      .map(({ node }) => {
        const membership = node.currentMemberships[0]
        const website = node.contactDetails.find((c) => c.type === 'url')?.value
        return {
          name: node.name,
          slug: toSlug(node.name),
          party: node.party as Representative['party'],
          office: `${membership?.organization?.name ?? 'State Legislature'}${membership?.post?.label ? ', District ' + membership.post.label : ''}`,
          level: 'state' as const,
          website,
        }
      })
  } catch (err) {
    console.error('OpenStates error:', err)
    return []
  }
}

function toSlug(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
