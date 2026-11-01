import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '../shared/chat.js'
import { createShopifyFixtureClient } from './testing/shopify-fixture.js'
import { createAgentTurn } from './agent/agent.js'
import { createAuthorizationContext } from './agent/authorization.js'
import type { LlmClient } from './agent/openrouter.js'
import { classifyIntent, planTurn, planGuidance } from './agent/planner.js'
import { createCommerceToolRegistry, type ToolContext, type ToolDefinition } from './agent/tools.js'
import { createShopifySpokeTools, shopifySpokes } from './agent/shopify-spokes.js'

// This suite is fully offline: the Shopify fixture client is in-memory and the
// LLM is a deterministic fake, so no store or model is ever contacted.

function fakeLlm(responses: Awaited<ReturnType<LlmClient['complete']>>[]): LlmClient {
  let index = 0
  return { complete: async () => responses[Math.min(index++, responses.length - 1)]! }
}

/**
 * Build a spoke tool set plus its per-turn authorization context. Customer-scoped
 * tools only return data once `identify` has run a successful two-factor lookup.
 */
function authorizedTools() {
  const authorization = createAuthorizationContext()
  const context: ToolContext = { authorization }
  const tools = new Map(createShopifySpokeTools(createShopifyFixtureClient()).map((tool) => [tool.spec.name, tool]))
  async function identify(orderNumber = '#1001', email = 'ada@example.com'): Promise<string> {
    const tool = tools.get('findCustomer') as ToolDefinition
    const result = JSON.parse(await tool.run({ orderNumber, email }, context)) as { customer: { id: string } }
    return result.customer.id
  }
  return { tools, context, identify }
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
  const registry = createCommerceToolRegistry(createShopifyFixtureClient())
  const owned = new Map(createShopifySpokeTools(createShopifyFixtureClient()).map((tool) => [tool.spec.name, tool.spoke]))
  for (const spoke of shopifySpokes) {
    for (const tool of spoke.tools) {
      assert.equal(owned.get(tool), spoke.name, `${tool} should belong to ${spoke.name}`)
      assert.ok(registry.get(tool), `${tool} should be registered for the hub`)
    }
  }
})

test('findCustomer enforces the order-number plus email/phone two-factor rule', async () => {
  const authorization = createAuthorizationContext()
  const context: ToolContext = { authorization }
  const [findCustomer] = createShopifySpokeTools(createShopifyFixtureClient()).filter((tool) => tool.spec.name === 'findCustomer')
  assert.ok(findCustomer)

  const ok = JSON.parse(await findCustomer.run({ orderNumber: '#1001', email: 'ada@example.com' }, context)) as {
    customer: { id: string }
    order: { name: string }
  }
  assert.equal(ok.order.name, '#1001')
  assert.match(ok.customer.id, /Customer\/1001$/)
  // A successful two-factor lookup is the only thing that grants access.
  assert.equal(context.authorization.identity?.customerId, ok.customer.id)

  await assert.rejects(findCustomer.run({ orderNumber: '#1001' }, context), /INVALID_INPUT/)
  await assert.rejects(findCustomer.run({ orderNumber: '#1001', email: 'grace@example.com' }, context), /UNAUTHORIZED/)
  await assert.rejects(findCustomer.run({ orderNumber: '#9999', email: 'ada@example.com' }, context), /NOT_FOUND/)
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
  // A shipping-address change is non-destructive: confirmation, no human approval.
  assert.equal(edit.requiresHumanApproval, false)

  assert.deepEqual(planTurn('hello there').spokes, [])
})

test('destructive order edits require human approval, non-destructive edits do not', () => {
  const cancel = planTurn('Cancel my order')
  assert.equal(cancel.intent, 'order_edit')
  assert.equal(cancel.requiresConfirmation, true)
  assert.equal(cancel.requiresHumanApproval, true)
  assert.match(planGuidance(cancel), /human approval/)

  const removeItem = planTurn('Please remove the line item from my order')
  assert.equal(removeItem.intent, 'order_edit')
  assert.equal(removeItem.requiresHumanApproval, true)

  const address = planTurn('Update my shipping address')
  assert.equal(address.intent, 'order_edit')
  assert.equal(address.requiresHumanApproval, false)
  assert.doesNotMatch(planGuidance(address), /human approval/)
})

