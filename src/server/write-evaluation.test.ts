import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShopifyActionStore } from './shopify/actions.js'
import { createShopifyWrites } from './shopify/write-client.js'
import { createShopifyLiveClient } from './shopify/live-client.js'
import type { PendingShopifyAction } from '../shared/actions.js'
import type { ShopifyConfig } from './shopify/config.js'

const config: ShopifyConfig = { storeDomain: 'evaluation.myshopify.com', clientId: 'evaluation', clientSecret: 'secret', accessToken: 'token', scopes: [], apiVersion: '2026-10' }
const input = { sessionId: 'owner', storeDomain: config.storeDomain, orderId: 'order', customerId: 'customer', updatedAt: 'v1',
  payload: { kind: 'cancel_order' as const, reason: 'CUSTOMER', notifyCustomer: false }, title: 'Cancel order', details: [], orderName: '#1001' }

test('evaluation: revised proposals retire previous consent and identical proposals deduplicate', () => {
  const store = new ShopifyActionStore(':memory:')
  try {
    const first = store.prepare(input)
    assert.equal(store.prepare(input).id, first.id)
    const otherSession = store.prepare({ ...input, sessionId: 'other' })
    const second = store.prepare({ ...input, payload: { ...input.payload, reason: 'OTHER' } })
    assert.equal(store.get(first.id, 'owner').view.status, 'cancelled')
    assert.throws(() => store.claim(first.id, 'owner', true), /no longer available/)
    assert.equal(store.get(otherSession.id, 'other').view.status, 'pending')
    assert.deepEqual(store.cancelPending('owner').map((action) => action.id), [second.id])
    assert.throws(() => store.claim(second.id, 'owner', true), /no longer available/)
  } finally { store.close() }
})

test('evaluation: revocation never erases an executing write', () => {
  const store = new ShopifyActionStore(':memory:')
  try {
    const proposed = store.prepare(input)
    const executing = store.claim(proposed.id, 'owner', true)
    assert.deepEqual(store.cancelPending('owner'), [])
    assert.equal(store.get(executing.id, 'owner').view.status, 'executing')
  } finally { store.close() }
})

