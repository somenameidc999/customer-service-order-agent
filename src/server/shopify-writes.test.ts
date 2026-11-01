import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from './app.js'
import { createAgentTurn } from './agent/agent.js'
import { createCommerceToolRegistry } from './agent/tools.js'
import type { AgentEvent } from '../shared/chat.js'
import { createShopifyLiveClient } from './shopify/live-client.js'
import { ShopifyActionStore, ActionError } from './shopify/actions.js'
import type { PendingShopifyAction, ShippingAddress } from '../shared/actions.js'
import type { ShopifyConfig } from './shopify/config.js'
import type { FetchLike } from './shopify/token.js'
import { moneyUnits, moneyString } from './shopify/money.js'

const config: ShopifyConfig = { storeDomain: 'test.myshopify.com', clientId: 'test-id', clientSecret: 'test-secret',
  accessToken: 'test-token', scopes: [], apiVersion: '2026-10' }
const address: ShippingAddress = { address1: '123 New Street', city: 'Portland', provinceCode: 'OR', zip: '97201', countryCode: 'US' }
const contact = { id: 'gid://shopify/Customer/42', firstName: 'Test', lastName: 'Customer', defaultEmailAddress: { emailAddress: 'owner@example.com' }, defaultPhoneNumber: null }

function harness() {
  const calls: Array<{ query: string; variables: Record<string, any> }> = []
  const state = {
    id: 'gid://shopify/Order/42', name: '#42', email: 'owner@example.com', phone: null, customer: contact,
    updatedAt: '2026-10-30T12:00:00Z', createdAt: '2026-10-01T12:00:00Z', cancelledAt: null as string | null,
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', presentmentCurrencyCode: 'USD',
    totalPriceSet: { shopMoney: { amount: '25.00', currencyCode: 'USD' } },
    shippingAddress: { address1: '1 Old Street', address2: '', city: 'Seattle', zip: '98101', provinceCode: 'WA', countryCodeV2: 'US', firstName: 'Test', lastName: 'Customer', formatted: ['1 Old Street'] },
    lineItems: { nodes: [], pageInfo: { hasNextPage: false } }, refunds: [] as any[],
    suggestedRefund: { maximumRefundableSet: { presentmentMoney: { amount: '25.00', currencyCode: 'USD' } },
      suggestedTransactions: [
        { kind: 'SUGGESTED_REFUND', gateway: 'bogus', parentTransaction: { id: 'transaction-1' }, maximumRefundableSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } }, amountSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } } },
        { kind: 'SUGGESTED_REFUND', gateway: 'bogus', parentTransaction: { id: 'transaction-2' }, maximumRefundableSet: { presentmentMoney: { amount: '15.00', currencyCode: 'USD' } }, amountSet: { presentmentMoney: { amount: '15.00', currencyCode: 'USD' } } },
      ] },
  }
  let mutationError: 'network' | 'user' | 'malformed' | 'payment' | null = null
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    calls.push(body)
    if (body.query.startsWith('mutation ')) {
      if (mutationError === 'network') throw new Error('timeout')
      if (mutationError === 'malformed') return Response.json({ data: {} })
      if (body.query.includes('refundCreate')) {
        if (mutationError === 'user') return Response.json({ data: { refundCreate: { refund: null, userErrors: [{ message: 'Not refundable test-secret test-token' }] } } })
        const record = { id: 'gid://shopify/Refund/101', note: body.variables.input.note, createdAt: '2026-10-31T12:00:00Z',
          totalRefundedSet: { shopMoney: { amount: '12.34', currencyCode: 'USD' }, presentmentMoney: { amount: '12.34', currencyCode: 'USD' } },
          transactions: { nodes: [{ status: mutationError === 'payment' ? 'PENDING' : 'SUCCESS' }] } }
        state.refunds.push(record)
        state.updatedAt = '2026-10-31T12:01:00Z'
        return Response.json({ data: { refundCreate: { refund: record, userErrors: [] } } })
      }
      if (body.query.includes('orderUpdate')) {
        const { countryCode, ...fields } = body.variables.input.shippingAddress
        state.shippingAddress = { ...state.shippingAddress, ...fields, countryCodeV2: countryCode }
        return Response.json({ data: { orderUpdate: { order: state, userErrors: [] } } })
      }
      state.cancelledAt = '2026-10-31T12:01:00Z'
      return Response.json({ data: { orderCancel: { job: { id: 'job-42', done: true }, orderCancelUserErrors: [], userErrors: [] } } })
    }
    return Response.json({ data: body.query.includes('query OrderByNumber')
      ? { orders: { nodes: [state], pageInfo: { hasNextPage: false } } } : { order: state } })
  }
  const store = new ShopifyActionStore(':memory:')
  const client = createShopifyLiveClient({ config, fetch, sessionId: 'session-1', actions: store })
  const verify = () => client.findCustomer({ orderNumber: '#42', email: 'owner@example.com' })
  const app = createApp(undefined, { actions: { store, client: (sessionId) => createShopifyLiveClient({ config, fetch, sessionId }) } })
  return { state, calls, store, client, verify, app, fetch, setError: (value: typeof mutationError) => { mutationError = value } }
}

