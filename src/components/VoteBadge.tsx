import type { VoteChoice } from '@/lib/types'

const VOTE_STYLES: Record<VoteChoice, string> = {
  Yea: 'bg-green-100 text-green-800 font-semibold',
  Nay: 'bg-red-100 text-red-800 font-semibold',
  Abstain: 'bg-gray-100 text-gray-600',
  Absent: 'bg-gray-50 text-gray-400',
  'Not Voting': 'bg-gray-50 text-gray-400',
}

export default function VoteBadge({ vote }: { vote: VoteChoice }) {
  const style = VOTE_STYLES[vote] ?? 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded ${style}`}>{vote}</span>
  )
}
