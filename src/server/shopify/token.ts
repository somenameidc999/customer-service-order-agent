import { loadShopifyConfig, type ShopifyConfig } from './config.js'

const TOKEN_PATH = '/admin/oauth/access_token'
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
/** Refresh this long before the reported expiry so a call never races the TTL. */
export const TOKEN_REFRESH_SKEW_MS = 60_000
const MAX_ERROR_DETAIL_LENGTH = 300

export interface ShopifyAccessToken {
  accessToken: string
  /** Comma-separated scopes granted by Shopify (may be empty). */
  scope: string
  /** Epoch milliseconds when the token expires, or `null` when it does not expire. */
  expiresAt: number | null
}

/**
 * A failed token request. `retryable` lets callers distinguish a transient
 * Shopify/network problem from a rejected credential, and the message never
 * contains the client secret or a token value.
 */
export class ShopifyTokenError extends Error {
  readonly status: number
  readonly retryable: boolean

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message)
    this.name = 'ShopifyTokenError'
    this.status = options.status ?? 0
    this.retryable = options.retryable ?? false
  }
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface ShopifyTokenProvider {
  /** Return a cached token when it is still fresh, otherwise acquire one. */
  getToken(options?: { forceRefresh?: boolean }): Promise<ShopifyAccessToken>
  /** Convenience wrapper returning only the token string. */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>
  /** Drop the cached token, e.g. after the Admin API rejects it with 401. */
  invalidate(): void
}

export interface ShopifyTokenProviderOptions {
  /** Defaults to `loadShopifyConfig()`, which reads `.env` and the environment. */
  config?: ShopifyConfig
  /** Override the Shopify host base URL (tests point this at a local server). */
  baseUrl?: string
  /** Injectable fetch for tests. Defaults to global `fetch`. */
  fetch?: FetchLike
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number
  requestTimeoutMs?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[redacted]')
  }
  return result
}

function isFresh(token: ShopifyAccessToken, now: () => number): boolean {
  if (token.expiresAt === null) return true
  return now() < token.expiresAt - TOKEN_REFRESH_SKEW_MS
}

/**
 * Acquire and cache a Shopify Admin API access token using the client
 * credentials grant (single-store custom app). The client ID and secret are
 * read from the server environment and are never logged or surfaced in errors.
 */
export function createShopifyTokenProvider(options: ShopifyTokenProviderOptions = {}): ShopifyTokenProvider {
  const config = options.config ?? loadShopifyConfig()
  const baseUrl = (options.baseUrl ?? `https://${config.storeDomain}`).replace(/\/+$/, '')
  const request = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const secrets = [config.clientSecret, config.accessToken ?? '']

  let cached: ShopifyAccessToken | null = null
  let inFlight: Promise<ShopifyAccessToken> | null = null

  async function acquire(): Promise<ShopifyAccessToken> {
    // A pre-provisioned token skips the network entirely.
    if (config.accessToken) {
      return { accessToken: config.accessToken, scope: config.scopes.join(','), expiresAt: null }
    }

    let response: Response
    try {
      response = await request(`${baseUrl}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'client_credentials',
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    } catch (error) {
      throw new ShopifyTokenError(
        `Shopify token request failed before a response was received. ${redactSecrets(errorMessage(error), secrets)}`,
        { retryable: true },
      )
    }

    if (!response.ok) {
      const detail = redactSecrets(await response.text().catch(() => ''), secrets).trim().slice(0, MAX_ERROR_DETAIL_LENGTH)
      const retryable = response.status === 429 || response.status >= 500
      throw new ShopifyTokenError(
        `Shopify rejected the access-token request (${response.status}). ${detail}`.trimEnd(),
        { status: response.status, retryable },
      )
    }

    let payload: { access_token?: unknown; scope?: unknown; expires_in?: unknown }
    try {
      payload = await response.json() as typeof payload
    } catch {
      throw new ShopifyTokenError('Shopify returned a malformed access-token response.', { status: response.status })
    }

    const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
    if (!accessToken) {
      throw new ShopifyTokenError('Shopify returned an access-token response without an access_token.', {
        status: response.status,
      })
    }

    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : Number(payload.expires_in)
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : null
    return {
      accessToken,
      scope: typeof payload.scope === 'string' ? payload.scope : '',
      expiresAt,
    }
  }

  async function getToken(requestOptions: { forceRefresh?: boolean } = {}): Promise<ShopifyAccessToken> {
    if (!requestOptions.forceRefresh) {
      if (cached && isFresh(cached, now)) return cached
      if (inFlight) return inFlight
    }
    const pending = acquire()
      .then((token) => {
        cached = token
        return token
      })
      .finally(() => {
        if (inFlight === pending) inFlight = null
      })
    inFlight = pending
    return pending
  }

  return {
    getToken,
    getAccessToken: async (requestOptions) => (await getToken(requestOptions)).accessToken,
    invalidate: () => {
      cached = null
    },
  }
}

let defaultProvider: ShopifyTokenProvider | null = null

/**
 * Acquire an access token with the process-wide default provider. Constructed
 * lazily so applications that never call Shopify do not need its credentials.
 */
export function getShopifyAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
  defaultProvider ??= createShopifyTokenProvider()
  return defaultProvider.getAccessToken(options)
}

/** Drop the process-wide default provider and its cached token. */
export function resetShopifyTokenProvider(): void {
  defaultProvider = null
}
