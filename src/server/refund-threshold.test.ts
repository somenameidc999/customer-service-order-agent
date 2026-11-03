import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAgentTurn } from './agent/agent.js'
import { createCommerceToolRegistry } from './agent/tools.js'
import {
  REFUND_AUTO_APPROVE_MAX_DEFAULT,
  createRefundThresholdHook,
  exceedsRefundLimit,
  refundAutoApproveMax,
} from './agent/tool-hooks.js'
import { HumanSupportStore } from './agent/handoff.js'
import { ShopifyActionStore } from './shopify/actions.js'
import { createEvaluationEnvironment } from './evaluation/environment.js'
import { createShopifyFixtureClient } from './testing/shopify-fixture.js'
import type { AgentEvent, ChatMessage } from '../shared/chat.js'

function messages(...contents: string[]): ChatMessage[] {
  return contents.map((content, index) => ({ id: String(index), role: 'user', content, createdAt: new Date().toISOString() }))
}

test('the refund pre-tool-use hook escalates only amounts strictly above the limit', () => {
  assert.equal(REFUND_AUTO_APPROVE_MAX_DEFAULT, 500)
  const hook = createRefundThresholdHook({ max: 500 })
  assert.equal(hook.run({ name: 'createRefund', args: { amount: '500.00' } }).decision, 'allow')
  assert.equal(hook.run({ name: 'createRefund', args: { amount: 500 } }).decision, 'allow')
  const over = hook.run({ name: 'createRefund', args: { amount: '500.01', currency: 'USD', orderId: 'gid://shopify/Order/5001', reason: 'damage' } })
  assert.equal(over.decision, 'escalate')
  assert.equal(over.decision === 'escalate' ? over.escalation.hook : '', 'refund-threshold')
  assert.match(over.decision === 'escalate' ? over.escalation.summary : '', /500\.01 USD/)
  // A full refund omits the amount; the server checks the resolved balance instead.
  assert.equal(hook.run({ name: 'createRefund', args: {} }).decision, 'allow')
  // The guardrail is scoped to refunds only.
  assert.equal(hook.run({ name: 'cancelOrder', args: { amount: '999' } }).decision, 'allow')
  assert.equal(exceedsRefundLimit('500'), false)
  assert.equal(exceedsRefundLimit('500.01'), true)
  assert.equal(exceedsRefundLimit(undefined), false)
})

test('REFUND_AUTO_APPROVE_MAX overrides the ceiling and invalid values fall back', () => {
  const prior = process.env.REFUND_AUTO_APPROVE_MAX
  try {
    process.env.REFUND_AUTO_APPROVE_MAX = '100'
    assert.equal(refundAutoApproveMax(), 100)
    assert.equal(createRefundThresholdHook().run({ name: 'createRefund', args: { amount: '150' } }).decision, 'escalate')
    assert.equal(createRefundThresholdHook().run({ name: 'createRefund', args: { amount: '100' } }).decision, 'allow')
    process.env.REFUND_AUTO_APPROVE_MAX = 'not-a-number'
    assert.equal(refundAutoApproveMax(), REFUND_AUTO_APPROVE_MAX_DEFAULT)
  } finally {
    if (prior === undefined) delete process.env.REFUND_AUTO_APPROVE_MAX
    else process.env.REFUND_AUTO_APPROVE_MAX = prior
  }
})

