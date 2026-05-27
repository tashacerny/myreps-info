import { Suspense } from 'react'
import Link from 'next/link'
import { Phone, Globe, MapPin, Twitter, Mail, ArrowLeft } from 'lucide-react'
import { getPoliticianBySlug, getAllPoliticians } from '@/lib/wiki'
import PartyBadge from '@/components/PartyBadge'
import VoteBadge from '@/components/VoteBadge'
import BackToResults from '@/components/BackToResults'

export async function generateStaticParams() {
  const politicians = await getAllPoliticians()
  return politicians.map((p) => ({ slug: p.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const politician = await getPoliticianBySlug(slug)
  if (!politician) return {}
  return {
    title: `${politician.name} — MyReps.info`,
    description: `Voting record, contact info, and sponsored legislation for ${politician.name}, ${politician.office}.`,
  }
}

export default async function PoliticianPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const p = await getPoliticianBySlug(slug)
  if (!p) return <ProfileComingSoon slug={slug} />

  const votes = p.votes ?? []
  const sponsored = p.sponsored_bills ?? []

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-10">
      {/* Back */}
      <Suspense fallback={
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-civic-blue no-underline">
          <ArrowLeft className="w-4 h-4" />
          Back to search
        </Link>
      }>
        <BackToResults />
      </Suspense>

      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 flex flex-col sm:flex-row gap-6">
        {p.photo_url && (
          <img
            src={p.photo_url}
            alt={p.name}
            className="w-24 h-24 rounded-full object-cover border border-gray-200 flex-shrink-0"
          />
        )}
        <div className="flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold text-gray-900">{p.name}</h1>
            <PartyBadge party={p.party} />
            {p.in_office ? (
              <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded font-medium">
                In Office
              </span>
            ) : (
              <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">
                Former
              </span>
            )}
          </div>
          <p className="text-lg text-gray-600 font-medium">{p.office}</p>
          <div className="flex flex-wrap gap-4 text-sm text-gray-500">
            {p.city && p.state && (
              <span className="flex items-center gap-1">
                <MapPin className="w-4 h-4" />
                {p.city}, {p.state_abbr ?? p.state}
              </span>
            )}
            {p.age && <span>Age {p.age}</span>}
            {p.term_start && (
              <span>In office since {new Date(p.term_start).getFullYear()}</span>
            )}
          </div>

          {/* Contact */}
          {p.contact && (
            <div className="flex flex-wrap gap-3 pt-2">
              {p.contact.phone && (
                <a href={`tel:${p.contact.phone}`} className="flex items-center gap-1 text-sm text-civic-blue no-underline hover:underline">
                  <Phone className="w-3.5 h-3.5" />
                  {p.contact.phone}
                </a>
              )}
              {p.contact.website && (
                <a href={p.contact.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sm text-civic-blue no-underline hover:underline">
                  <Globe className="w-3.5 h-3.5" />
                  Official Website
                </a>
              )}
              {p.contact.email && (
                <a href={`mailto:${p.contact.email}`} className="flex items-center gap-1 text-sm text-civic-blue no-underline hover:underline">
                  <Mail className="w-3.5 h-3.5" />
                  Email
                </a>
              )}
              {p.contact.twitter && (
                <a href={`https://twitter.com/${p.contact.twitter}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sm text-civic-blue no-underline hover:underline">
                  <Twitter className="w-3.5 h-3.5" />@{p.contact.twitter}
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bio */}
      {p.bio_html && (
        <section>
          <h2 className="text-xl font-semibold text-gray-900 border-b pb-2 mb-4">Biography</h2>
          <div
            className="prose-wiki text-gray-700 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: p.bio_html }}
          />
        </section>
      )}

      {/* Offices held */}
      {p.offices_held && p.offices_held.length > 1 && (
        <section>
          <h2 className="text-xl font-semibold text-gray-900 border-b pb-2 mb-4">Offices Held</h2>
          <div className="space-y-2">
            {p.offices_held.map((o, i) => (
              <div key={i} className="flex justify-between text-sm py-2 border-b border-gray-100">
                <span className="font-medium text-gray-800">{o.title}</span>
                <span className="text-gray-500">
                  {new Date(o.start).getFullYear()} –{' '}
                  {o.end ? new Date(o.end).getFullYear() : 'Present'}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Voting record */}
      <section>
        <h2 className="text-xl font-semibold text-gray-900 border-b pb-2 mb-4">
          Voting Record{' '}
          <span className="text-sm font-normal text-gray-400">({votes.length} votes)</span>
        </h2>
        {votes.length === 0 ? (
          <p className="text-gray-400 text-sm">No votes on record yet.</p>
        ) : (
          <>
            {/* Mobile: card layout */}
            <div className="sm:hidden space-y-3">
              {votes.map((vote, i) => (
                <div key={i} className="border border-gray-200 rounded-lg p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/bill/${vote.bill_slug}`} className="font-medium text-civic-blue hover:underline text-sm leading-tight">
                      {vote.bill_title}
                    </Link>
                    <VoteBadge vote={vote.vote} />
                  </div>
                  {vote.summary && <p className="text-xs text-gray-500">{vote.summary}</p>}
                  <p className="text-xs text-gray-400">
                    {new Date(vote.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
              ))}
            </div>

            {/* Desktop: table layout */}
            <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                  <th className="pb-2 pr-4 font-medium">Bill</th>
                  <th className="pb-2 pr-4 font-medium">Summary</th>
                  <th className="pb-2 pr-4 font-medium">Date</th>
                  <th className="pb-2 font-medium">Vote</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {votes.map((vote, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="py-3 pr-4 font-medium">
                      <Link href={`/bill/${vote.bill_slug}`} className="text-civic-blue hover:underline">
                        {vote.bill_title}
                      </Link>
                    </td>
                    <td className="py-3 pr-4 text-gray-500 max-w-xs">
                      {vote.summary}
                    </td>
                    <td className="py-3 pr-4 text-gray-500 whitespace-nowrap">
                      {new Date(vote.date).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="py-3">
                      <VoteBadge vote={vote.vote} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}
      </section>

      {/* Sponsored bills */}
      <section>
        <h2 className="text-xl font-semibold text-gray-900 border-b pb-2 mb-4">
          Sponsored Legislation{' '}
          <span className="text-sm font-normal text-gray-400">({sponsored.length})</span>
        </h2>
        {sponsored.length === 0 ? (
          <p className="text-gray-400 text-sm">No sponsored bills on record.</p>
        ) : (
          <div className="space-y-3">
            {sponsored.map((bill, i) => (
              <div key={i} className="border border-gray-200 rounded-lg p-4 hover:border-civic-blue transition-colors">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <Link href={`/bill/${bill.bill_slug}`} className="font-semibold text-civic-blue hover:underline">
                    {bill.bill_title}
                  </Link>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <StatusBadge status={bill.status} />
                    <span className="text-xs text-gray-400">
                      {new Date(bill.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                    </span>
                  </div>
                </div>
                <p className="text-sm text-gray-500 mt-1">{bill.summary}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Last updated */}
      {p.last_updated && (
        <p className="text-xs text-gray-400 text-right">
          Data last updated: {new Date(p.last_updated).toLocaleDateString()}
        </p>
      )}
    </div>
  )
}

function ProfileComingSoon({ slug }: { slug: string }) {
  const name = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return (
    <div className="max-w-2xl mx-auto px-4 py-16 text-center space-y-6">
      <Link href="/" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-civic-blue no-underline">
        <ArrowLeft className="w-4 h-4" />
        Back to search
      </Link>
      <div className="bg-civic-light border border-civic-border rounded-xl p-10 space-y-4">
        <div className="text-5xl">🏛️</div>
        <h1 className="text-2xl font-bold text-gray-900">{name}</h1>
        <p className="text-gray-600">
          This profile is being built. Our weekly data update pulls full voting records,
          biographical info, and sponsored legislation for every representative in all 50 states.
        </p>
        <p className="text-sm text-gray-400">Check back after the next scheduled update — every Sunday at 3am UTC.</p>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const STYLES: Record<string, string> = {
    introduced: 'bg-blue-50 text-blue-700',
    'passed-committee': 'bg-indigo-50 text-indigo-700',
    'passed-house': 'bg-violet-50 text-violet-700',
    'passed-senate': 'bg-purple-50 text-purple-700',
    signed: 'bg-green-50 text-green-700',
    vetoed: 'bg-red-50 text-red-700',
    failed: 'bg-gray-100 text-gray-500',
  }
  const labels: Record<string, string> = {
    introduced: 'Introduced',
    'passed-committee': 'In Committee',
    'passed-house': 'Passed House',
    'passed-senate': 'Passed Senate',
    signed: 'Signed into Law',
    vetoed: 'Vetoed',
    failed: 'Failed',
  }
  const style = STYLES[status] ?? 'bg-gray-100 text-gray-500'
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium whitespace-nowrap ${style}`}>
      {labels[status] ?? status}
    </span>
  )
}
