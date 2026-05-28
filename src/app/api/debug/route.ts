import { NextResponse } from 'next/server'

export async function GET() {
  const key = process.env.OPENSTATES_API_KEY
  if (!key) return NextResponse.json({ error: 'No OPENSTATES_API_KEY set' })

  // Test OpenStates geo with Atlanta, GA coordinates
  const url = 'https://v3.openstates.org/people.geo?lat=33.779&lng=-84.385'
  const res = await fetch(url, { headers: { 'X-API-KEY': key } })
  const body = await res.text()

  return NextResponse.json({
    status: res.status,
    key_prefix: key.slice(0, 6) + '...',
    body: body.slice(0, 800),
  })
}
