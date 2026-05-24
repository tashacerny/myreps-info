'use client'

import { useState } from 'react'
import { Search, MapPin, AlertCircle } from 'lucide-react'
import PoliticianCard from '@/components/PoliticianCard'
import type { Representative, RepresentativesByLevel } from '@/lib/types'

const DEMO_NOTICE = true

export default function HomePage() {
  const [zip, setZip] = useState('')
  const [results, setResults] = useState<RepresentativesByLevel | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchedZip, setSearchedZip] = useState('')

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = zip.trim()
    if (!/^\d{5}$/.test(trimmed)) {
      setError('Please enter a valid 5-digit ZIP code.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(`/api/representatives?zip=${trimmed}`)
      if (!res.ok) throw new Error('Lookup failed')
      const data: RepresentativesByLevel = await res.json()
      setResults(data)
      setSearchedZip(trimmed)
    } catch {
      setError('Could not find representatives for that ZIP code. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      {/* Hero */}
      <section className="bg-gradient-to-br from-civic-navy to-blue-800 text-white py-16 px-4">
        <div className="max-w-2xl mx-auto text-center space-y-6">
          <h1 className="text-4xl font-bold leading-tight">
            Know Who Represents You
          </h1>
          <p className="text-blue-200 text-lg">
            Enter your ZIP code to see every politician representing you — local, state, and
            federal — along with their full voting records and contact info.
          </p>

          <form onSubmit={handleSearch} className="flex gap-2 max-w-md mx-auto">
            <div className="relative flex-1">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
              <input
                type="text"
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                placeholder="Enter ZIP code"
                maxLength={5}
                className="w-full pl-9 pr-4 py-3 rounded-lg text-gray-900 text-base focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="bg-blue-500 hover:bg-blue-400 disabled:bg-blue-700 text-white font-semibold px-6 py-3 rounded-lg flex items-center gap-2 transition-colors"
            >
              <Search className="w-4 h-4" />
              {loading ? 'Searching…' : 'Search'}
            </button>
          </form>

          {error && (
            <div className="flex items-center gap-2 bg-red-900/40 text-red-200 rounded-lg px-4 py-3 text-sm max-w-md mx-auto">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
        </div>
      </section>

      {/* Demo notice */}
      {DEMO_NOTICE && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-3">
          <p className="text-sm text-amber-800 text-center max-w-3xl mx-auto">
            <strong>Demo mode:</strong> API keys not yet connected. Try ZIP codes{' '}
            <button
              onClick={() => setZip('05401')}
              className="underline font-medium"
            >
              05401
            </button>
            ,{' '}
            <button
              onClick={() => setZip('77001')}
              className="underline font-medium"
            >
              77001
            </button>
            , or{' '}
            <button
              onClick={() => setZip('94102')}
              className="underline font-medium"
            >
              94102
            </button>{' '}
            to see sample data.
          </p>
        </div>
      )}

      {/* Results */}
      {results && (
        <section className="max-w-6xl mx-auto px-4 py-10 space-y-10">
          <h2 className="text-2xl font-bold text-gray-900">
            Representatives for ZIP <span className="text-civic-blue">{searchedZip}</span>
          </h2>

          {results.federal.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-700 mb-4 flex items-center gap-2">
                <span className="bg-civic-navy text-white text-xs px-2 py-0.5 rounded uppercase tracking-wide">
                  Federal
                </span>
              </h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {results.federal.map((rep) => (
                  <PoliticianCard key={rep.name} rep={rep} />
                ))}
              </div>
            </div>
          )}

          {results.state.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-700 mb-4 flex items-center gap-2">
                <span className="bg-indigo-700 text-white text-xs px-2 py-0.5 rounded uppercase tracking-wide">
                  State
                </span>
              </h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {results.state.map((rep) => (
                  <PoliticianCard key={rep.name} rep={rep} />
                ))}
              </div>
            </div>
          )}

          {results.local.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-700 mb-4 flex items-center gap-2">
                <span className="bg-teal-700 text-white text-xs px-2 py-0.5 rounded uppercase tracking-wide">
                  Local
                </span>
              </h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {results.local.map((rep) => (
                  <PoliticianCard key={rep.name} rep={rep} />
                ))}
              </div>
            </div>
          )}

          {results.federal.length === 0 &&
            results.state.length === 0 &&
            results.local.length === 0 && (
              <p className="text-gray-500 text-center py-12">
                No representatives found for ZIP {searchedZip}.
              </p>
            )}
        </section>
      )}

      {/* How it works */}
      {!results && (
        <section className="max-w-4xl mx-auto px-4 py-16 grid sm:grid-cols-3 gap-8 text-center">
          {[
            {
              icon: '🔍',
              title: 'Search by ZIP',
              desc: 'Enter your ZIP code to instantly find everyone who represents you — city, county, state, and federal.',
            },
            {
              icon: '📊',
              title: 'Full Voting Records',
              desc: 'See how each politician voted on every bill and amendment during every office they have held.',
            },
            {
              icon: '📄',
              title: 'Plain-English Summaries',
              desc: 'Every bill includes a clear summary of what it does — no legal jargon required.',
            },
          ].map((item) => (
            <div key={item.title} className="space-y-3">
              <div className="text-4xl">{item.icon}</div>
              <h3 className="font-semibold text-lg text-gray-900">{item.title}</h3>
              <p className="text-gray-500 text-sm leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
