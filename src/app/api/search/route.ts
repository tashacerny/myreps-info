import { NextRequest, NextResponse } from 'next/server'
import { searchPoliticians } from '@/lib/wiki'

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim()
  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] })
  }
  const results = await searchPoliticians(q)
  return NextResponse.json({
    results: results.slice(0, 10).map((p) => ({
      name: p.name,
      slug: p.slug,
      party: p.party,
      office: p.office,
      state: p.state,
      level: p.level,
    })),
  })
}