test('an over-threshold refund is escalated to human review and never proposed', async () => {
  const actions = new ShopifyActionStore(':memory:')
  const handoffs = new HumanSupportStore(':memory:')
  const client = createShopifyFixtureClient()
  let refundCalls = 0
  const createRefund = client.createRefund
  client.createRefund = async (input) => { refundCalls++; return createRefund(input) }
  const events: AgentEvent[] = []
  let round = 0
  try {
    const run = createAgentTurn({ actions, handoffs, tools: createCommerceToolRegistry(client, { sessionId: 'refund-limit', actions, handoffs }),
      llm: { complete: async () => {
        if (round++ === 0) return { content: null, toolCalls: [{ id: 'identify', name: 'findCustomer', argumentsText: '{"orderNumber":"#1001","email":"ada@example.com"}' }] }
        return { content: null, toolCalls: [{ id: 'refund', name: 'createRefund', argumentsText: '{"orderId":"gid://shopify/Order/5001","amount":"999","reason":"damage"}' }] }
      } } })
    await run({ sessionId: 'refund-limit', messages: messages('Refund my order for damage. Order #1001, email ada@example.com.') }, (event) => events.push(event))

    assert.equal(refundCalls, 0, 'the blocked refund never reaches the Shopify refund tool')
    assert.equal(actions.list('refund-limit').length, 0, 'no refund proposal is created')
    assert.equal(handoffs.list('refund-limit').length, 1, 'the refund is queued for a human')
    assert.equal(handoffs.list('refund-limit')[0]?.status, 'queued')
    assert.ok(!events.some((event) => event.type === 'confirmation'))
    assert.ok(events.some((event) => event.type === 'hook' && event.name === 'refund-threshold' && event.phase === 'start'))
    const reply = events.find((event) => event.type === 'assistant_message')
    assert.match(reply?.type === 'assistant_message' ? reply.text : '', /would go to the team for email review/i)
    assert.match(reply?.type === 'assistant_message' ? reply.text : '', /no email was sent and no refund was processed/i)
    assert.match(reply?.type === 'assistant_message' ? reply.text : '', new RegExp(handoffs.list('refund-limit')[0]!.id))
    assert.doesNotMatch(reply?.type === 'assistant_message' ? reply.text : '', /refund (?:was )?submitted|refund completed/i)
    assert.equal(events[events.length - 1]?.type, 'hook')
  } finally { actions.close(); handoffs.close() }
})

test('an at-or-below-threshold refund still produces a confirmation proposal', async () => {
  const env = createEvaluationEnvironment()
  env.reset({ refundableAmount: '1000.00' })
  const events: AgentEvent[] = []
  let round = 0
  try {
    const run = createAgentTurn({ actions: env.store, handoffs: env.handoffs,
      toolsFactory: () => createCommerceToolRegistry(env.client('refund-allow'), { sessionId: 'refund-allow', actions: env.store, handoffs: env.handoffs }),
      llm: { complete: async () => {
        if (round++ === 0) return { content: null, toolCalls: [{ id: 'identify', name: 'findCustomer', argumentsText: '{"orderNumber":"#1001","email":"ada@example.com"}' }] }
        return { content: null, toolCalls: [{ id: 'refund', name: 'createRefund', argumentsText: '{"orderId":"gid://shopify/Order/1001","amount":"500","reason":"damage"}' }] }
      } } })
    await run({ sessionId: 'refund-allow', messages: messages('Refund $500 USD for damage. Order #1001, email ada@example.com.') }, (event) => events.push(event))

    const confirmation = events.find((event) => event.type === 'confirmation')
    assert.equal(confirmation?.type === 'confirmation' ? confirmation.action.kind : '', 'refund')
    assert.equal(confirmation?.type === 'confirmation' ? confirmation.action.status : '', 'pending')
    assert.equal(env.store.list('refund-allow')[0]?.status, 'pending')
    assert.equal(env.handoffs.list('refund-allow').length, 0)
    assert.equal(env.calls.filter((call) => call.mutation).length, 0)
  } finally { env.close() }
})

test('the boundary just above the limit escalates through the agent loop', async () => {
  const env = createEvaluationEnvironment()
  env.reset({ refundableAmount: '1000.00' })
  const events: AgentEvent[] = []
  let round = 0
  try {
    const run = createAgentTurn({ actions: env.store, handoffs: env.handoffs,
      toolsFactory: () => createCommerceToolRegistry(env.client('refund-edge'), { sessionId: 'refund-edge', actions: env.store, handoffs: env.handoffs }),
      llm: { complete: async () => {
        if (round++ === 0) return { content: null, toolCalls: [{ id: 'identify', name: 'findCustomer', argumentsText: '{"orderNumber":"#1001","email":"ada@example.com"}' }] }
        return { content: null, toolCalls: [{ id: 'refund', name: 'createRefund', argumentsText: '{"orderId":"gid://shopify/Order/1001","amount":"500.01","reason":"damage"}' }] }
      } } })
    await run({ sessionId: 'refund-edge', messages: messages('Refund $500.01 USD for damage. Order #1001, email ada@example.com.') }, (event) => events.push(event))

    assert.equal(env.store.list('refund-edge').length, 0)
    assert.equal(env.handoffs.list('refund-edge').length, 1)
    assert.ok(!events.some((event) => event.type === 'confirmation'))
  } finally { env.close() }
})

