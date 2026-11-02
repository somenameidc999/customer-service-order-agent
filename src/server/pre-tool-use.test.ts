import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '../shared/chat.js'
import { isPoBoxAddress, isPoBoxLine } from '../shared/address.js'
import { createAgentTurn } from './agent/agent.js'
import { addressPoBoxHook, PO_BOX_BLOCKED_MESSAGE } from './agent/pre-tool-use.js'
import { createToolRegistry, type ToolContext, type ToolDefinition } from './agent/tools.js'
import type { LlmClient } from './agent/openrouter.js'
import { validateAddress } from './shopify/write-client.js'

function fakeLlm(responses: Awaited<ReturnType<LlmClient['complete']>>[]): LlmClient {
  let index = 0
  return { complete: async () => responses[Math.min(index++, responses.length - 1)]! }
}

const shipment = (address1: string) => ({
  orderId: 'gid://shopify/Order/5002',
  address: { address1, city: 'Arlington', zip: '22201', countryCode: 'US' },
})

test('PO box detection covers common spellings but not street names', () => {
  for (const value of [
    'PO Box 123', 'P.O. Box 123', 'P O Box 123', 'POBox 123', 'Post Office Box 123',
    'POB 123', 'P.O.B. 123', 'pob 123', 'P O B 123', 'Postal Box 123', 'Post Box 123',
    'Ship to my po box', 'P.O. Box 123, Unit 4',
  ]) {
    assert.equal(isPoBoxLine(value), true, `${value} should be detected`)
  }
  for (const value of [
    '123 Boxwood Lane', '1 Analytical Way', 'Unit 4, Box 12', '',
    '5 Poblano Way', '4 P.O. Building', 'Postal Delivery, 5 Elm St',
  ]) {
    assert.equal(isPoBoxLine(value), false, `${value} should not be detected`)
  }
  assert.equal(isPoBoxLine(undefined), false)
  assert.equal(isPoBoxAddress({ address1: '1 Old Street', address2: 'PO Box 9' }), true)
  assert.equal(isPoBoxAddress({ address1: '1 Old Street', city: 'Portland' }), false)
  assert.equal(isPoBoxAddress(null), false)
})

test('the address pre-tool-use hook blocks only PO box address updates', async () => {
  const hook = addressPoBoxHook()
  for (const spelling of ['PO Box 123', 'POB 123', 'P.O.B. 123', 'Postal Box 123']) {
    await assert.rejects(
      async () => hook.run({ tool: 'updateShippingAddress', args: shipment(spelling) }),
      (error: Error) => error.message === PO_BOX_BLOCKED_MESSAGE,
    )
  }
  // A physical address, and every unrelated tool, pass through untouched.
  await hook.run({ tool: 'updateShippingAddress', args: shipment('123 New Street') })
  await hook.run({ tool: 'createRefund', args: shipment('PO Box 123') })
})

/**
 * Build an offline agent turn whose customer tool establishes an identity and
 * whose update tool records whether it executed.
 */
function addressTurn(address1: string): { events: AgentEvent[]; ran: () => boolean; run: () => Promise<void> } {
  let executed = false
  const tools: ToolDefinition[] = [
    {
      spoke: 'customer',
      spec: { name: 'findCustomer', description: 'Verify identity.', parameters: { type: 'object', properties: {} } },
      run: (_args, context?: ToolContext) => {
        context?.authorization.identify({ customerId: 'gid://shopify/Customer/1001', orderIds: ['gid://shopify/Order/5002'] })
        return JSON.stringify({ customer: { id: 'gid://shopify/Customer/1001' } })
      },
    },
    {
      spoke: 'order',
      spec: { name: 'updateShippingAddress', description: 'Propose an address update.', parameters: { type: 'object', properties: {} } },
      run: () => {
        executed = true
        return JSON.stringify({
          pendingAction: {
            id: 'action-1', kind: 'shipping_address', orderName: '#1002', title: 'Update shipping address',
            details: ['Order #1002', 'New address: 123 New Street, Arlington, 22201, US'],
            requiresApproval: false, status: 'pending', expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        })
      },
    },
  ]
  const llm = fakeLlm([
    { content: null, toolCalls: [{ id: 'identify', name: 'findCustomer', argumentsText: JSON.stringify({ orderNumber: '#1001', email: 'ada@example.com' }) }] },
    { content: null, toolCalls: [{ id: 'address', name: 'updateShippingAddress', argumentsText: JSON.stringify(shipment(address1)) }] },
    { content: 'Done.', toolCalls: [] },
  ])
  const events: AgentEvent[] = []
  const turn = createAgentTurn({ llm, tools: createToolRegistry(tools) })
  return {
    events,
    ran: () => executed,
    run: () => turn({
      messages: [{ id: 'm1', role: 'user', content: 'Update the shipping address for order #1001. My email is ada@example.com.', createdAt: new Date().toISOString() }],
    }, (event) => events.push(event)),
  }
}

test('a PO box address update is blocked before the tool runs and no confirmation is created', async () => {
  const turn = addressTurn('PO Box 123')
  await turn.run()

  assert.equal(turn.ran(), false, 'the update tool must never execute for a PO box')
  const end = turn.events.find((event) => event.type === 'tool_call' && event.name === 'updateShippingAddress' && event.phase === 'end')
  assert.equal(end?.type === 'tool_call' ? end.ok : undefined, false)
  assert.match(end?.type === 'tool_call' ? end.result ?? '' : '', /PO box/i)
  assert.equal(turn.events.some((event) => event.type === 'confirmation'), false)
  assert.ok(turn.events.some((event) => event.type === 'hook' && event.name === 'block-po-box-address' && event.phase === 'start' && event.detail === 'updateShippingAddress'))
  assert.ok(turn.events.some((event) => event.type === 'assistant_message' && /could not be prepared/i.test(event.text) && /PO box/i.test(event.text)))
})

test('a physical address update still reaches the tool and produces its proposal', async () => {
  const turn = addressTurn('123 New Street')
  await turn.run()

  assert.equal(turn.ran(), true)
  const end = turn.events.find((event) => event.type === 'tool_call' && event.name === 'updateShippingAddress' && event.phase === 'end')
  assert.equal(end?.type === 'tool_call' ? end.ok : undefined, true)
  assert.ok(turn.events.some((event) => event.type === 'confirmation'))
})

test('PO box abbreviation updates are blocked before the tool runs and create no confirmation', async () => {
  for (const spelling of ['POB 123', 'P.O.B. 123', 'Postal Box 123']) {
    const turn = addressTurn(spelling)
    await turn.run()

    assert.equal(turn.ran(), false, `the update tool must never execute for ${spelling}`)
    const end = turn.events.find((event) => event.type === 'tool_call' && event.name === 'updateShippingAddress' && event.phase === 'end')
    assert.equal(end?.type === 'tool_call' ? end.ok : undefined, false)
    assert.match(end?.type === 'tool_call' ? end.result ?? '' : '', /PO box/i)
    assert.equal(turn.events.some((event) => event.type === 'confirmation'), false)
  }
})

test('the Shopify write client independently rejects a PO box address', () => {
  for (const spelling of ['P.O. Box 77', 'POB 77', 'P.O.B. 77', 'Postal Box 77']) {
    assert.throws(
      () => validateAddress({ address1: spelling, city: 'Portland', zip: '97201', countryCode: 'US' }),
      /PO box/i,
    )
  }
  assert.deepEqual(
    validateAddress({ address1: '123 New Street', city: 'Portland', zip: '97201', countryCode: 'US' }),
    { address1: '123 New Street', city: 'Portland', zip: '97201', countryCode: 'US' },
  )
})
