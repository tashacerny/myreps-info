import Link from 'next/link'
import PartyBadge from './PartyBadge'
import type { Representative } from '@/lib/types'

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export default function PoliticianCard({ rep }: { rep: Representative }) {
  const slug = rep.slug ?? toSlug(rep.name)

  return (
    <Link href={`/politician/${slug}`} className="block hover:no-underline">
      <div className="bg-white rounded-lg border border-gray-200 p-4 hover:border-civic-blue hover:shadow-sm transition-all h-full flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          {rep.photo_url && (
            <img
              src={rep.photo_url}
              alt={rep.name}
              className="w-10 h-10 rounded-full object-cover border border-gray-100 flex-shrink-0"
            />
          )}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-gray-900 leading-tight truncate">{rep.name}</p>
            <p className="text-sm text-gray-500 mt-0.5 leading-tight">{rep.office}</p>
          </div>
          <PartyBadge party={rep.party} short />
        </div>
        {rep.state && (
          <p className="text-xs text-gray-400">{rep.state}</p>
        )}
        <p className="text-xs text-civic-blue mt-auto pt-1">View profile →</p>
      </div>
    </Link>
  )
}
