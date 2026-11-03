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
  assert.equal((await app.request('/api/hello', { headers: { authorization } })).status, 200)
  assert.equal((await app.request('/api/hello', {
    headers: { authorization: `Basic ${Buffer.from('demo:wrong').toString('base64')}` },
  })).status, 401)
})

test('authenticated chat streams events and sets a Secure session cookie behind HTTPS termination', async () => {
  const app = createApp(undefined, { environment, agent: async (_input, emit) => {
    emit({ type: 'assistant_message', text: 'Demo response' })
  } })
  const response = await app.request('http://internal:8787/api/chat', {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  assert.match(response.headers.get('cache-control') ?? '', /no-cache/)
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
      method: 'POST', headers: { authorization, origin, 'content-type': 'application/json',
        cookie: `order_chat=${sessionId}`, 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ confirmed: true, approved: true }),
    })
    assert.equal((await request('https://attacker.example')).status, 403)
    assert.equal(executions, 0)
    assert.equal((await request('https://demo.example')).status, 200)
    assert.equal(executions, 1)
    assert.equal((await request('https://demo.example')).status, 200)
    assert.equal(executions, 1)
    const listing = await app.request('http://internal:8787/api/actions', { headers: { authorization } })
    assert.match(listing.headers.get('set-cookie') ?? '', /Secure/)
  } finally { store.close() }
})
