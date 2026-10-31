import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '../shared/chat.js'
import { createAgentTurn } from './agent/agent.js'
import type { LlmClient } from './agent/openrouter.js'
import { classifyIntent, planTurn, planGuidance } from './agent/planner.js'
import { createCommerceToolRegistry } from './agent/tools.js'
import { createShopifySpokeTools, shopifySpokes } from './agent/shopify-spokes.js'

// This suite is fully offline: the Shopify fixture client is in-memory and the
// LLM is a deterministic fake, so no store or model is ever contacted.

function fakeLlm(responses: Awaited<ReturnType<LlmClient['complete']>>[]): LlmClient {
  let index = 0
  return { complete: async () => responses[Math.min(index++, responses.length - 1)]! }
}

test('the four required Shopify spokes exist with least-privilege scopes and tools', () => {
  const byName = new Map(shopifySpokes.map((spoke) => [spoke.name, spoke]))
  assert.deepEqual([...byName.keys()], ['customer', 'product', 'order', 'refund'])

  assert.deepEqual(byName.get('customer')?.tools, ['findCustomer', 'getCustomer'])
  assert.deepEqual(byName.get('product')?.tools, ['getProduct', 'searchProducts'])
  assert.deepEqual(byName.get('order')?.tools, [
    'getOrder', 'getOrderByNumber', 'listCustomerOrders', 'updateShippingAddress', 'cancelOrder',
  ])
  assert.deepEqual(byName.get('refund')?.tools, ['listOrderRefunds', 'createRefund'])

  assert.deepEqual(byName.get('customer')?.scopes, ['read_customers'])
  assert.deepEqual(byName.get('product')?.scopes, ['read_products'])
  assert.deepEqual(byName.get('order')?.scopes, ['read_orders', 'write_orders'])
  assert.deepEqual(byName.get('refund')?.scopes, ['read_orders', 'write_orders'])
})

test('every Shopify tool is owned by its spoke and exposed on the hub registry', () => {
  const registry = createCommerceToolRegistry()
  const owned = new Map(createShopifySpokeTools().map((tool) => [tool.spec.name, tool.spoke]))
  for (const spoke of shopifySpokes) {
    for (const tool of spoke.tools) {
      assert.equal(owned.get(tool), spoke.name, `${tool} should belong to ${spoke.name}`)
      assert.ok(registry.get(tool), `${tool} should be registered for the hub`)
    }
  }
})

test('findCustomer enforces the order-number plus email/phone two-factor rule', async () => {
  const [findCustomer] = createShopifySpokeTools().filter((tool) => tool.spec.name === 'findCustomer')
  assert.ok(findCustomer)

  const ok = JSON.parse(await findCustomer.run({ orderNumber: '#1001', email: 'ada@example.com' })) as {
    customer: { id: string }
    order: { name: string }
  }
  assert.equal(ok.order.name, '#1001')
  assert.match(ok.customer.id, /Customer\/1001$/)

  await assert.rejects(findCustomer.run({ orderNumber: '#1001' }), /INVALID_INPUT/)
  await assert.rejects(findCustomer.run({ orderNumber: '#1001', email: 'grace@example.com' }), /UNAUTHORIZED/)
  await assert.rejects(findCustomer.run({ orderNumber: '#9999', email: 'ada@example.com' }), /NOT_FOUND/)
})

test('the coordinator sequences customer before order for "is my order ready"', () => {
  assert.equal(classifyIntent('Is my order ready?'), 'order_status')
  const plan = planTurn('Is my order ready?')
  assert.deepEqual(plan.spokes, ['customer', 'order'])
  assert.equal(plan.requiresCustomerIdentification, true)
  assert.match(planGuidance(plan), /customer -> order/)
  assert.match(planGuidance(plan), /before reading any order data/)
})

