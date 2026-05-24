import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'MyReps.info — Know Your Representatives',
  description:
    'Look up every politician representing you at the local, state, and federal level. See their voting records, sponsored bills, and contact info.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        <header className="bg-civic-navy text-white shadow-md">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
            <Link href="/" className="text-xl font-bold tracking-tight text-white hover:no-underline">
              MyReps<span className="text-blue-300">.info</span>
            </Link>
            <nav className="flex gap-6 text-sm text-blue-200">
              <Link href="/" className="hover:text-white transition-colors">
                Find My Reps
              </Link>
              <Link href="/about" className="hover:text-white transition-colors">
                About
              </Link>
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="bg-gray-100 border-t border-gray-200 text-sm text-gray-500 py-6 mt-12">
          <div className="max-w-6xl mx-auto px-4 text-center space-y-1">
            <p>
              Data sourced from{' '}
              <a href="https://developers.google.com/civic-information" className="underline">
                Google Civic Information API
              </a>
              ,{' '}
              <a href="https://propublica.org/datastore" className="underline">
                ProPublica Congress API
              </a>
              ,{' '}
              <a href="https://openstates.org" className="underline">
                OpenStates
              </a>
              , and{' '}
              <a href="https://api.congress.gov" className="underline">
                Congress.gov
              </a>
              .
            </p>
            <p>
              Bill summaries powered by{' '}
              <a href="https://anthropic.com" className="underline">
                Claude
              </a>
              . MyReps.info is nonpartisan and not affiliated with any political organization.
            </p>
          </div>
        </footer>
      </body>
    </html>
  )
}
