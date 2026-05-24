export type Party =
  | 'Democrat'
  | 'Republican'
  | 'Independent'
  | 'Green'
  | 'Libertarian'
  | string

export type Level = 'federal' | 'state' | 'local'
export type Chamber = 'Senate' | 'House' | 'State Senate' | 'State House' | 'City Council' | string
export type VoteChoice = 'Yea' | 'Nay' | 'Abstain' | 'Absent' | 'Not Voting'
export type BillStatus = 'introduced' | 'passed-committee' | 'passed-house' | 'passed-senate' | 'signed' | 'vetoed' | 'failed'

export interface ContactInfo {
  phone?: string
  website?: string
  email?: string
  twitter?: string
  facebook?: string
  instagram?: string
  office_address?: string
}

export interface OfficeHeld {
  title: string
  state?: string
  district?: string
  start: string
  end?: string | null
}

export interface VoteRecord {
  bill_slug: string
  bill_title: string
  date: string
  vote: VoteChoice
  summary: string
  congress?: number
  chamber?: string
}

export interface SponsoredBill {
  bill_slug: string
  bill_title: string
  date: string
  status: BillStatus
  summary: string
  congress?: number
  cosponsors?: number
}

export interface Politician {
  // Identity
  name: string
  slug: string
  party: Party
  age?: number
  birthdate?: string
  city?: string
  state?: string
  state_abbr?: string
  photo_url?: string

  // Office
  level: Level
  chamber?: Chamber
  office: string
  district?: string | null
  in_office: boolean
  running_for?: string | null

  // Contact
  contact?: ContactInfo

  // History
  term_start?: string
  offices_held?: OfficeHeld[]

  // Legislative record
  votes?: VoteRecord[]
  sponsored_bills?: SponsoredBill[]

  // Meta
  last_updated?: string
  source?: string
  bio_html?: string
}

export interface BillVote {
  politician_slug: string
  politician_name: string
  party: Party
  state: string
  chamber: string
  vote: VoteChoice
  date: string
}

export interface Bill {
  id: string
  slug: string
  title: string
  short_title?: string
  congress?: number
  chamber?: string
  status: BillStatus
  date_introduced?: string
  date_passed_house?: string
  date_passed_senate?: string
  date_signed?: string
  sponsor_slug?: string
  sponsor_name?: string
  cosponsor_count?: number
  subjects?: string[]
  summary?: string
  summary_source?: string
  full_text_url?: string
  votes?: BillVote[]
  last_updated?: string
  summary_html?: string
}

export interface Representative {
  name: string
  slug?: string
  party: Party
  office: string
  level: Level
  state?: string
  district?: string
  photo_url?: string
  website?: string
}

export interface RepresentativesByLevel {
  federal: Representative[]
  state: Representative[]
  local: Representative[]
}