test('money arithmetic is exact and uses the currency minor unit', () => {
  assert.equal(moneyUnits('0.10', 'USD') + moneyUnits('0.20', 'USD'), 30n)
  assert.equal(moneyString(30n, 'USD'), '0.30')
  assert.equal(moneyUnits('1.234', 'KWD'), 1234n)
  assert.equal(moneyString(50n, 'JPY'), '50')
  assert.throws(() => moneyUnits('1.234', 'USD'))
  assert.throws(() => moneyUnits('-1', 'USD'))
  assert.throws(() => moneyUnits('1e5', 'USD'))
})

test('refunds only propose; the server allocates exact amounts to real parent payments', async () => {
  const h = harness()
  try {
    await h.verify()
    const proposal = await h.client.createRefund({ orderId: h.state.id, amount: '12.34', currency: '', reason: 'Requested by customer', confirmationToken: 'forged', idempotencyKey: 'forged' }) as PendingShopifyAction
    assert.equal(h.calls.filter((call) => call.query.startsWith('mutation ')).length, 0)
    const saved = h.store.get(proposal.pendingAction.id, 'session-1')
    assert.equal(saved.payload.kind, 'refund')
    assert.deepEqual(saved.payload.kind === 'refund' && saved.payload.transactions.map((entry) => entry.amount), ['10.00','2.34'])
    assert.equal(proposal.pendingAction.requiresApproval, true)
    const claimed = h.store.claim(saved.id, 'session-1', true)
    const outcome = await h.client.executeAction(claimed)
    assert.equal(outcome.status, 'succeeded')
    const mutation = h.calls.find((call) => call.query.includes('refundCreate'))!
    assert.match(mutation.query, /@idempotent\(key: \$key\)/)
    assert.equal(mutation.variables.key, saved.id)
    assert.equal(mutation.variables.input.allowOverRefunding, false)
    assert.equal(mutation.variables.input.notify, false)
    assert.equal(mutation.variables.input.currency, 'USD')
    assert.deepEqual(mutation.variables.input.transactions.map((entry: { parentId: string }) => entry.parentId), ['transaction-1','transaction-2'])
    assert.equal((await h.client.checkAction(claimed)).status, 'succeeded')
  } finally { h.store.close() }
})

test('the authorized agent prepares a refund card without executing the write', async () => {
  const h = harness()
  try {
    let round = 0
    const events: AgentEvent[] = []
    const turn = createAgentTurn({ tools: createCommerceToolRegistry(h.client), llm: {
      complete: async ({ messages }) => {
        assert.match(messages[0]?.content ?? '', /Preparing a proposal does not execute the write/)
        const call = round++ === 0
          ? { id: 'identify', name: 'findCustomer', argumentsText: JSON.stringify({ orderNumber: '#42', email: 'owner@example.com' }) }
          : round === 2 ? { id: 'refund', name: 'createRefund', argumentsText: JSON.stringify({ orderId: h.state.id, amount: '12.34', reason: 'Customer requested refund' }) } : null
        return { content: call ? null : 'Review the confirmation card.', toolCalls: call ? [call] : [] }
      },
    } })
    await turn({ sessionId: 'session-1', messages: [{ id: 'request', role: 'user', content: 'Refund order #42. My email is owner@example.com.', createdAt: new Date().toISOString() }] }, (event) => events.push(event))
    const confirmation = events.find((event) => event.type === 'confirmation')
    assert.equal(confirmation?.type === 'confirmation' && confirmation.action.kind, 'refund')
    assert.equal(confirmation?.type === 'confirmation' && confirmation.action.status, 'pending')
    assert.equal(h.calls.filter((call) => call.query.startsWith('mutation ')).length, 0)
    assert.ok(events.some((event) => event.type === 'tool_call' && event.name === 'createRefund' && event.phase === 'end' && event.ok))
  } finally { h.store.close() }
})

test('full refunds are computed by Shopify; excess, wrong-currency, and zero refunds are rejected', async () => {
  const h = harness()
  try {
    await h.verify()
    const full = await h.client.createRefund({ orderId: h.state.id, currency: '', reason: 'Full refund' }) as PendingShopifyAction
    assert.match(full.pendingAction.title, /25.00 USD/)
    for (const [amount, currency] of [['25.01','USD'],['12.00','CAD'],['0','USD'],['-1','USD']]) {
      await assert.rejects(h.client.createRefund({ orderId: h.state.id, amount, currency, reason: 'Invalid request' }))
    }
    assert.equal(h.calls.filter((call) => call.query.startsWith('mutation ')).length, 0)
  } finally { h.store.close() }
})