test('evaluation: a late status result cannot regress a durable completed action', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-write-evaluation-'))
  let store = new ShopifyActionStore(join(directory, 'actions.sqlite'))
  try {
    const proposal = store.prepare(input)
    const executing = store.claim(proposal.id, 'owner', true)
    store.finish(executing, 'succeeded', { shopifyId: 'shopify-result', message: 'Confirmed' })
    assert.equal(store.finish(executing, 'unknown').view.status, 'succeeded')
    store.close()
    store = new ShopifyActionStore(join(directory, 'actions.sqlite'))
    assert.equal(store.get(proposal.id, 'owner').view.result?.shopifyId, 'shopify-result')
    assert.throws(() => store.claim(proposal.id, 'owner', true), /already been confirmed/)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

function writeHarness() {
  const store = new ShopifyActionStore(':memory:')
  const raw = { id: 'order', name: '#1001', updatedAt: 'v1', createdAt: new Date().toISOString(), cancelledAt: null as string | null,
    customer: { id: 'customer' }, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', presentmentCurrencyCode: 'USD',
    shippingAddress: null, refunds: [] as any[], suggestedRefund: {
      maximumRefundableSet: { presentmentMoney: { amount: '25.00', currencyCode: 'USD' } },
      suggestedTransactions: [{ kind: 'SUGGESTED_REFUND', gateway: 'test', parentTransaction: { id: 'payment' },
        maximumRefundableSet: { presentmentMoney: { amount: '25.00', currencyCode: 'USD' } }, amountSet: { presentmentMoney: { amount: '25.00', currencyCode: 'USD' } } }],
    } }
  const mutations: string[] = []
  let paymentStatuses = ['SUCCESS']
  const writes = createShopifyWrites({ config: () => config, actions: store, sessionId: 'owner', requireOrder: () => 'customer',
    query: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
      if (!query.startsWith('mutation ')) return { order: raw } as T
      mutations.push(query)
      raw.updatedAt += '+'
      if (query.includes('refundCreate')) {
        const refundInput = variables.input as { note: string }
        raw.refunds.push({ id: 'refund', note: refundInput.note, totalRefundedSet: { presentmentMoney: { amount: '25.00', currencyCode: 'USD' } }, transactions: { nodes: paymentStatuses.map((status) => ({ status })) } })
        raw.displayFinancialStatus = 'REFUNDED'
        return { refundCreate: { refund: raw.refunds.at(-1), userErrors: [] } } as T
      }
      raw.cancelledAt = new Date().toISOString()
      return { orderCancel: { job: { id: 'job', done: true }, userErrors: [], orderCancelUserErrors: [] } } as T
    },
  })
  async function perform(kind: 'cancel' | 'refund') {
    const proposal = await (kind === 'cancel' ? writes.cancelOrder({ orderId: 'order', reason: 'CUSTOMER' }) : writes.createRefund({ orderId: 'order', currency: 'USD', reason: 'Requested refund' })) as PendingShopifyAction
    const claimed = store.claim(proposal.pendingAction.id, 'owner', true)
    const outcome = await writes.executeAction(claimed)
    store.finish(claimed, outcome.status, outcome.result)
    if (outcome.status === 'processing') {
      const current = store.get(claimed.id, 'owner')
      const checked = await writes.checkAction(current)
      store.finish(current, checked.status, checked.result)
    }
    return claimed
  }
  return { raw, store, writes, mutations, perform, paymentStatuses: (next: string[]) => { paymentStatuses = next } }
}

test('evaluation: cancellation and refund complete as separate confirmed actions in either order', async () => {
  for (const sequence of [['cancel', 'refund'], ['refund', 'cancel']] as const) {
    const h = writeHarness()
    try {
      await h.perform(sequence[0])
      await h.perform(sequence[1])
      assert.ok(h.raw.cancelledAt)
      assert.equal(h.raw.refunds.length, 1)
      assert.equal(h.mutations.length, 2)
      assert.equal(h.store.list('owner').filter((action) => action.status === 'succeeded').length, 2)
    } finally { h.store.close() }
  }
})

test('evaluation: partially failed refund gateways prevent any blind second refund', async () => {
  const h = writeHarness()
  try {
    h.paymentStatuses(['SUCCESS', 'FAILURE'])
    await h.perform('refund')
    assert.equal(h.store.list('owner')[0]?.status, 'unknown')
    await assert.rejects(h.perform('refund'), /earlier action/)
    assert.equal(h.mutations.length, 1)
  } finally { h.store.close() }
})

function readHarness() {
  const customer = { id: 'customer', firstName: 'Ada', lastName: 'Example', defaultEmailAddress: { emailAddress: 'ada@example.com' }, defaultPhoneNumber: null }
  const raw = { id: 'order', name: '#1001', email: 'ada@example.com', phone: null, customer,
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', totalPriceSet: { shopMoney: { amount: '25.00', currencyCode: 'USD' } },
    shippingAddress: null, lineItems: { nodes: [], pageInfo: { hasNextPage: false } }, refunds: [] }
  let changeDuringVerification = false
  const client = createShopifyLiveClient({ config, fetch: async (_url, init) => {
    const { query } = JSON.parse(String(init?.body))
    if (query.includes('query OrderByNumber')) return Response.json({ data: { orders: { nodes: [raw], pageInfo: { hasNextPage: false } } } })
    if (changeDuringVerification) raw.customer = { ...customer, id: 'other-customer' }
    return Response.json({ data: { order: raw } })
  } })
  return { raw, client, changeDuringVerification: () => { changeDuringVerification = true } }
}

test('evaluation: verified reads fail closed after an order changes owner', async () => {
  for (const operation of ['getOrder', 'getOrderByNumber', 'listOrderRefunds'] as const) {
    const h = readHarness()
    await h.client.findCustomer({ orderNumber: '#1001', email: 'ada@example.com' })
    h.raw.customer = { ...h.raw.customer, id: 'other-customer' }
    await assert.rejects(operation === 'getOrderByNumber' ? h.client.getOrderByNumber({ orderNumber: '#1001' }) : h.client[operation]({ orderId: 'order' }), /owner changed/)
  }
})

test('evaluation: verification cannot survive an ownership change between identity and detail reads', async () => {
  const h = readHarness()
  h.changeDuringVerification()
  await assert.rejects(h.client.findCustomer({ orderNumber: '#1001', email: 'ada@example.com' }), /owner or contact details changed/)
  await assert.rejects(h.client.getOrder({ orderId: 'order' }), /Verify/)
})

test('evaluation: malformed order lookup data produces a classified failure', async () => {
  const client = createShopifyLiveClient({ config, fetch: async () => Response.json({ data: { orders: {} } }) })
  await assert.rejects(client.findCustomer({ orderNumber: '#1001', email: 'ada@example.com' }), (error: any) => error.code === 'API_ERROR' && /incomplete order lookup/.test(error.message))
})

test('evaluation: mismatched Shopify refund evidence cannot become a success', async () => {
  const h = writeHarness()
  try {
    const claimed = await h.perform('refund')
    h.raw.refunds[0].totalRefundedSet.presentmentMoney.amount = '24.00'
    await assert.rejects(h.writes.checkAction(claimed), (error: any) => error.code === 'OUTCOME_UNKNOWN' && /exact refund amount/.test(error.message))
  } finally { h.store.close() }
})
