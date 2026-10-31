import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  DEFAULT_SHOPIFY_API_VERSION,
  DEFAULT_SHOPIFY_STORE_DOMAIN,
  hasShopifyConfig,
  loadShopifyConfig,
  ShopifyConfigError,
  type ShopifyConfig,
} from './shopify/config.js'
import { createShopifyTokenProvider, ShopifyTokenError } from './shopify/token.js'

// This suite is offline: token acquisition runs against a local mock HTTP
// server so no live Shopify store or credential is ever contacted.

function baseConfig(overrides: Partial<ShopifyConfig> = {}): ShopifyConfig {
  return {
    storeDomain: 'nate-ce.myshopify.com',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    scopes: [],
    apiVersion: DEFAULT_SHOPIFY_API_VERSION,
    accessToken: null,
    ...overrides,
  }
}

interface RecordedRequest {
  url: string | undefined
  method: string | undefined
  headers: IncomingMessage['headers']
  body: string
}

type Handler = (request: IncomingMessage, response: ServerResponse, body: string, count: number) => void

async function startTokenServer(handler: Handler) {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ url: request.url, method: request.method, headers: request.headers, body })
      handler(request, response, body, requests.length)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('mock server did not bind a port')
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
}

test('Shopify config requires a client ID and secret with a clear message', () => {
  assert.throws(() => loadShopifyConfig({}), (error: Error) => {
    assert.ok(error instanceof ShopifyConfigError)
    assert.match(error.message, /SHOPIFY_CLIENT_ID/)
    assert.match(error.message, /SHOPIFY_CLIENT_SECRET/)
    return true
  })
  assert.equal(hasShopifyConfig({}), false)
})

