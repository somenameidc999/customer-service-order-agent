import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentEvent, ChatMessage } from '../shared/chat.js'
import { createAgentTurn } from './agent/agent.js'
import { HumanSupportStore } from './agent/handoff.js'
import { OUT_OF_SCOPE_REPLY } from './agent/planner.js'
import { createCommerceToolRegistry } from './agent/tools.js'
import { createEvaluationEnvironment } from './evaluation/environment.js'
import { ShopifyActionStore } from './shopify/actions.js'

test('one default agent preserves refund escalation, PO-box blocking, scope refusal and durable proposals', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'customer-hook-composition-'))
  const journal = join(directory, 'actions.sqlite')
  const environment = createEvaluationEnvironment({ journalPath: journal })
  environment.reset({ refundableAmount: '1000.00' })
  const calls = new Map<string, number>()
  let modelCalls = 0
  try {
    const run = createAgentTurn({
      actions: environment.store,
      handoffs: environment.handoffs,
      toolsFactory: ({ sessionId }) => {
        const registry = createCommerceToolRegistry(environment.client(sessionId!), {
          sessionId, actions: environment.store, handoffs: environment.handoffs,
        })
        for (const name of ['createRefund', 'updateShippingAddress']) {
          const tool = registry.get(name)!
          const original = tool.run
          tool.run = (args, context) => {
            const key = `${sessionId}:${name}`
            calls.set(key, (calls.get(key) ?? 0) + 1)
            return original(args, context)
          }
        }
        return registry
      },
      llm: { complete: async ({ messages }) => {
        modelCalls++
        const request = messages.findLast(message => message.role === 'user')!.content!
        if (!messages.some(message => message.role === 'tool')) return { content: null, toolCalls: [{
          id: 'identify', name: 'findCustomer', argumentsText: JSON.stringify({ orderNumber: '#1001', email: 'ada@example.com' }),
        }] }
        return { content: null, toolCalls: [{
          id: 'write', name: request.includes('PO Box') ? 'updateShippingAddress' : 'createRefund',
          argumentsText: JSON.stringify(request.includes('PO Box')
            ? { orderId: 'gid://shopify/Order/1001', address: { address1: 'PO Box 123', city: 'Arlington', zip: '22201', countryCode: 'US' } }
            : { orderId: 'gid://shopify/Order/1001', amount: request.includes('500.01') ? '500.01' : '500.00', reason: 'damage' }),
        }] }
      } },
    })
    const turn = async (sessionId: string, content: string) => {
      const events: AgentEvent[] = []
      const messages: ChatMessage[] = [{ id: 'request', role: 'user', content, createdAt: new Date().toISOString() }]
      await run({ sessionId, messages }, event => events.push(event))
      return events
    }
    const escalated = await turn('over-limit', 'Refund $500.01 USD for damage. Order #1001, email ada@example.com.')
    assert.equal(calls.get('over-limit:createRefund') ?? 0, 0, 'the refund proposal tool must not execute above the limit')
    assert.equal(environment.handoffs.list('over-limit').length, 1)
    assert.equal(environment.store.list('over-limit').length, 0)
    assert.equal(escalated.filter(event => event.type === 'confirmation').length, 0)

    const allowed = await turn('at-limit', 'Refund $500 USD for damage. Order #1001, email ada@example.com.')
    assert.equal(calls.get('at-limit:createRefund'), 1, 'the boundary proposal executes exactly once')
    assert.equal(allowed.filter(event => event.type === 'confirmation').length, 1)
    assert.equal(environment.store.list('at-limit').length, 1)
    assert.equal(environment.handoffs.list('at-limit').length, 0)

    const address = await turn('po-box', 'Update the shipping address to PO Box 123 for order #1001. My email is ada@example.com.')
    assert.equal(calls.get('po-box:updateShippingAddress') ?? 0, 0)
    assert.equal(address.filter(event => event.type === 'confirmation').length, 0)

    const previousCalls = modelCalls
    const refused = await turn('out-of-scope', 'Write a Python script for me.')
    assert.equal(modelCalls, previousCalls, 'the scope guard must not call the model')
    assert.ok(refused.some(event => event.type === 'assistant_message' && event.text === OUT_OF_SCOPE_REPLY))
    assert.equal(environment.inspect().mutationCount, 0)
  } finally { environment.close() }
  try {
    const handoffs = new HumanSupportStore(`${journal}.support`)
    const actions = new ShopifyActionStore(journal)
    try {
      assert.equal(handoffs.list('over-limit')[0]?.status, 'queued', 'escalation survives reopening the store')
      assert.equal(actions.list('at-limit')[0]?.status, 'pending', 'the one confirmation proposal survives reopening')
      assert.equal(actions.list('over-limit').length, 0)
    } finally { handoffs.close(); actions.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
