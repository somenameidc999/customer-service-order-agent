import { existsSync } from 'node:fs'

/**
 * Store domain used when `SHOPIFY_STORE_DOMAIN` is not set. The app has been
 * installed on this store, so the connector can work with only the client ID
 * and secret supplied through the environment.
 */
export const DEFAULT_SHOPIFY_STORE_DOMAIN = 'nate-ce.myshopify.com'

/** Pinned Admin API version; see docs/shopify-integration.md. */
export const DEFAULT_SHOPIFY_API_VERSION = '2025-01'

export class ShopifyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShopifyConfigError'
  }
}

export interface ShopifyConfig {
  storeDomain: string
  clientId: string
  clientSecret: string
  scopes: string[]
  apiVersion: string
  /** Pre-provisioned token from `SHOPIFY_ACCESS_TOKEN`, if one was supplied. */
  accessToken: string | null
}

let environmentLoaded = false

/**
 * Load `.env` once, if it exists, so `npm start`/`npm run dev` pick up the
 * Shopify app credentials without extra flags. Real process variables win over
 * file values, and a malformed file is ignored here: `loadShopifyConfig`
 * reports missing credentials with a clear message instead.
 */
function loadDotEnvOnce(): void {
  if (environmentLoaded) return
  environmentLoaded = true
  if (!existsSync('.env')) return
  try {
    process.loadEnvFile('.env')
  } catch {
    // Ignore; missing values surface through loadShopifyConfig below.
  }
}

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** Accept `nate-ce.myshopify.com`, `https://nate-ce.myshopify.com/`, etc. */
function normalizeStoreDomain(raw: string | undefined): string {
  const value = raw?.trim() ?? ''
  if (!value) return DEFAULT_SHOPIFY_STORE_DOMAIN
  const host = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '').split('/')[0]?.toLowerCase() ?? ''
  if (!HOSTNAME_PATTERN.test(host)) {
    throw new ShopifyConfigError(
      `SHOPIFY_STORE_DOMAIN must be a bare hostname such as ${DEFAULT_SHOPIFY_STORE_DOMAIN}.`,
    )
  }
  return host
}

function parseScopes(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0)
}

/**
 * Read the Shopify credentials from the environment (and `.env`, if present).
 * Throws a `ShopifyConfigError` when a required value is missing or malformed,
 * so callers fail with an actionable message instead of a confusing request error.
 */
export function loadShopifyConfig(env: NodeJS.ProcessEnv = process.env): ShopifyConfig {
  loadDotEnvOnce()

  const clientId = env.SHOPIFY_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.SHOPIFY_CLIENT_SECRET?.trim() ?? ''
  const missing: string[] = []
  if (!clientId) missing.push('SHOPIFY_CLIENT_ID')
  if (!clientSecret) missing.push('SHOPIFY_CLIENT_SECRET')
  if (missing.length > 0) {
    throw new ShopifyConfigError(
      `Shopify is not configured. Set ${missing.join(' and ')} in the environment (or .env).`,
    )
  }

  return {
    storeDomain: normalizeStoreDomain(env.SHOPIFY_STORE_DOMAIN),
    clientId,
    clientSecret,
    scopes: parseScopes(env.SHOPIFY_SCOPES),
    apiVersion: env.SHOPIFY_API_VERSION?.trim() || DEFAULT_SHOPIFY_API_VERSION,
    accessToken: env.SHOPIFY_ACCESS_TOKEN?.trim() || null,
  }
}

/** True when the required Shopify credentials are present. Never throws. */
export function hasShopifyConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadShopifyConfig(env)
    return true
  } catch {
    return false
  }
}
