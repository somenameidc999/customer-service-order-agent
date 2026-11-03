import type { MiddlewareHandler } from 'hono'
import { CHAT_LIMITS } from '../shared/chat.js'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function protectApiOrigin(publicOrigin?: string): MiddlewareHandler {
  const configuredOrigin = publicOrigin ? new URL(publicOrigin) : undefined
  return async (c, next) => {
    const requestUrl = new URL(c.req.url)
    const trusted = configuredOrigin ?? requestUrl
    const host = c.req.header('host')?.toLowerCase() ?? requestUrl.host
    const defaultPort = trusted.protocol === 'https:' ? '443' : '80'
    const validHost = host === trusted.host || (!trusted.port && host === `${trusted.hostname}:${defaultPort}`)
    const origin = c.req.header('origin')
    if (!validHost || (!configuredOrigin && !LOOPBACK_HOSTS.has(trusted.hostname)) ||
        (origin !== undefined && origin !== trusted.origin)) {
      return c.json({ error: 'Send API requests from this app only.' }, 403)
    }
    await next()
  }
}

type JsonBody = { value: unknown } | { status: 400 | 413 | 415 }

export async function readJsonBody(request: Request): Promise<JsonBody> {
  const maxBytes = CHAT_LIMITS.maxRequestBodyBytes
  if (Number(request.headers.get('content-length')) > maxBytes) return { status: 413 }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') return { status: 415 }
  if (!request.body) return { status: 400 }

  const bytes = new Uint8Array(maxBytes)
  const reader = request.body.getReader()
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (size + value.byteLength > maxBytes) {
        void reader.cancel().catch(() => {})
        return { status: 413 }
      }
      bytes.set(value, size)
      size += value.byteLength
    }
    return { value: JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))) as unknown }
  } catch {
    return { status: 400 }
  } finally {
    reader.releaseLock()
  }
}

export function jsonBodyError(status: 400 | 413 | 415): string {
  if (status === 413) return 'Request body is too large.'
  if (status === 415) return 'Use Content-Type: application/json.'
  return 'Request body must be valid JSON.'
}
