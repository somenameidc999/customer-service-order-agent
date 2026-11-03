import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

export function chatSession(c: Context, secure = false): string {
  const existing = getCookie(c, 'order_chat')
  if (existing && /^[a-f0-9]{64}$/.test(existing)) return existing
  const id = randomBytes(32).toString('hex')
  setCookie(c, 'order_chat', id, { httpOnly: true, sameSite: 'Strict', path: '/api',
    secure: secure || c.req.url.startsWith('https:'), maxAge: 60 * 60 * 24 })
  return id
}