test('Shopify config defaults to the nate-ce store and pinned API version', () => {
  const config = loadShopifyConfig({ SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' })
  assert.equal(config.storeDomain, DEFAULT_SHOPIFY_STORE_DOMAIN)
  assert.equal(config.apiVersion, DEFAULT_SHOPIFY_API_VERSION)
  assert.equal(config.accessToken, null)
  assert.deepEqual(config.scopes, [])
  assert.equal(hasShopifyConfig({ SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' }), true)
})

test('Shopify config normalizes a domain and reads scopes, version and cached token', () => {
  const config = loadShopifyConfig({
    SHOPIFY_CLIENT_ID: ' id ',
    SHOPIFY_CLIENT_SECRET: ' secret ',
    SHOPIFY_STORE_DOMAIN: 'https://Nate-Ce.myshopify.com/',
    SHOPIFY_SCOPES: 'read_orders, write_orders ,',
    SHOPIFY_API_VERSION: '2025-04',
    SHOPIFY_ACCESS_TOKEN: 'shpat_cached',
  })
  assert.equal(config.storeDomain, 'nate-ce.myshopify.com')
  assert.equal(config.clientId, 'id')
  assert.equal(config.clientSecret, 'secret')
  assert.deepEqual(config.scopes, ['read_orders', 'write_orders'])
  assert.equal(config.apiVersion, '2025-04')
  assert.equal(config.accessToken, 'shpat_cached')
})

test('Shopify config rejects a malformed store domain', () => {
  assert.throws(
    () => loadShopifyConfig({ SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret', SHOPIFY_STORE_DOMAIN: 'https://' }),
    /SHOPIFY_STORE_DOMAIN/,
  )
  assert.throws(
    () => loadShopifyConfig({ SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret', SHOPIFY_STORE_DOMAIN: 'not a host' }),
    /SHOPIFY_STORE_DOMAIN/,
  )
})

test('acquires an access token with the client credentials grant', async () => {
  const server = await startTokenServer((_request, response) => {
    sendJson(response, 200, { access_token: 'shpat_live', scope: 'read_orders', expires_in: 86399 })
  })
  try {
    const provider = createShopifyTokenProvider({ config: baseConfig(), baseUrl: server.baseUrl })
    const token = await provider.getToken()

    assert.deepEqual(token.accessToken, 'shpat_live')
    assert.equal(token.scope, 'read_orders')
    assert.ok(typeof token.expiresAt === 'number' && token.expiresAt > Date.now())

    assert.equal(server.requests.length, 1)
    const sent = server.requests[0]!
    assert.equal(sent.method, 'POST')
    assert.equal(sent.url, '/admin/oauth/access_token')
    assert.match(String(sent.headers['content-type'] ?? ''), /application\/json/)
    assert.deepEqual(JSON.parse(sent.body), {
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      grant_type: 'client_credentials',
    })
  } finally {
    await server.close()
  }
})

test('caches a fresh token and only refreshes it before expiry', async () => {
  const server = await startTokenServer((_request, response, _body, count) => {
    sendJson(response, 200, { access_token: `shpat_${count}`, scope: 'read_orders', expires_in: 3600 })
  })
  let clock = 1_000_000
  try {
    const provider = createShopifyTokenProvider({
      config: baseConfig(),
      baseUrl: server.baseUrl,
      now: () => clock,
    })

    assert.equal(await provider.getAccessToken(), 'shpat_1')
    assert.equal(await provider.getAccessToken(), 'shpat_1')
    assert.equal(server.requests.length, 1, 'a fresh cached token avoids a second request')

    // Advance to inside the refresh skew window; the provider must re-acquire.
    clock += 3600 * 1000 - 30_000
    assert.equal(await provider.getAccessToken(), 'shpat_2')
    assert.equal(server.requests.length, 2)

    assert.equal(await provider.getAccessToken({ forceRefresh: true }), 'shpat_3')
    assert.equal(server.requests.length, 3)

    provider.invalidate()
    assert.equal(await provider.getAccessToken(), 'shpat_4')
    assert.equal(server.requests.length, 4)
  } finally {
    await server.close()
  }
})

test('concurrent first calls share a single token request', async () => {
  const server = await startTokenServer((_request, response) => {
    setTimeout(() => sendJson(response, 200, { access_token: 'shpat_shared', scope: '', expires_in: 3600 }), 20)
  })
  try {
    const provider = createShopifyTokenProvider({ config: baseConfig(), baseUrl: server.baseUrl })
    const [first, second] = await Promise.all([provider.getAccessToken(), provider.getAccessToken()])
    assert.equal(first, 'shpat_shared')
    assert.equal(second, 'shpat_shared')
    assert.equal(server.requests.length, 1)
  } finally {
    await server.close()
  }
})

test('a rejected credential surfaces a redacted, non-retryable error', async () => {
  const server = await startTokenServer((_request, response) => {
    sendJson(response, 401, { error: 'invalid', error_description: 'bad secret test-client-secret' })
  })
  try {
    const provider = createShopifyTokenProvider({ config: baseConfig(), baseUrl: server.baseUrl })
    await assert.rejects(provider.getAccessToken(), (error: Error) => {
      assert.ok(error instanceof ShopifyTokenError)
      assert.equal(error.status, 401)
      assert.equal(error.retryable, false)
      assert.match(error.message, /401/)
      assert.doesNotMatch(error.message, /test-client-secret/)
      assert.match(error.message, /\[redacted\]/)
      return true
    })
  } finally {
    await server.close()
  }
})

test('a Shopify 5xx is reported as retryable', async () => {
  const server = await startTokenServer((_request, response) => {
    sendJson(response, 503, { error: 'service_unavailable' })
  })
  try {
    const provider = createShopifyTokenProvider({ config: baseConfig(), baseUrl: server.baseUrl })
    await assert.rejects(provider.getAccessToken(), (error: Error) => {
      assert.ok(error instanceof ShopifyTokenError)
      assert.equal(error.status, 503)
      assert.equal(error.retryable, true)
      return true
    })
  } finally {
    await server.close()
  }
})

test('a network failure is reported as retryable without leaking secrets', async () => {
  const server = await startTokenServer(() => {})
  const { baseUrl } = server
  await server.close()
  const provider = createShopifyTokenProvider({ config: baseConfig(), baseUrl })
  await assert.rejects(provider.getAccessToken(), (error: Error) => {
    assert.ok(error instanceof ShopifyTokenError)
    assert.equal(error.retryable, true)
    assert.doesNotMatch(error.message, /test-client-secret/)
    return true
  })
})

test('a response without an access_token is rejected', async () => {
  const server = await startTokenServer((_request, response) => {
    sendJson(response, 200, { scope: 'read_orders' })
  })
  try {
    const provider = createShopifyTokenProvider({ config: baseConfig(), baseUrl: server.baseUrl })
    await assert.rejects(provider.getAccessToken(), /access_token/)
  } finally {
    await server.close()
  }
})

test('a pre-provisioned SHOPIFY_ACCESS_TOKEN skips the network', async () => {
  let called = 0
  const provider = createShopifyTokenProvider({
    config: baseConfig({ accessToken: 'shpat_static' }),
    fetch: async () => { called += 1; throw new Error('network should not be used') },
  })
  assert.equal(await provider.getAccessToken(), 'shpat_static')
  assert.equal(await provider.getToken().then((token) => token.expiresAt), null)
  assert.equal(called, 0)
})
