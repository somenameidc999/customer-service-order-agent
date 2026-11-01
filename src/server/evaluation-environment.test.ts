import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PendingShopifyAction } from '../shared/actions.js'
import { createEvaluationEnvironment } from './evaluation/environment.js'

const session = 'evaluation-session'
const identity = { orderNumber: '#1001', email: 'ada@example.com' }

test('evaluation transport persists an accepted refund when its response is lost', async () => {
  const env = createEvaluationEnvironment()
  try {
    const client = env.client(session)
    await client.findCustomer(identity)
    const proposal = await client.createRefund({ orderId: env.state.orders[0]!.id, amount: '12.34', currency: 'USD', reason: 'Response loss evaluation' }) as PendingShopifyAction
    const action = env.store.claim(proposal.pendingAction.id, session, true)
    env.setFault('accept_then_timeout')
    await assert.rejects(client.executeAction(action), (error: Error & { code?: string }) => error.code === 'OUTCOME_UNKNOWN')
    assert.equal(env.state.orders[0]!.refunds.length, 1, 'Shopify state changes before the simulated connection ends')
    assert.equal(env.inspect().mutationCount, 1)
    assert.equal(env.calls.find((call) => call.mutation)?.outcome, 'accepted_then_timeout')
    assert.equal((await client.checkAction(action)).status, 'succeeded')
    assert.equal(env.inspect().mutationCount, 1, 'Reconciliation reads state instead of sending another mutation')
  } finally { env.close() }
})

test('evaluation transport reduces both original gateway balances across partial and remaining refunds', async () => {
  const env = createEvaluationEnvironment()
  try {
    const client = env.client(session)
    await client.findCustomer(identity)
    const order = env.state.orders[0]!
    for (const [amount, remaining] of [['12.34', '12.66'], [undefined, '0.00']] as const) {
      const proposal = await client.createRefund({ orderId: order.id, amount, currency: 'USD', reason: 'Balance evaluation' }) as PendingShopifyAction
      const action = env.store.claim(proposal.pendingAction.id, session, true)
      const result = await client.executeAction(action)
      env.store.finish(action, result.status, result.result)
      assert.equal(result.status, 'succeeded')
      assert.equal(order.suggestedRefund.maximumRefundableSet.presentmentMoney.amount, remaining)
      if (remaining === '12.66') assert.deepEqual(order.suggestedRefund.suggestedTransactions.map((entry) => entry.maximumRefundableSet.presentmentMoney.amount), ['0.00', '12.66'])
    }
    assert.equal(order.displayFinancialStatus, 'REFUNDED')
    assert.deepEqual(order.refunds.map((entry) => entry.totalRefundedSet.presentmentMoney.amount), ['12.34', '12.66'])
    assert.equal(env.inspect().mutationCount, 2)
    await assert.rejects(client.createRefund({ orderId: order.id, currency: 'USD', reason: 'Nothing remains' }), /positive|remaining refundable/)
  } finally { env.close() }
})

test('evaluation transport rejects every destination outside its controlled Shopify endpoint', async () => {
  const env = createEvaluationEnvironment()
  try {
    for (const url of ['https://nate-ce.myshopify.com/admin/api/2026-10/graphql.json', 'https://evaluation.myshopify.com/oauth/access_token', 'https://example.com']) {
      await assert.rejects(env.fetch(url, { method: 'POST', body: '{}' }), /unexpected network destination/)
    }
    assert.equal(env.calls.length, 0)
    assert.equal((await env.client(session).findCustomer(identity)).order.name, '#1001')
  } finally { env.close() }
})

test('evaluation order search is exact and customer order listing excludes another customer', async () => {
  const env = createEvaluationEnvironment()
  try {
    const client = env.client(session)
    await assert.rejects(client.findCustomer({ ...identity, orderNumber: '#100' }), /could not be verified/)
    await assert.rejects(client.findCustomer({ ...identity, orderNumber: '#1002' }), /could not be verified/)
    const verified = await client.findCustomer(identity)
    assert.deepEqual((await client.listCustomerOrders({ customerId: verified.customer.id })).map((order) => order.name), ['#1001'])
    await assert.rejects(client.getCustomer({ customerId: env.state.orders[1]!.customer.id }), /Verify/)
    await assert.rejects(client.getOrder({ orderId: env.state.orders[1]!.id }), /Verify/)
    assert.equal(env.inspect().mutationCount, 0)
  } finally { env.close() }
})

test('evaluation transport respects the JPY minor unit in refunds and remaining balances', async () => {
  const env = createEvaluationEnvironment()
  try {
    env.reset({ currency: 'JPY' })
    const client = env.client(session)
    await client.findCustomer(identity)
    const proposal = await client.createRefund({ orderId: env.state.orders[0]!.id, amount: '12', currency: 'JPY', reason: 'JPY evaluation' }) as PendingShopifyAction
    const action = env.store.claim(proposal.pendingAction.id, session, true)
    assert.equal((await client.executeAction(action)).status, 'succeeded')
    assert.equal(env.state.orders[0]!.suggestedRefund.maximumRefundableSet.presentmentMoney.amount, '13')
    assert.equal(env.state.orders[0]!.refunds[0]!.totalRefundedSet.presentmentMoney.amount, '12')
    await assert.rejects(client.createRefund({ orderId: env.state.orders[0]!.id, amount: '1.25', currency: 'JPY', reason: 'Invalid minor unit' }), /decimal places/)
  } finally { env.close() }
})

test('evaluation read faults can be persistent or one-shot without mutating the controlled store', async () => {
  const env = createEvaluationEnvironment()
  try {
    const client = env.client(session)
    env.setFault('read_throttled', 1)
    await assert.rejects(client.findCustomer(identity), /429/)
    assert.equal((await client.findCustomer(identity)).order.name, '#1001')
    env.setFault('read_denied')
    await assert.rejects(client.getOrder({ orderId: env.state.orders[0]!.id }), /Access denied/)
    await assert.rejects(client.getOrder({ orderId: env.state.orders[0]!.id }), /Access denied/)
    env.setFault('read_malformed', 1)
    await assert.rejects(client.getOrder({ orderId: env.state.orders[0]!.id }), /invalid response/)
    assert.equal((await client.getOrder({ orderId: env.state.orders[0]!.id })).name, '#1001')
    assert.equal(env.inspect().mutationCount, 0)
  } finally { env.close() }
})

test('evaluation journal reopen preserves an uncertain action and prevents a duplicate write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'order-evaluation-'))
  const env = createEvaluationEnvironment({ journalPath: join(directory, 'actions.sqlite') })
  try {
    const client = env.client(session)
    await client.findCustomer(identity)
    const proposal = await client.createRefund({ orderId: env.state.orders[0]!.id, amount: '12.34', currency: 'USD', reason: 'Restart evaluation' }) as PendingShopifyAction
    const action = env.store.claim(proposal.pendingAction.id, session, true)
    env.setFault('accept_then_timeout')
    await assert.rejects(client.executeAction(action))
    env.store.finish(action, 'unknown')
    env.reopenJournal()
    assert.equal(env.store.get(action.id, session).view.status, 'unknown')
    assert.throws(() => env.store.claim(action.id, session, true), /already been confirmed/)
    const outcome = await env.client(session).checkAction(env.store.get(action.id, session))
    assert.equal(outcome.status, 'succeeded')
    assert.equal(env.inspect().mutationCount, 1)
    assert.equal(env.state.orders[0]!.refunds.length, 1)
  } finally { env.close(); await rm(directory, { recursive: true, force: true }) }
})
