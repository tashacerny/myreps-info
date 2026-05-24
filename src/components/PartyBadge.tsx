import type { Party } from '@/lib/types'

const PARTY_STYLES: Record<string, string> = {
  Democrat: 'bg-blue-100 text-blue-800',
  Republican: 'bg-red-100 text-red-800',
  Independent: 'bg-gray-100 text-gray-700',
  Green: 'bg-green-100 text-green-800',
  Libertarian: 'bg-yellow-100 text-yellow-800',
}

const PARTY_SHORT: Record<string, string> = {
  Democrat: 'D',
  Republican: 'R',
  Independent: 'I',
  Green: 'G',
  Libertarian: 'L',
}

export default function PartyBadge({ party, short = false }: { party: Party; short?: boolean }) {
  const style = PARTY_STYLES[party] ?? 'bg-gray-100 text-gray-700'
  const label = short ? (PARTY_SHORT[party] ?? party[0]) : party
  return (
    <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded ${style}`}>
      {label}
    </span>
  )
}
