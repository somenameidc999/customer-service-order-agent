import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface HumanSupportRequest {
  id: string
  destination: 'local-human-support'
  status: 'queued'
  createdAt: string
  summary: string
}

/** A durable local inbox. Queued means awaiting staff pickup, never a live transfer. */
export class HumanSupportStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_support (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT UNIQUE NOT NULL, document TEXT NOT NULL
    )`)
  }

  enqueue(sessionId: string, context: string | readonly { role: string; content: string }[]): HumanSupportRequest {
    if (!sessionId) throw new Error('A chat session is required to queue human support.')
    // Customer text is untrusted evidence. Do not persist assistant claims as verified facts.
    const text = typeof context === 'string' ? context : context.filter((entry) => entry.role === 'user').map((entry) => entry.content).join('\n')
    const summary = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
      .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, '[phone redacted]').slice(-3000)
    // A session has one outstanding request. Repeat requests return the same reference.
    const fingerprint = createHash('sha256').update(sessionId).digest('hex')
    const existing = this.db.prepare('SELECT document FROM human_support WHERE fingerprint=?').get(fingerprint)
    if (existing) return JSON.parse(String(existing.document)) as HumanSupportRequest
    const result: HumanSupportRequest = { id: `support-${randomUUID()}`, destination: 'local-human-support', status: 'queued', createdAt: new Date().toISOString(), summary }
    this.db.prepare('INSERT INTO human_support VALUES (?,?,?,?)').run(result.id, sessionId, fingerprint, JSON.stringify(result))
    return result
  }

  list(sessionId: string): HumanSupportRequest[] {
    return this.db.prepare('SELECT document FROM human_support WHERE session_id=? ORDER BY rowid DESC').all(sessionId)
      .map((row) => JSON.parse(String(row.document)) as HumanSupportRequest)
  }

  close(): void { this.db.close() }
}

let defaultStore: HumanSupportStore | undefined
export function getHumanSupportStore(): HumanSupportStore {
  return defaultStore ??= new HumanSupportStore(process.env.HUMAN_SUPPORT_DB ?? '.data/human-support.sqlite')
}