test('the coordinator routes refunds and product complaints through the right spokes', () => {
  const refund = planTurn('I want a refund for my order')
  assert.deepEqual(refund.spokes, ['customer', 'order', 'refund'])
  assert.equal(refund.requiresConfirmation, true)
  assert.equal(refund.requiresHumanApproval, true)

  const complaint = planTurn('I ordered a product and it sucks')
  assert.equal(complaint.intent, 'product_question')
  assert.deepEqual(complaint.spokes, ['customer', 'order', 'product'])

  const browse = planTurn('Tell me about the Mechanical Keyboard product')
  assert.deepEqual(browse.spokes, ['product'])

  const edit = planTurn('Please change my shipping address')
  assert.equal(edit.intent, 'order_edit')
  assert.deepEqual(edit.spokes, ['customer', 'order'])
  assert.equal(edit.requiresConfirmation, true)

  assert.deepEqual(planTurn('hello there').spokes, [])
})

test('order and refund writes reject a missing confirmation token or idempotency key', async () => {
  const tools = new Map(createShopifySpokeTools().map((tool) => [tool.spec.name, tool]))
  const createRefund = tools.get('createRefund')!
  await assert.rejects(
    createRefund.run({ orderId: 'gid://shopify/Order/5001', amount: '10.00', reason: 'damaged', confirmationToken: 'tok' }),
    /IDEMPOTENCY_REQUIRED/,
  )
  await assert.rejects(
    createRefund.run({ orderId: 'gid://shopify/Order/5001', amount: '10.00', reason: 'damaged', idempotencyKey: 'key' }),
    /CONFIRMATION_REQUIRED/,
  )

  const refund = JSON.parse(await createRefund.run({
    orderId: 'gid://shopify/Order/5001',
    amount: '10.00',
    reason: 'damaged',
    confirmationToken: 'tok',
    idempotencyKey: 'key',
  })) as { amount: string }
  assert.equal(refund.amount, '10.00')

  await assert.rejects(
    createRefund.run({
      orderId: 'gid://shopify/Order/5001',
      amount: '999.00',
      reason: 'too much',
      confirmationToken: 'tok',
      idempotencyKey: 'key-2',
    }),
    /exceeds the refundable/,
  )
})

test('refund and order spokes read their domain from the fixture store', async () => {
  const tools = new Map(createShopifySpokeTools().map((tool) => [tool.spec.name, tool]))
  const order = JSON.parse(await tools.get('getOrderByNumber')!.run({ orderNumber: '#1001' })) as {
    fulfillmentStatus: string
    lineItems: Array<{ title: string }>
  }
  assert.equal(order.fulfillmentStatus, 'FULFILLED')
  assert.equal(order.lineItems[0]?.title, 'Retro Pixel Mug')

  const product = JSON.parse(await tools.get('searchProducts')!.run({ query: 'mug' })) as Array<{ title: string }>
  assert.equal(product[0]?.title, 'Retro Pixel Mug')

  const refunds = JSON.parse(await tools.get('listOrderRefunds')!.run({ orderId: 'gid://shopify/Order/5001' })) as unknown[]
  assert.deepEqual(refunds, [])
})

test('an agent turn emits the plan and spawns spokes in the planned order', async () => {
  const events: AgentEvent[] = []
  const llm = fakeLlm([
    {
      content: null,
      toolCalls: [{ id: 'call_1', name: 'findCustomer', argumentsText: '{"orderNumber":"#1001","email":"ada@example.com"}' }],
    },
    {
      content: null,
      toolCalls: [{ id: 'call_2', name: 'getOrderByNumber', argumentsText: '{"orderNumber":"#1001"}' }],
    },
    { content: 'Your order #1001 has been fulfilled.', toolCalls: [] },
  ])
  const runTurn = createAgentTurn({ llm })

  await runTurn(
    { messages: [{ id: 'm1', role: 'user', content: 'Is my order ready?', createdAt: new Date().toISOString() }] },
    (event) => events.push(event),
  )

  const plan = events.find((event): event is Extract<AgentEvent, { type: 'plan' }> => event.type === 'plan')
  assert.ok(plan)
  assert.equal(plan.intent, 'order_status')
  assert.deepEqual(plan.spokes, ['customer', 'order'])

  const spawned = events
    .filter((event): event is Extract<AgentEvent, { type: 'subagent' }> => event.type === 'subagent' && event.phase === 'start')
    .map((event) => event.name)
  assert.deepEqual(spawned, ['customer', 'order'])

  assert.ok(events.some((event) => event.type === 'assistant_message' && /#1001/.test(event.text)))
})