test('address changes and cancellations submit real Shopify mutations only after confirmation', async () => {
  for (const kind of ['shipping_address','cancel_order']) {
    const h = harness()
    try {
      await h.verify()
      const result = (kind === 'shipping_address'
        ? await h.client.updateShippingAddress({ orderId: h.state.id, address })
        : await h.client.cancelOrder({ orderId: h.state.id, reason: 'CUSTOMER' })) as PendingShopifyAction
      assert.equal(h.calls.filter((call) => call.query.startsWith('mutation ')).length, 0)
      const action = h.store.claim(result.pendingAction.id, 'session-1', true)
      const outcome = await h.client.executeAction(action)
      assert.equal(outcome.status, kind === 'shipping_address' ? 'succeeded' : 'processing')
      const mutation = h.calls.find((call) => call.query.startsWith('mutation '))!
      if (kind === 'shipping_address') {
        assert.deepEqual(mutation.variables.input.shippingAddress, { firstName: 'Test', lastName: 'Customer', address2: '', ...address })
        assert.equal(h.state.shippingAddress.city, 'Portland')
      } else {
        assert.match(mutation.query, /originalPaymentMethodsRefund: false/)
        assert.match(mutation.query, /restock: true/)
        assert.equal((await h.client.checkAction(action)).status, 'succeeded')
      }
    } finally { h.store.close() }
  }
})

test('stale orders, changed owners, and fulfilled orders cannot be modified', async () => {
  const h = harness()
  try {
    await h.verify()
    const proposal = await h.client.updateShippingAddress({ orderId: h.state.id, address }) as PendingShopifyAction
    const action = h.store.claim(proposal.pendingAction.id, 'session-1', false)
    h.state.updatedAt = '2026-10-31T12:01:00Z'
    await assert.rejects(h.client.executeAction(action), /order changed/)
    h.state.customer = { ...contact, id: 'other-customer' }
    await assert.rejects(h.client.executeAction(action), /owner changed/)
    h.state.customer = contact
    h.state.displayFulfillmentStatus = 'FULFILLED'
    await assert.rejects(h.client.updateShippingAddress({ orderId: h.state.id, address }), /unfulfilled/)
    await assert.rejects(h.client.cancelOrder({ orderId: h.state.id, reason: 'CUSTOMER' }), /unfulfilled/)
    assert.equal(h.calls.filter((call) => call.query.startsWith('mutation ')).length, 0)
  } finally { h.store.close() }
})

test('the confirmation route rejects forged sessions, missing approval, cross-origin requests, and duplicate execution', async () => {
  const h = harness()
  const session = 'a'.repeat(64)
  try {
    await h.verify()
    const proposal = await h.client.createRefund({ orderId: h.state.id, amount: '12.34', currency: 'USD', reason: 'Confirmed refund' }) as PendingShopifyAction
    const original = h.store.get(proposal.pendingAction.id, 'session-1')
    const view = h.store.prepare({ ...original, sessionId: session, title: original.view.title, details: original.view.details, orderName: '#42' })
    const url = `/api/actions/${view.id}/confirm`
    const request = (body: unknown, cookie = session, origin?: string) => h.app.request(url, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `order_chat=${cookie}`, ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
    })
    assert.equal((await request({ confirmed: true, approved: true }, 'b'.repeat(64))).status, 404)
    assert.equal((await request({ confirmed: true })).status, 400)
    assert.equal((await request({ confirmed: true, approved: true }, session, 'https://unrelated.example')).status, 403)
    assert.equal((await request({ confirmed: false, approved: true })).status, 400)
    const [first, second] = await Promise.all([request({ confirmed: true, approved: true, amount: '99999' }), request({ confirmed: true, approved: true })])
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(h.calls.filter((call) => call.query.includes('refundCreate')).length, 1)
    const replay = await request({ confirmed: true, approved: true })
    assert.equal((await replay.json() as any).action.status, 'succeeded')
    assert.equal(h.calls.filter((call) => call.query.includes('refundCreate')).length, 1)
  } finally { h.store.close() }
})

