import { NextRequest, NextResponse } from 'next/server'
import { getAllPoliticians } from '@/lib/wiki'
import type { Representative, RepresentativesByLevel } from '@/lib/types'

export async function GET(request: NextRequest) {
  const zip = request.nextUrl.searchParams.get('zip')
  if (!zip || !/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: 'Invalid ZIP code' }, { status: 400 })
  }

  try {
    // Step 1: ZIP → lat/lon via Nominatim (free, no key, no rate limits)
    const location = await geocodeZip(zip)
    if (!location) {
      return NextResponse.json(
        { error: `Could not locate ZIP code ${zip}. Please check and try again.` },
        { status: 404 }
      )
    }

    // Step 2: lat/lon → state + districts via Census Bureau geocoder
    // (free, no API key, no rate limits)
    const districts = await getDistrictsFromCensus(location.lat, location.lon)
    if (!districts) {
      return NextResponse.json({ federal: [], state: [], local: [] })
    }

    // Step 3: Look up politicians from the local wiki — zero external API calls
    const reps = await lookupRepsFromWiki(districts)
    return NextResponse.json(reps)
  } catch (err) {
    console.error('Representatives API error:', err)
    return NextResponse.json(
      { error: 'Failed to look up representatives. Please try again.' },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// Step 1: ZIP → lat/lon via Nominatim (OpenStreetMap, free, no key)
// ---------------------------------------------------------------------------

async function geocodeZip(zip: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json&limit=1`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MyReps.info/1.0 (contact@myreps.info)' },
    })
    const data = await res.json() as Array<{ lat: string; lon: string }>
    if (!data.length) return null
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Step 2: lat/lon → districts via Census Bureau Geocoder
// No API key needed, no rate limits.
// Returns state abbreviation, congressional district, and state legislative districts.
// ---------------------------------------------------------------------------

type Districts = {
  stateAbbr: string        // e.g. "KS"
  stateName: string        // e.g. "Kansas"
  cd: string | null        // congressional district number, e.g. "1" (null = at-large)
  sldu: string | null      // state senate district
  sldl: string | null      // state house district
}

async function getDistrictsFromCensus(lat: number, lon: number): Promise<Districts | null> {
  try {
    const url =
      `https://geocoding.geo.census.gov/geocoder/geographies/coordinates` +
      `?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current` +
      `&layers=54,56,58&format=json`

    const res = await fetch(url, {
      headers: { 'User-Agent': 'MyReps.info/1.0 (contact@myreps.info)' },
    })
    if (!res.ok) return null

    const data = await res.json() as {
      result?: {
        geographies?: {
          States?: Array<{ STUSAB: string; NAME: string }>
          '119th Congressional Districts'?: Array<{ CD119FP: string }>
          'Congressional Districts'?: Array<{ CD: string; BASENAME?: string }>
          'State Legislative Districts - Upper'?: Array<{ SLDU: string }>
          'State Legislative Districts - Lower'?: Array<{ SLDL: string }>
        }
      }
    }

    const geos = data.result?.geographies
    const stateData = geos?.States?.[0]
    if (!stateData) return null

    // Congressional district — try 119th first, fall back to generic key
    const cdData119 = geos?.['119th Congressional Districts']?.[0]
    const cdDataGeneric = geos?.['Congressional Districts']?.[0]
    const cdRaw = cdData119?.CD119FP ?? cdDataGeneric?.CD ?? null

    // "00" means at-large (single district state like WY, AK, etc.)
    const cd = cdRaw && cdRaw !== '00' && cdRaw !== '0' ? String(parseInt(cdRaw)) : null

    const sldu = geos?.['State Legislative Districts - Upper']?.[0]?.SLDU ?? null
    const sldl = geos?.['State Legislative Districts - Lower']?.[0]?.SLDL ?? null

    return {
      stateAbbr: stateData.STUSAB,
      stateName: stateData.NAME,
      cd,
      sldu: sldu ? String(parseInt(sldu)) : null,
      sldl: sldl ? String(parseInt(sldl)) : null,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Step 3: Match districts against wiki politician files — no external API calls
// ---------------------------------------------------------------------------

// Congress.gov uses full state names; OpenStates uses abbreviations.
const STATE_ABBR_TO_NAME: Record<string, string> = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
  CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
  KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
  MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',
  MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
  OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',
  VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
  DC:'District of Columbia',
}

function districtMatches(
  wikiDistrict: string | number | null | undefined,
  censusDistrict: string | null
): boolean {
  if (!censusDistrict || wikiDistrict == null) return false
  const w = parseInt(String(wikiDistrict))
  const c = parseInt(censusDistrict)
  return !isNaN(w) && !isNaN(c) && w === c
}

async function lookupRepsFromWiki(districts: Districts): Promise<RepresentativesByLevel> {
  const { stateAbbr, cd, sldu, sldl } = districts
  const stateName = STATE_ABBR_TO_NAME[stateAbbr] ?? districts.stateName
  const isAtLarge = cd === null  // single-district state

  const all = await getAllPoliticians()

  const federal: Representative[] = []
  const state: Representative[] = []

  for (const p of all) {
    if (!p.in_office) continue

    if (p.level === 'federal') {
      // Federal wiki files store full state name (from Congress.gov)
      const pState = p.state ?? ''
      if (pState.toLowerCase() !== stateName.toLowerCase()) continue

      if (p.chamber === 'Senate') {
        federal.push(toRep(p))
      } else if (p.chamber === 'House') {
        // At-large state: include if district is null/"At Large"/0
        if (isAtLarge) {
          federal.push(toRep(p))
        } else if (districtMatches(p.district, cd)) {
          federal.push(toRep(p))
        }
      }
    } else if (p.level === 'state') {
      // State wiki files store abbreviation (from OpenStates)
      if ((p.state ?? '').toUpperCase() !== stateAbbr.toUpperCase()) continue

      if (p.chamber === 'Senate' && districtMatches(p.district, sldu)) {
        state.push(toRep(p))
      } else if (p.chamber === 'House' && districtMatches(p.district, sldl)) {
        state.push(toRep(p))
      }
    }
  }

  return { federal, state, local: [] }
}

function toRep(p: Awaited<ReturnType<typeof getAllPoliticians>>[number]): Representative {
  return {
    name: p.name,
    slug: p.slug,
    party: p.party,
    office: p.office,
    level: p.level,
    state: p.state,
    photo_url: p.photo_url,
  }
}
