import { NextRequest, NextResponse } from 'next/server'
import type { Representative, RepresentativesByLevel } from '@/lib/types'

// Demo data keyed by ZIP code — replaced by live Google Civic API once key is added
const DEMO_DATA: Record<string, RepresentativesByLevel> = {
  '05401': {
    federal: [
      {
        name: 'Jane Crawford',
        slug: 'jane-crawford',
        party: 'Democrat',
        office: 'U.S. Senator',
        level: 'federal',
        state: 'Vermont',
        website: 'https://example.com',
      },
      {
        name: 'Peter Hollis',
        slug: 'peter-hollis',
        party: 'Independent',
        office: 'U.S. Senator',
        level: 'federal',
        state: 'Vermont',
      },
      {
        name: 'Ana Delgado',
        slug: 'ana-delgado',
        party: 'Democrat',
        office: 'U.S. Representative, VT-At Large',
        level: 'federal',
        state: 'Vermont',
      },
    ],
    state: [
      {
        name: 'Patricia Okonkwo',
        slug: 'patricia-okonkwo',
        party: 'Democrat',
        office: 'Vermont State Senator, Essex-Orleans District',
        level: 'state',
        state: 'Vermont',
      },
      {
        name: 'Derek Fontaine',
        slug: 'derek-fontaine',
        party: 'Republican',
        office: 'Vermont State Representative, Chittenden District',
        level: 'state',
        state: 'Vermont',
      },
    ],
    local: [
      {
        name: 'Mayor Gloria Reyes',
        slug: undefined,
        party: 'Democrat',
        office: 'Mayor of Burlington',
        level: 'local',
        state: 'Vermont',
      },
    ],
  },
  '77001': {
    federal: [
      {
        name: 'Robert Haines',
        slug: 'robert-haines',
        party: 'Republican',
        office: 'U.S. Senator',
        level: 'federal',
        state: 'Texas',
      },
      {
        name: 'Sandra Vo',
        slug: undefined,
        party: 'Republican',
        office: 'U.S. Senator',
        level: 'federal',
        state: 'Texas',
      },
      {
        name: 'Marcus Webb',
        slug: 'marcus-webb',
        party: 'Republican',
        office: 'U.S. Representative, TX-18',
        level: 'federal',
        state: 'Texas',
      },
    ],
    state: [
      {
        name: 'Tomás Ibarra',
        slug: undefined,
        party: 'Democrat',
        office: 'Texas State Senator, District 6',
        level: 'state',
        state: 'Texas',
      },
    ],
    local: [],
  },
  '94102': {
    federal: [
      {
        name: 'Sandra Vo',
        slug: undefined,
        party: 'Democrat',
        office: 'U.S. Senator',
        level: 'federal',
        state: 'California',
      },
      {
        name: 'Ana Delgado',
        slug: 'ana-delgado',
        party: 'Democrat',
        office: 'U.S. Representative, CA-11',
        level: 'federal',
        state: 'California',
      },
    ],
    state: [
      {
        name: 'Luis Ferrara',
        slug: undefined,
        party: 'Democrat',
        office: 'California State Senator, District 11',
        level: 'state',
        state: 'California',
      },
    ],
    local: [
      {
        name: 'Mayor Daniel Lurie',
        slug: undefined,
        party: 'Democrat',
        office: 'Mayor of San Francisco',
        level: 'local',
        state: 'California',
      },
    ],
  },
}

export async function GET(request: NextRequest) {
  const zip = request.nextUrl.searchParams.get('zip')

  if (!zip || !/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: 'Invalid ZIP code' }, { status: 400 })
  }

  // When GOOGLE_CIVIC_API_KEY is set, call the live API instead
  if (process.env.GOOGLE_CIVIC_API_KEY) {
    try {
      const url = `https://www.googleapis.com/civicinfo/v2/representatives?address=${zip}&key=${process.env.GOOGLE_CIVIC_API_KEY}`
      const response = await fetch(url)
      if (!response.ok) throw new Error('Civic API error')
      const civicData = await response.json()
      const formatted = formatCivicApiResponse(civicData)
      return NextResponse.json(formatted)
    } catch (err) {
      console.error('Google Civic API error:', err)
    }
  }

  // Fall back to demo data
  const demo = DEMO_DATA[zip]
  if (demo) return NextResponse.json(demo)

  return NextResponse.json(
    { error: `No data available for ZIP ${zip} in demo mode` },
    { status: 404 }
  )
}

function formatCivicApiResponse(data: {
  officials?: Array<{
    name: string
    party?: string
    phones?: string[]
    urls?: string[]
    photoUrl?: string
    channels?: Array<{ type: string; id: string }>
  }>
  offices?: Array<{
    name: string
    levels?: string[]
    officialIndices: number[]
  }>
}): RepresentativesByLevel {
  const result: RepresentativesByLevel = { federal: [], state: [], local: [] }

  if (!data.officials || !data.offices) return result

  for (const office of data.offices) {
    const level = mapCivicLevel(office.levels ?? [])
    for (const idx of office.officialIndices) {
      const official = data.officials[idx]
      if (!official) continue
      const rep: Representative = {
        name: official.name,
        party: (official.party as Representative['party']) ?? 'Unknown',
        office: office.name,
        level,
        photo_url: official.photoUrl,
        website: official.urls?.[0],
      }
      result[level].push(rep)
    }
  }

  return result
}

function mapCivicLevel(levels: string[]): 'federal' | 'state' | 'local' {
  if (levels.some((l) => l === 'country')) return 'federal'
  if (levels.some((l) => l === 'administrativeArea1')) return 'state'
  return 'local'
}