test('payment pending, user errors, and uncertain mutations report their real outcomes', async () => {
  for (const mode of ['network','user','malformed','payment'] as const) {
    const h = harness()
    try {
      await h.verify()
      const proposal = await h.client.createRefund({ orderId: h.state.id, amount: '12.34', currency: 'USD', reason: mode }) as PendingShopifyAction
      const action = h.store.claim(proposal.pendingAction.id, 'session-1', true)
      h.setError(mode)
      if (mode === 'payment') assert.equal((await h.client.executeAction(action)).status, 'processing')
      else await assert.rejects(h.client.executeAction(action), (error: Error & { code?: string }) => {
        assert.equal(error.code, mode === 'user' ? 'INVALID_INPUT' : 'OUTCOME_UNKNOWN')
        assert.doesNotMatch(error.message, /test-secret|test-token/)
        return true
      })
      assert.equal(h.calls.filter((call) => call.query.includes('refundCreate')).length, 1)
    } finally { h.store.close() }
  }
})

test('a chat proposal is bound to the server cookie and executes through its confirmation endpoint', async () => {
  const h = harness()
  const app = createApp(undefined, {
    agent: async (input, emit) => {
      const client = createShopifyLiveClient({ config, fetch: h.fetch, actions: h.store, sessionId: input.sessionId })
      await client.findCustomer({ orderNumber: '#42', email: 'owner@example.com' })
      const proposal = await client.createRefund({ orderId: h.state.id, amount: '12.34', currency: '', reason: 'User requested refund' }) as PendingShopifyAction
      emit({ type: 'confirmation', action: proposal.pendingAction })
      emit({ type: 'assistant_message', text: 'Review the refund and confirm its exact details.' })
    },
    actions: { store: h.store, client: (sessionId) => createShopifyLiveClient({ config, fetch: h.fetch, sessionId }) },
  })
  try {
    const response = await app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Refund order #42. My email is owner@example.com.' }], sessionId: 'forged-session' }) })
    const cookie = response.headers.get('set-cookie')!.split(';')[0]
    assert.match(cookie, /^order_chat=[a-f0-9]{64}$/)
    const events = (await response.text()).split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.slice(6)))
    const proposal = events.find((event) => event.type === 'confirmation').action
    assert.equal(h.calls.filter((call) => call.query.startsWith('mutation ')).length, 0)
    const list = await app.request('/api/actions', { headers: { cookie } })
    assert.equal((await list.json() as any).actions[0].id, proposal.id)
    const confirmed = await app.request(`/api/actions/${proposal.id}/confirm`, { method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify({ confirmed: true, approved: true }) })
    assert.equal(confirmed.status, 200)
    assert.equal((await confirmed.json() as any).action.status, 'succeeded')
    assert.equal(h.calls.filter((call) => call.query.includes('refundCreate')).length, 1)
  } finally { h.store.close() }
})

test('the action journal persists confirmations and prevents retry after an uncertain outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shopify-actions-'))
  const file = join(directory, 'actions.sqlite')
  let store = new ShopifyActionStore(file)
  try {
    const input = { sessionId: 'owner', storeDomain: config.storeDomain, orderId: 'order', customerId: 'customer', updatedAt: 'v1',
      payload: { kind: 'cancel_order' as const, reason: 'CUSTOMER', notifyCustomer: false }, title: 'Cancel', details: ['Order #42'], orderName: '#42' }
    const proposal = store.prepare(input)
    assert.equal(store.prepare(input).id, proposal.id)
    assert.throws(() => store.claim(proposal.id, 'other', true), ActionError)
    assert.throws(() => store.claim(proposal.id, 'owner', false), /Approve/)
    store.claim(proposal.id, 'owner', true)
    store.close()
    store = new ShopifyActionStore(file)
    assert.equal(store.get(proposal.id, 'owner').view.status, 'executing')
    assert.throws(() => store.claim(proposal.id, 'owner', true), /already been confirmed/)
    const next = store.prepare({ ...input, updatedAt: 'v2' })
    assert.throws(() => store.claim(next.id, 'owner', true), /earlier action/)
  } finally { store.close(); await rm(directory, { recursive: true, force: true }) }
})

test('expired and dismissed proposals cannot be confirmed', () => {
  let now = 1000
  const store = new ShopifyActionStore(':memory:', () => now)
  try {
    const input = { sessionId: 'owner', storeDomain: config.storeDomain, orderId: 'order', customerId: 'customer', updatedAt: 'v1',
      payload: { kind: 'cancel_order' as const, reason: 'CUSTOMER', notifyCustomer: false }, title: 'Cancel', details: [], orderName: '#42' }
    const proposal = store.prepare(input)
    now += 16 * 60 * 1000
    assert.throws(() => store.claim(proposal.id, 'owner', true), /no longer available/)
    assert.notEqual(store.prepare(input).id, proposal.id, 'an expired quote can be proposed again without losing its audit history')
    const next = store.prepare({ ...input, updatedAt: 'v2' })
    store.cancel(next.id, 'owner')
    assert.throws(() => store.claim(next.id, 'owner', true), /no longer available/)
  } finally { store.close() }
})
