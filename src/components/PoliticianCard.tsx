import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import PartyBadge from './PartyBadge'
import type { Representative } from '@/lib/types'

export default function PoliticianCard({ rep }: { rep: Representative }) {
  const inner = (
    <div className="bg-white rounded-lg border border-gray-200 p-4 hover:border-civic-blue hover:shadow-sm transition-all h-full flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-gray-900 leading-tight">{rep.name}</p>
          <p className="text-sm text-gray-500 mt-0.5">{rep.office}</p>
        </div>
        <PartyBadge party={rep.party} short />
      </div>
      {rep.state && (
        <p className="text-xs text-gray-400">{rep.state}</p>
      )}
      {rep.slug ? (
        <p className="text-xs text-civic-blue mt-auto pt-1">View profile →</p>
      ) : (
        <div className="flex items-center gap-1 text-xs text-gray-400 mt-auto pt-1">
          <ExternalLink className="w-3 h-3" />
          Profile coming soon
        </div>
      )}
    </div>
  )

  if (rep.slug) {
    return (
      <Link href={`/politician/${rep.slug}`} className="block hover:no-underline">
        {inner}
      </Link>
    )
  }

  return inner
}
