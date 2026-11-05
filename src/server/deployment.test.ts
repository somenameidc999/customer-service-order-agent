import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from './app.js'
import { loadDeploymentConfig } from './deployment.js'
import { ShopifyActionStore } from './shopify/actions.js'

const environment = {
  DEMO_AUTH_REQUIRED: 'true',
  DEMO_PASSWORD: 'test-only-password',
  PUBLIC_ORIGIN: 'https://demo.example',
}
const authorization = `Basic ${Buffer.from('demo:test-only-password').toString('base64')}`
const proxiedHeaders = { authorization, host: 'demo.example' }

test('shared demo fails at startup when required configuration is missing or invalid', () => {
  for (const invalid of [
    { ...environment, DEMO_PASSWORD: undefined },
    { ...environment, DEMO_PASSWORD: ' ' },
    { ...environment, PUBLIC_ORIGIN: undefined },
    { ...environment, PUBLIC_ORIGIN: 'http://demo.example' },
    { ...environment, PUBLIC_ORIGIN: 'https://demo.example/path' },
    { ...environment, PUBLIC_ORIGIN: 'https://user:password@demo.example' },
    { ...environment, PUBLIC_ORIGIN: 'https://demo.example?query=true' },
    { ...environment, PUBLIC_ORIGIN: 'invalid' },
    { ...environment, DEMO_AUTH_REQUIRED: 'yes' },
    { ...environment, DEMO_USERNAME: 'demo:admin' },
  ]) assert.throws(() => createApp(undefined, { environment: invalid }))
  assert.deepEqual(loadDeploymentConfig({}), { publicOrigin: undefined, credentials: undefined })
})

test('shared demo protects pages, assets, chat, actions, and unknown routes; health stays public', async () => {
  let turns = 0
  const app = createApp(undefined, { environment, agent: async () => { turns++ } })
  for (const [method, path] of [
    ['GET', '/'], ['GET', '/assets/app.js'], ['GET', '/api/hello'],
    ['POST', '/api/chat'], ['GET', '/api/actions'], ['GET', '/api/demo-orders'],
    ['POST', '/api/actions/id/confirm'], ['GET', '/missing'],
    ['POST', '/api/health'], ['GET', '/api/health/'],
  ]) {
    const response = await app.request(path!, { method })
    assert.equal(response.status, 401, `${method} ${path}`)
    assert.match(response.headers.get('www-authenticate') ?? '', /^Basic /)
  }
  assert.equal(turns, 0)
  assert.equal((await app.request('/api/health')).status, 200)
  assert.equal((await app.request('/api/hello', { headers: proxiedHeaders })).status, 200)
  assert.equal((await app.request('/api/hello', {
    headers: { authorization: `Basic ${Buffer.from('demo:wrong').toString('base64')}` },
  })).status, 401)
})

test('the authenticated demo order route discovers orders when only the demo store is configured', async () => {
  const stores: string[] = []
  const demoOrders = { listDemoOrders: async (store: string) => { stores.push(store); return [] } }
  const enabled = { ...environment, DEMO_ORDER_STORE_DOMAIN: ' demo-store.myshopify.com ' }
  const app = createApp(undefined, { environment: enabled, demoOrders })
  assert.equal((await app.request('/api/demo-orders')).status, 401)

  const response = await app.request('/api/demo-orders', { headers: proxiedHeaders })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { orders: [] })
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  assert.deepEqual(stores, ['demo-store.myshopify.com'])

  const local = createApp(undefined, { environment: { DEMO_ORDER_STORE_DOMAIN: enabled.DEMO_ORDER_STORE_DOMAIN }, demoOrders })
  const unconfigured = createApp(undefined, { environment, demoOrders })
  assert.deepEqual(await (await local.request('http://localhost/api/demo-orders')).json(), { orders: [] })
  assert.deepEqual(await (await unconfigured.request('/api/demo-orders', { headers: proxiedHeaders })).json(), { orders: [] })
  assert.deepEqual(stores, ['demo-store.myshopify.com'])
})

test('authenticated chat streams events and sets a Secure session cookie behind HTTPS termination', async () => {
  const app = createApp(undefined, { environment, agent: async (_input, emit) => {
    emit({ type: 'assistant_message', text: 'Demo response' })
  } })
  const response = await app.request('http://internal:8787/api/chat', {
    method: 'POST', headers: { ...proxiedHeaders, origin: 'https://demo.example', 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  const cookie = response.headers.get('set-cookie') ?? ''
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/api']) assert.ok(cookie.includes(attribute))
  assert.match(await response.text(), /Demo response/)
})

test('action confirmation uses the configured public origin and ignores forged proxy headers', async () => {
  const store = new ShopifyActionStore(':memory:')
  try {
    const sessionId = 'a'.repeat(64)
    const proposal = store.prepare({
      sessionId, storeDomain: 'test.myshopify.com', orderId: 'order', customerId: 'customer', updatedAt: 'v1',
      payload: { kind: 'cancel_order', reason: 'CUSTOMER', notifyCustomer: false },
      title: 'Cancel order', details: [], orderName: '#1001',
    })
    let executions = 0
    const app = createApp(undefined, { environment, actions: { store, client: () => ({
      executeAction: async () => { executions++; return { status: 'succeeded' as const } },
      checkAction: async () => ({ status: 'succeeded' as const }),
    }) } })
    const request = (origin: string) => app.request(`http://internal:8787/api/actions/${proposal.id}/confirm`, {
      method: 'POST', headers: { ...proxiedHeaders, origin, 'content-type': 'application/json',
        cookie: `order_chat=${sessionId}`, 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ confirmed: true, approved: true }),
    })
    assert.equal((await request('https://attacker.example')).status, 403)
    assert.equal(executions, 0)
    assert.equal((await request('https://demo.example')).status, 200)
    assert.equal(executions, 1)
    assert.equal((await request('https://demo.example')).status, 200)
    assert.equal(executions, 1)
    const listing = await app.request('http://internal:8787/api/actions', { headers: proxiedHeaders })
    assert.match(listing.headers.get('set-cookie') ?? '', /Secure/)
  } finally { store.close() }
})

test('Fly and loopback API guards reject untrusted hosts, origins and non-JSON chat before dispatch', async () => {
  let turns = 0
  const agent = async () => { turns++ }
  const app = createApp(undefined, { environment, agent })
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
  const request = (headers: Record<string, string>) => app.request('http://internal:8787/api/chat', {
    method: 'POST',
    headers: { ...proxiedHeaders, 'content-type': 'application/json', ...headers },
    body,
  })
  assert.equal((await request({ host: 'other.example', origin: 'https://other.example' })).status, 403)
  assert.equal((await request({ origin: 'https://other.example', 'x-forwarded-host': 'other.example' })).status, 403)
  assert.equal((await request({ origin: 'null' })).status, 403)
  assert.equal((await request({ 'content-type': 'text/plain' })).status, 415)
  assert.equal((await request({ 'content-type': 'application/json-other' })).status, 415)
  const local = createApp(undefined, { environment: {}, agent })
  assert.equal((await local.request('http://other.example/api/chat', {
    method: 'POST', headers: { origin: 'http://other.example', 'content-type': 'application/json' }, body,
  })).status, 403)
  assert.equal(turns, 0)
  const accepted = await local.request('http://127.0.0.1:5173/api/chat', {
    method: 'POST', headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json; charset=utf-8' }, body,
  })
  assert.equal(accepted.status, 200)
  await accepted.text()
  assert.equal(turns, 1)
})
