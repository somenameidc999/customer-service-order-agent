import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test, type TestContext } from 'node:test'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { createAgentTurn } from './agent/agent.js'
import type { LlmCompletion } from './agent/openrouter.js'
import { createToolRegistry } from './agent/tools.js'
import { CHAT_LIMITS } from '../shared/chat.js'

async function listen(t: TestContext, app: ReturnType<typeof createApp>): Promise<string> {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

test('the HTTP server measures streamed JSON bytes on chat and action requests', { timeout: 5000 }, async (t) => {
  let turns = 0
  const baseUrl = await listen(t, createApp(undefined, {
    environment: {},
    agent: async () => { turns++ },
    actions: { get store() { throw new Error('Oversized requests must not touch the action store') } },
  }))
  const send = (path: string, size: number) => {
    const start = '{"messages":[{"role":"user","content":"Hello"}],"padding":"'
    const end = '"}'
    const padding = 'a'.repeat(size - start.length - end.length - 2)
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(start + padding))
        controller.enqueue(encoder.encode('é' + end))
        controller.close()
      },
    })
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
    }
    return fetch(baseUrl + path, init)
  }
  const max = CHAT_LIMITS.maxRequestBodyBytes
  const accepted = await send('/api/chat', max)
  assert.equal(accepted.status, 200)
  await accepted.text()
  for (const path of ['/api/chat', '/api/actions/action-id/confirm']) {
    const rejected = await send(path, max + 1)
    assert.equal(rejected.status, 413)
    assert.deepEqual(await rejected.json(), { error: 'Request body is too large.' })
  }
  assert.equal(turns, 1)
})

test('disconnecting an HTTP chat aborts the model and skips tools returned after cancellation', { timeout: 5000 }, async (t) => {
  let finishCompletion!: (result: LlmCompletion) => void
  const completion = new Promise<LlmCompletion>((resolve) => { finishCompletion = resolve })
  let markAborted!: () => void
  const aborted = new Promise<void>((resolve) => { markAborted = resolve })
  let markFinished!: () => void
  const finished = new Promise<void>((resolve) => { markFinished = resolve })
  let toolCalls = 0
  let modelCalls = 0
  const run = createAgentTurn({
    llm: { complete: async ({ signal }) => {
      modelCalls++
      assert.ok(signal)
      signal.addEventListener('abort', markAborted, { once: true })
      return completion
    } },
    tools: createToolRegistry([{
      spoke: 'product',
      spec: { name: 'searchProducts', description: 'Test product lookup', parameters: {} },
      run: () => { toolCalls++; return 'Dummy product' },
    }]),
  })
  const baseUrl = await listen(t, createApp(undefined, { environment: {}, agent: async (input, emit) => {
    try { await run(input, emit) } finally { markFinished() }
  } }))
  const browser = new AbortController()
  const response = await fetch(baseUrl + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'What products do you sell?' }] }),
    signal: browser.signal,
  })
  assert.equal(response.status, 200)
  browser.abort()
  await aborted
  finishCompletion({ content: null, toolCalls: [{ id: 'late', name: 'searchProducts', argumentsText: '{}' }] })
  await finished
  assert.equal(modelCalls, 1)
  assert.equal(toolCalls, 0)
})