test('order and PII reads fail closed until the customer has been identified', async () => {
  const { tools, context, identify } = authorizedTools()
  const gatedReads: Array<[string, Record<string, unknown>]> = [
    ['getOrder', { orderId: 'gid://shopify/Order/5001' }],
    ['getOrderByNumber', { orderNumber: '#1001' }],
    ['listCustomerOrders', { customerId: 'gid://shopify/Customer/1001' }],
    ['getCustomer', { customerId: 'gid://shopify/Customer/1001' }],
    ['listOrderRefunds', { orderId: 'gid://shopify/Order/5001' }],
  ]
  for (const [name, args] of gatedReads) {
    await assert.rejects(tools.get(name)!.run(args, context), /UNAUTHORIZED/, `${name} must require identification`)
  }

  // Once the identity is proven, the identified customer's own data is readable.
  const customerId = await identify()
  const order = JSON.parse(await tools.get('getOrderByNumber')!.run({ orderNumber: '#1001' }, context)) as { customerId: string }
  assert.equal(order.customerId, customerId)
  const orders = JSON.parse(await tools.get('listCustomerOrders')!.run({ customerId }, context)) as Array<{ name: string }>
  assert.deepEqual(orders.map((entry) => entry.name), ['#1001'])
})

test('the identified customer cannot read or write another customer\'s order', async () => {
  const { tools, context, identify } = authorizedTools()
  await identify('#1001', 'ada@example.com')

  await assert.rejects(tools.get('getOrder')!.run({ orderId: 'gid://shopify/Order/5002' }, context), /UNAUTHORIZED/)
  await assert.rejects(tools.get('getOrderByNumber')!.run({ orderNumber: '#1002' }, context), /UNAUTHORIZED/)
  await assert.rejects(tools.get('listCustomerOrders')!.run({ customerId: 'gid://shopify/Customer/1002' }, context), /UNAUTHORIZED/)
  await assert.rejects(tools.get('getCustomer')!.run({ customerId: 'gid://shopify/Customer/1002' }, context), /UNAUTHORIZED/)
  await assert.rejects(tools.get('listOrderRefunds')!.run({ orderId: 'gid://shopify/Order/5002' }, context), /UNAUTHORIZED/)
  await assert.rejects(tools.get('updateShippingAddress')!.run({
    orderId: 'gid://shopify/Order/5002',
    address: '1 Wrong Way',
    confirmationToken: 'tok',
    idempotencyKey: 'key',
  }, context), /UNAUTHORIZED/)
})

test('order and refund writes reject a missing confirmation token or idempotency key', async () => {
  const { tools, context, identify } = authorizedTools()
  await identify()
  await assert.rejects(
    tools.get('createRefund')!.run({ orderId: 'gid://shopify/Order/5001', amount: '10.00', reason: 'damaged', confirmationToken: 'tok' }, context),
    /IDEMPOTENCY_REQUIRED/,
  )
  await assert.rejects(
    tools.get('createRefund')!.run({ orderId: 'gid://shopify/Order/5001', amount: '10.00', reason: 'damaged', idempotencyKey: 'key' }, context),
    /CONFIRMATION_REQUIRED/,
  )

  const refund = JSON.parse(await tools.get('createRefund')!.run({
    orderId: 'gid://shopify/Order/5001',
    amount: '10.00',
    reason: 'damaged',
    confirmationToken: 'tok',
    idempotencyKey: 'key',
  }, context)) as { amount: string }
  assert.equal(refund.amount, '10.00')

  await assert.rejects(
    tools.get('createRefund')!.run({
      orderId: 'gid://shopify/Order/5001',
      amount: '999.00',
      reason: 'too much',
      confirmationToken: 'tok',
      idempotencyKey: 'key-2',
    }, context),
    /exceeds the refundable/,
  )
})