test('a full refund above the threshold is escalated once Shopify resolves the amount', async () => {
  const env = createEvaluationEnvironment()
  env.reset({ refundableAmount: '900.00' })
  const events: AgentEvent[] = []
  let round = 0
  try {
    const run = createAgentTurn({ actions: env.store, handoffs: env.handoffs,
      toolsFactory: () => createCommerceToolRegistry(env.client('refund-full'), { sessionId: 'refund-full', actions: env.store, handoffs: env.handoffs }),
      llm: { complete: async () => {
        if (round++ === 0) return { content: null, toolCalls: [{ id: 'identify', name: 'findCustomer', argumentsText: '{"orderNumber":"#1001","email":"ada@example.com"}' }] }
        return { content: null, toolCalls: [{ id: 'refund', name: 'createRefund', argumentsText: '{"orderId":"gid://shopify/Order/1001","amount":"1.00","reason":"damage"}' }] }
      } } })
    await run({ sessionId: 'refund-full', messages: messages('Refund the full remaining balance. Order #1001, email ada@example.com.') }, (event) => events.push(event))

    assert.equal(env.handoffs.list('refund-full').length, 1)
    assert.ok(!events.some((event) => event.type === 'confirmation'))
    assert.ok(events.some((event) => event.type === 'hook' && event.name === 'refund-threshold'))
    assert.equal(env.store.list('refund-full').length, 0, 'the resolved balance is blocked before a proposal is saved')
    assert.equal(env.calls.filter((call) => call.mutation).length, 0)
  } finally { env.close() }
})

test('a refund revision over the ceiling withdraws the earlier proposal without calling the model', async () => {
  const env = createEvaluationEnvironment()
  const sessionId = 'refund-revision'
  const previous = env.store.prepare({ sessionId, storeDomain: 'test.myshopify.com', orderId: 'order', customerId: 'customer', updatedAt: 'v1',
    payload: { kind: 'refund', amount: '100.00', currency: 'USD', reason: 'damage', notifyCustomer: false, transactions: [] },
    title: 'Refund 100.00 USD', details: [], orderName: '#1001',
  })
  const events: AgentEvent[] = []
  try {
    const run = createAgentTurn({ actions: env.store, handoffs: env.handoffs, llm: {
      complete: async () => assert.fail('The hook should stop this revision before a model call'),
    } })
    await run({ sessionId, messages: messages('Refund $100 for damage on order #1001.', 'Actually, make it 600 instead.') }, (event) => events.push(event))
    assert.equal(env.store.get(previous.id, sessionId).view.status, 'cancelled')
    assert.equal(env.store.list(sessionId).length, 1)
    assert.equal(env.calls.length, 0)
    assert.ok(events.some((event) => event.type === 'confirmation' && event.action.id === previous.id && event.action.status === 'cancelled'))
    assert.ok(events.some((event) => event.type === 'assistant_message' && /600 USD.*email review.*no email was sent and no refund was processed/i.test(event.text)))
    events.length = 0
    await run({ sessionId, messages: messages('Please update the refund from $100 to $650.') }, (event) => events.push(event))
    assert.ok(events.some((event) => event.type === 'assistant_message' && /650 USD.*email review/i.test(event.text)))
  } finally { env.close() }
})

test('a stored refund above the current ceiling cannot be claimed for execution', () => {
  const actions = new ShopifyActionStore(':memory:')
  try {
    const proposal = actions.prepare({ sessionId: 'legacy', storeDomain: 'test.myshopify.com', orderId: 'order', customerId: 'customer', updatedAt: 'v1',
      payload: { kind: 'refund', amount: '600.00', currency: 'USD', reason: 'damage', notifyCustomer: false, transactions: [] },
      title: 'Refund 600.00 USD', details: [], orderName: '#1001',
    })
    assert.throws(() => actions.claim(proposal.id, 'legacy', true), /requires human review/i)
  } finally { actions.close() }
})
