'use client'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

const linkClass = 'inline-flex items-center gap-1 text-sm text-gray-500 hover:text-civic-blue no-underline'

export default function BackToResults() {
  const searchParams = useSearchParams()
  const zip = searchParams.get('zip')

  return (
    <div className="flex flex-wrap gap-4">
      {zip && (
        <Link href={`/?zip=${zip}`} className={linkClass}>
          <ArrowLeft className="w-4 h-4" />
          Back to results for {zip}
        </Link>
      )}
      <Link href="/" className={linkClass}>
        <ArrowLeft className="w-4 h-4" />
        {zip ? 'Search a different ZIP' : 'Back to search'}
      </Link>
    </div>
  )
}
