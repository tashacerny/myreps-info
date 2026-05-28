import { NextRequest, NextResponse } from 'next/server'
import type { Representative, RepresentativesByLevel } from '@/lib/types'

const OPENSTATES_KEY = process.env.OPENSTATES_API_KEY

export async function GET(request: NextRequest) {
  const zip = request.nextUrl.searchParams.get('zip')
  if (!zip || !/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: 'Invalid ZIP code' }, { status: 400 })
  }

  try {
    // Step 1: ZIP → lat/lon via Nominatim (free, no key needed)
    const location = await geocodeZip(zip)
    if (!location) {
      return NextResponse.json(
        { error: `Could not locate ZIP code ${zip}. Please check and try again.` },
        { status: 404 }
      )
    }

    // Step 2: lat/lon → all reps via OpenStates geo endpoint
    // OpenStates returns BOTH federal and state legislators in one call
    const all = await getRepsByLocation(location.lat, location.lon)
    return NextResponse.json(all)
  } catch (err) {
    console.error('Representatives API error:', err)
    return NextResponse.json(
      { error: 'Failed to look up representatives. Please try again.' },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// ZIP → lat/lon via Nominatim (OpenStreetMap, free, no key)
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
// lat/lon → all representatives via OpenStates geo
// Returns federal + state legislators split into the right buckets
// ---------------------------------------------------------------------------

async function getRepsByLocation(lat: number, lon: number): Promise<RepresentativesByLevel> {
  const result: RepresentativesByLevel = { federal: [], state: [], local: [] }

  if (!OPENSTATES_KEY) {
    console.error('OPENSTATES_API_KEY is not set — cannot look up representatives')
    return result
  }

  try {
    const url = `https://v3.openstates.org/people.geo?lat=${lat}&lng=${lon}`
    const res = await fetch(url, {
      headers: { 'X-API-KEY': OPENSTATES_KEY },
    })

    if (!res.ok) {
      const body = await res.text()
      console.error(`OpenStates geo error: HTTP ${res.status}`, body)
      return result
    }

    const data = await res.json() as {
      results?: Array<{
        name: string
        party: string
        image?: string
        current_role?: {
          title: string
          org_classification: string
          district: string
        }
        jurisdiction?: {
          classification: string
          name: string
        }
        openstates_url?: string
      }>
    }

    for (const person of data.results ?? []) {
      const role = person.current_role
      const jurisdiction = person.jurisdiction?.classification ?? 'state'
      const isFederal = jurisdiction === 'country'

      const rep: Representative = {
        name: person.name,
        party: person.party as Representative['party'],
        office: formatOffice(role?.title, role?.district, isFederal),
        level: isFederal ? 'federal' : 'state',
        photo_url: person.image,
        website: person.openstates_url,
      }

      if (isFederal) {
        result.federal.push(rep)
      } else {
        result.state.push(rep)
      }
    }
  } catch (err) {
    console.error('OpenStates error:', err)
  }

  return result
}

function formatOffice(title?: string, district?: string, isFederal?: boolean): string {
  if (!title) return 'Representative'
  if (isFederal) {
    // Federal: district looks like "IL-5" or "Illinois"
    if (title === 'Senator') return 'U.S. Senator'
    if (title === 'Representative') return `U.S. Representative${district ? ', ' + district : ''}`
  }
  // State: district is just a number or name
  return `${title}${district ? ', District ' + district : ''}`
}
