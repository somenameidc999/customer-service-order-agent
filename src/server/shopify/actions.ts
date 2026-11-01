import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ShippingAddress, ShopifyActionStatus, ShopifyActionView } from '../../shared/actions.js'

export interface RefundTransaction { orderId: string; parentId: string; gateway: string; kind: 'REFUND'; amount: string }
export type ActionPayload =
  | { kind: 'refund'; amount: string; currency: string; reason: string; notifyCustomer: boolean; transactions: RefundTransaction[] }
  | { kind: 'shipping_address'; address: ShippingAddress }
  | { kind: 'cancel_order'; reason: string; notifyCustomer: boolean }

export interface StoredShopifyAction {
  id: string
  sessionId: string
  storeDomain: string
  orderId: string
  customerId: string
  updatedAt: string
  payload: ActionPayload
  view: ShopifyActionView
}

export class ActionError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'ActionError' }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  return JSON.stringify(value)
}

/** Durable claim-before-mutation journal. Unknown outcomes can never be blindly retried. */
export class ShopifyActionStore {
  private db: DatabaseSync
  constructor(path: string, private now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL,
        session_id TEXT NOT NULL, order_id TEXT NOT NULL, status TEXT NOT NULL, expires INTEGER NOT NULL,
        document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_audit (id INTEGER PRIMARY KEY, action_id TEXT NOT NULL,
        time TEXT NOT NULL, status TEXT NOT NULL, approved INTEGER NOT NULL);`)
  }

  prepare(input: Omit<StoredShopifyAction, 'id' | 'view'> & { title: string; details: string[]; orderName: string }): ShopifyActionView {
    const fingerprint = createHash('sha256').update(canonical({ session: input.sessionId, store: input.storeDomain,
      order: input.orderId, version: input.updatedAt, payload: input.payload })).digest('hex')
    const existing = this.db.prepare('SELECT document FROM actions WHERE fingerprint=?').get(fingerprint)
    if (existing) {
      const previous = JSON.parse(String(existing.document)) as StoredShopifyAction
      const view = this.get(previous.id, input.sessionId).view
      if (!['expired','cancelled','failed'].includes(view.status)) return view
      this.db.prepare('UPDATE actions SET fingerprint=? WHERE id=?').run(`${fingerprint}:${previous.id}`, previous.id)
    }
    // A revised amount or operation withdraws the previous consent request.
    this.cancelPending(input.sessionId, input.orderId)
    const id = randomUUID()
    const view: ShopifyActionView = { id, kind: input.payload.kind, orderName: input.orderName,
      title: input.title, details: input.details, requiresApproval: input.payload.kind !== 'shipping_address',
      status: 'pending', expiresAt: new Date(this.now() + 15 * 60 * 1000).toISOString() }
    const action: StoredShopifyAction = { id, sessionId: input.sessionId, storeDomain: input.storeDomain,
      orderId: input.orderId, customerId: input.customerId, updatedAt: input.updatedAt, payload: input.payload, view }
    this.db.prepare('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, fingerprint, input.sessionId, input.orderId, 'pending', Date.parse(view.expiresAt), JSON.stringify(action))
    this.audit(id, 'pending', false)
    return view
  }

  get(id: string, sessionId: string): StoredShopifyAction {
    const row = this.db.prepare('SELECT document FROM actions WHERE id=? AND session_id=?').get(id, sessionId)
    if (!row) throw new ActionError('This action was not found in this chat.', 404)
    const action = JSON.parse(String(row.document)) as StoredShopifyAction
    if (action.view.status === 'pending' && Date.parse(action.view.expiresAt) <= this.now()) {
      return this.finish(action, 'expired')
    }
    return action
  }

  list(sessionId: string): ShopifyActionView[] {
    const rows = this.db.prepare('SELECT id FROM actions WHERE session_id=? ORDER BY rowid DESC LIMIT 25').all(sessionId)
    return rows.map((row) => this.get(String(row.id), sessionId).view)
  }

  claim(id: string, sessionId: string, approved: boolean): StoredShopifyAction {
    const action = this.get(id, sessionId)
    if (action.view.status !== 'pending') throw new ActionError('This action has already been confirmed or is no longer available.')
    if (action.view.requiresApproval && !approved) throw new ActionError('Approve this action as the store operator before confirming.', 400)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // Serialize mutations on one order, including after a process restart.
      const active = this.db.prepare("SELECT id FROM actions WHERE order_id=? AND status IN ('executing','unknown','processing')").get(action.orderId)
      if (active) throw new ActionError('An earlier action on this order needs its Shopify outcome checked before another change.')
      const document = { ...action, view: { ...action.view, status: 'executing' as const } }
      const updated = this.db.prepare("UPDATE actions SET status='executing', document=? WHERE id=? AND status='pending'")
        .run(JSON.stringify(document), id)
      if (updated.changes !== 1) throw new ActionError('This action is already being processed.')
      this.audit(id, 'executing', approved)
      this.db.exec('COMMIT')
      return document
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  finish(action: StoredShopifyAction, status: ShopifyActionStatus, result?: ShopifyActionView['result'], error?: string): StoredShopifyAction {
    const row = this.db.prepare('SELECT document FROM actions WHERE id=? AND session_id=?').get(action.id, action.sessionId)
    if (!row) throw new ActionError('This action was not found in this chat.', 404)
    const current = JSON.parse(String(row.document)) as StoredShopifyAction
    const terminal: ShopifyActionStatus[] = ['succeeded', 'failed', 'cancelled', 'expired']
    // A late network response or status check cannot overwrite a final result.
    if (terminal.includes(current.view.status)) return current
    if (current.view.status !== action.view.status && status !== 'succeeded') return current
    if (current.view.status !== 'pending' && ['cancelled', 'expired'].includes(status)) return current
    const updated = { ...current, view: { ...current.view, status, result, error } }
    const changed = this.db.prepare('UPDATE actions SET status=?, document=? WHERE id=? AND status=?')
      .run(status, JSON.stringify(updated), action.id, current.view.status)
    if (changed.changes !== 1) return this.get(action.id, action.sessionId)
    this.audit(action.id, status, false)
    return updated
  }

  /** Withdraw only unexecuted proposals. Executing or uncertain writes stay blocked. */
  cancelPending(sessionId: string, orderId?: string): ShopifyActionView[] {
    const rows = orderId
      ? this.db.prepare("SELECT document FROM actions WHERE session_id=? AND order_id=? AND status='pending'").all(sessionId, orderId)
      : this.db.prepare("SELECT document FROM actions WHERE session_id=? AND status='pending'").all(sessionId)
    return rows.map((row) => {
      const action = JSON.parse(String(row.document)) as StoredShopifyAction
      return this.finish(action, 'cancelled').view
    })
  }

  cancel(id: string, sessionId: string): ShopifyActionView {
    const action = this.get(id, sessionId)
    if (action.view.status !== 'pending') throw new ActionError('Only an unconfirmed action can be dismissed.')
    return this.finish(action, 'cancelled').view
  }

  private audit(id: string, status: ShopifyActionStatus, approved: boolean): void {
    // No credentials, contact information, address, or payment details in audit records.
    this.db.prepare('INSERT INTO action_audit (action_id,time,status,approved) VALUES (?,?,?,?)')
      .run(id, new Date(this.now()).toISOString(), status, approved ? 1 : 0)
  }

  close(): void { this.db.close() }
}

let defaultStore: ShopifyActionStore | undefined
export function getShopifyActionStore(): ShopifyActionStore {
  return defaultStore ??= new ShopifyActionStore(process.env.SHOPIFY_ACTIONS_DB ?? '.data/shopify-actions.sqlite')
}
