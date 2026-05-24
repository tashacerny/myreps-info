import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { remark } from 'remark'
import remarkHtml from 'remark-html'
import type { Politician, Bill } from './types'

const WIKI_DIR = path.join(process.cwd(), 'wiki')
const POLITICIANS_DIR = path.join(WIKI_DIR, 'politicians')
const BILLS_DIR = path.join(WIKI_DIR, 'bills')

async function markdownToHtml(markdown: string): Promise<string> {
  const result = await remark().use(remarkHtml, { sanitize: false }).process(markdown)
  return result.toString()
}

export async function getAllPoliticians(): Promise<Politician[]> {
  const files = fs.readdirSync(POLITICIANS_DIR).filter((f) => f.endsWith('.md'))
  const politicians = await Promise.all(
    files.map(async (filename) => {
      const slug = filename.replace(/\.md$/, '')
      return getPoliticianBySlug(slug)
    })
  )
  return politicians
    .filter((p): p is Politician => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function getPoliticianBySlug(slug: string): Promise<Politician | null> {
  const fullPath = path.join(POLITICIANS_DIR, `${slug}.md`)
  if (!fs.existsSync(fullPath)) return null

  const fileContents = fs.readFileSync(fullPath, 'utf8')
  const { data, content } = matter(fileContents)
  const bio_html = await markdownToHtml(content)

  return {
    ...(data as Omit<Politician, 'slug' | 'bio_html'>),
    slug,
    bio_html,
  }
}

export async function getAllBills(): Promise<Bill[]> {
  const files = fs.readdirSync(BILLS_DIR).filter((f) => f.endsWith('.md'))
  const bills = await Promise.all(
    files.map(async (filename) => {
      const slug = filename.replace(/\.md$/, '')
      return getBillBySlug(slug)
    })
  )
  return bills
    .filter((b): b is Bill => b !== null)
    .sort((a, b) => (b.date_introduced ?? '').localeCompare(a.date_introduced ?? ''))
}

export async function getBillBySlug(slug: string): Promise<Bill | null> {
  const fullPath = path.join(BILLS_DIR, `${slug}.md`)
  if (!fs.existsSync(fullPath)) return null

  const fileContents = fs.readFileSync(fullPath, 'utf8')
  const { data, content } = matter(fileContents)
  const summary_html = content.trim() ? await markdownToHtml(content) : undefined

  return {
    ...(data as Omit<Bill, 'slug' | 'summary_html'>),
    slug,
    summary_html,
  }
}

export async function searchPoliticians(query: string): Promise<Politician[]> {
  const all = await getAllPoliticians()
  const q = query.toLowerCase()
  return all.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.state?.toLowerCase().includes(q) ||
      p.office?.toLowerCase().includes(q) ||
      p.party?.toLowerCase().includes(q)
  )
}