test('createRefund is bounded by the cumulative refundable amount', async () => {
  const { tools, context, identify } = authorizedTools()
  await identify('#1002', 'grace@example.com')

  const first = JSON.parse(await tools.get('createRefund')!.run({
    orderId: 'gid://shopify/Order/5002',
    amount: '30.00',
    reason: 'partial',
    confirmationToken: 'tok',
    idempotencyKey: 'key-1',
  }, context)) as { amount: string }
  assert.equal(first.amount, '30.00')

  // 89.00 total - 30.00 already refunded leaves 59.00 refundable.
  await assert.rejects(
    tools.get('createRefund')!.run({
      orderId: 'gid://shopify/Order/5002',
      amount: '60.00',
      reason: 'too much',
      confirmationToken: 'tok',
      idempotencyKey: 'key-2',
    }, context),
    /exceeds the refundable 59\.00/,
  )

  const second = JSON.parse(await tools.get('createRefund')!.run({
    orderId: 'gid://shopify/Order/5002',
    amount: '59.00',
    reason: 'rest',
    confirmationToken: 'tok',
    idempotencyKey: 'key-3',
  }, context)) as { amount: string }
  assert.equal(second.amount, '59.00')

  // The order is now fully refunded: any further refund is rejected.
  await assert.rejects(
    tools.get('createRefund')!.run({
      orderId: 'gid://shopify/Order/5002',
      amount: '1.00',
      reason: 'over',
      confirmationToken: 'tok',
      idempotencyKey: 'key-4',
    }, context),
    /no refundable amount remaining/,
  )

  const refunds = JSON.parse(await tools.get('listOrderRefunds')!.run({ orderId: 'gid://shopify/Order/5002' }, context)) as unknown[]
  assert.equal(refunds.length, 2)
})

test('refund and order spokes read their domain from the fixture store', async () => {
  const { tools, context, identify } = authorizedTools()
  await identify()
  const order = JSON.parse(await tools.get('getOrderByNumber')!.run({ orderNumber: '#1001' }, context)) as {
    fulfillmentStatus: string
    lineItems: Array<{ title: string }>
  }
  assert.equal(order.fulfillmentStatus, 'FULFILLED')
  assert.equal(order.lineItems[0]?.title, 'Retro Pixel Mug')

  const product = JSON.parse(await tools.get('searchProducts')!.run({ query: 'mug' })) as Array<{ title: string }>
  assert.equal(product[0]?.title, 'Retro Pixel Mug')

  const refunds = JSON.parse(await tools.get('listOrderRefunds')!.run({ orderId: 'gid://shopify/Order/5001' }, context)) as unknown[]
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
  const runTurn = createAgentTurn({ llm, tools: createCommerceToolRegistry(createShopifyFixtureClient()) })

  await runTurn(
    { messages: [{ id: 'm1', role: 'user', content: 'Is my order ready?', createdAt: new Date().toISOString() }] },
    (event) => events.push(event),
  )

  const plan = events.find((event): event is Extract<AgentEvent, { type: 'plan' }> => event.type === 'plan')
  assert.ok(plan)
  assert.equal(plan.intent, 'order_status')
  assert.deepEqual(plan.spokes, ['customer', 'order'])
  assert.equal(plan.requiresHumanApproval, false)

  const spawned = events
    .filter((event): event is Extract<AgentEvent, { type: 'subagent' }> => event.type === 'subagent' && event.phase === 'start')
    .map((event) => event.name)
  assert.deepEqual(spawned, ['customer', 'order'])

  assert.ok(events.some((event) => event.type === 'assistant_message' && /#1001/.test(event.text)))
})

test('an agent turn blocks an order read attempted before identification', async () => {
  const events: AgentEvent[] = []
  const llm = fakeLlm([
    {
      content: null,
      toolCalls: [{ id: 'call_1', name: 'getOrderByNumber', argumentsText: '{"orderNumber":"#1001"}' }],
    },
    { content: 'I need to identify you first.', toolCalls: [] },
  ])
  const runTurn = createAgentTurn({ llm })

  await runTurn(
    { messages: [{ id: 'm1', role: 'user', content: 'Is my order ready?', createdAt: new Date().toISOString() }] },
    (event) => events.push(event),
  )

  const read = events.find(
    (event): event is Extract<AgentEvent, { type: 'tool_call' }> => event.type === 'tool_call' && event.phase === 'end' && event.name === 'getOrderByNumber',
  )
  assert.ok(read)
  assert.equal(read.ok, false)
  assert.match(read.result ?? '', /UNAUTHORIZED/)
})
