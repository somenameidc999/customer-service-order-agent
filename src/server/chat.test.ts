import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createApp } from './app.js'
import { createAgentTurn } from './agent/agent.js'
import { validateChatBody } from './agent/chat-route.js'
import { createOpenRouterClient } from './agent/openrouter.js'
import { createToolRegistry, type ToolDefinition } from './agent/tools.js'
import type { LlmClient } from './agent/openrouter.js'
import { CHAT_LIMITS, limitChatHistory, buildChatRequest, type AgentEvent } from '../shared/chat.js'

// The client sources use JSX but this test runs without a bundler, so the
// classic runtime needs a React global before App.tsx is evaluated.
;(globalThis as Record<string, unknown>).React = React

function fakeLlm(responses: Awaited<ReturnType<LlmClient['complete']>>[]): LlmClient {
  let index = 0
  return {
    complete: async () => responses[Math.min(index++, responses.length - 1)]!,
  }
}

const echoTool: ToolDefinition = {
  spoke: 'testSpoke',
  spec: { name: 'echo', description: 'Echo input.', parameters: { type: 'object', properties: {} } },
  run: (args) => `echo:${String(args.x ?? '')}`,
}

test('chat body validation accepts a small conversation and trims content', () => {
  const result = validateChatBody({ messages: [{ role: 'user', content: '  hello  ' }] })
  assert.deepEqual(result, { ok: true, messages: [{ role: 'user', content: 'hello' }] })
})

test('chat body validation rejects empty, oversized and malformed messages', () => {
  assert.equal(validateChatBody({ messages: [] }).ok, false)
  assert.equal(validateChatBody({ messages: [{ role: 'user', content: '   ' }] }).ok, false)
  assert.equal(validateChatBody({ messages: [{ role: 'system', content: 'hi' }] }).ok, false)
  assert.equal(validateChatBody({ messages: [{ role: 'user', content: 'x'.repeat(4001) }] }).ok, false)
  assert.equal(validateChatBody({ messages: new Array(51).fill({ role: 'user', content: 'hi' }) }).ok, false)
})

test('limitChatHistory keeps a long conversation within the server message limit', () => {
  const messages = Array.from({ length: 60 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: `turn ${index}` }))
  const limited = limitChatHistory(messages)
  assert.equal(limited.length, CHAT_LIMITS.maxMessages)
  // The newest turns survive so the in-progress user message is still sent.
  assert.deepEqual(limited[limited.length - 1], messages[messages.length - 1])
  assert.deepEqual(limited[0], messages[messages.length - CHAT_LIMITS.maxMessages])
})

test('limitChatHistory returns short histories and copies without mutation', () => {
  const messages = [{ content: 'a' }, { content: 'b' }]
  const limited = limitChatHistory(messages)
  assert.deepEqual(limited, messages)
  assert.notEqual(limited, messages)
  assert.deepEqual(limitChatHistory(messages, 0), [])
  assert.deepEqual(limitChatHistory(messages, 1), [{ content: 'b' }])
})

test('the actual client request keeps the 26th user turn and fits server validation', async () => {
  const visible = Array.from({ length: 50 }, (_, index) => ({ role: index % 2 === 0 ? 'user' as const : 'assistant' as const, content: `turn ${index}` }))
  const latest = { role: 'user' as const, content: 'question 26' }
  const outgoing = buildChatRequest([...visible, latest])
  assert.equal(outgoing.messages.length, CHAT_LIMITS.maxMessages)
  assert.deepEqual(outgoing.messages.at(-1), latest)
  assert.equal(validateChatBody(outgoing).ok, true)
  assert.equal(visible.length, 50, 'Visible history stays intact')
  let received: unknown
  const app = createApp(undefined, { agent: async (input, emit) => { received = input.messages; emit({ type: 'assistant_message', text: 'Still usable' }) } })
  const body = JSON.stringify(outgoing)
  const response = await app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(body).byteLength) }, body })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /Still usable/)
  assert.deepEqual((received as Array<{ content: string }>).at(-1)?.content, latest.content)
})

test('long Unicode and escaped chat histories fit the complete UTF-8 JSON body limit', async () => {
  for (const content of ['😀'.repeat(2000), '\u0001'.repeat(4000)]) {
    const visible = Array.from({ length: 50 }, (_, index) => ({ role: index % 2 === 0 ? 'user' as const : 'assistant' as const, content }))
    const latest = { role: 'user' as const, content: 'next question' }
    const outgoing = buildChatRequest([...visible, latest])
    const body = JSON.stringify(outgoing), bytes = new TextEncoder().encode(body).byteLength
    assert.ok(bytes <= CHAT_LIMITS.maxRequestBodyBytes)
    assert.ok(outgoing.messages.length < CHAT_LIMITS.maxMessages)
    assert.deepEqual(outgoing.messages.at(-1), latest)
    assert.equal(validateChatBody(outgoing).ok, true)
    assert.equal(visible.length, 50)
    const app = createApp(undefined, { agent: async (_input, emit) => emit({ type: 'assistant_message', text: 'ok' }) })
    const response = await app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(bytes) }, body })
    assert.equal(response.status, 200)
    await response.text()
  }
})

test('a long assistant response cannot strand later sends at the per-message limit', () => {
  const visible = [{ role: 'assistant' as const, content: 'x'.repeat(6000) }, { role: 'user' as const, content: 'Continue' }]
  const request = buildChatRequest(visible)
  assert.equal(request.messages[0].content.length, CHAT_LIMITS.maxMessageLength)
  assert.equal(validateChatBody(request).ok, true)
  assert.equal(visible[0].content.length, 6000)
  assert.deepEqual(request.messages.at(-1), visible.at(-1))
})

test('agent turn streams hooks, a subagent, a tool call and the final message', async () => {
  const events: AgentEvent[] = []
  const llm = fakeLlm([
    { content: null, toolCalls: [{ id: 'call_1', name: 'echo', argumentsText: '{"x":"hi"}' }] },
    { content: 'All done.', toolCalls: [] },
  ])
  const runTurn = createAgentTurn({ llm, tools: createToolRegistry([echoTool]) })

  await runTurn({ messages: [{ id: 'm1', role: 'user', content: 'run echo', createdAt: new Date().toISOString() }] }, (event) => events.push(event))

  assert.ok(events.some((event) => event.type === 'subagent' && event.name === 'testSpoke' && event.phase === 'start'))
  assert.ok(events.some((event) => event.type === 'tool_call' && event.name === 'echo' && event.phase === 'start'))
  const toolEnd = events.find((event) => event.type === 'tool_call' && event.phase === 'end')
  assert.deepEqual(toolEnd && { ok: toolEnd.ok, result: toolEnd.result }, { ok: true, result: 'echo:hi' })
  assert.ok(events.some((event) => event.type === 'hook' && event.name === 'guardrails' && event.phase === 'start'))
  assert.ok(events.some((event) => event.type === 'assistant_message' && event.text === 'All done.'))
  assert.equal(events[events.length - 1]?.type, 'hook')
})

test('agent turn marks a failing tool call as not ok', async () => {
  const events: AgentEvent[] = []
  const failingTool: ToolDefinition = {
    spoke: 'testSpoke',
    spec: { name: 'boom', description: 'Always fails.', parameters: { type: 'object', properties: {} } },
    run: () => { throw new Error('tool exploded') },
  }
  const llm = fakeLlm([
    { content: null, toolCalls: [{ id: 'call_1', name: 'boom', argumentsText: '{}' }] },
    { content: 'Recovered.', toolCalls: [] },
  ])
  const runTurn = createAgentTurn({ llm, tools: createToolRegistry([failingTool]) })
  await runTurn({ messages: [{ id: 'm1', role: 'user', content: 'go', createdAt: new Date().toISOString() }] }, (event) => events.push(event))

  const toolEnd = events.find((event) => event.type === 'tool_call' && event.phase === 'end')
  assert.equal(toolEnd?.type === 'tool_call' ? toolEnd.ok : undefined, false)
  assert.ok(events.some((event) => event.type === 'assistant_message' && event.text === 'Recovered.'))
})

test('POST /api/chat streams the agent events as server-sent events', async () => {
  const app = createApp(undefined, {
    agent: async (_input, emit) => {
      emit({ type: 'subagent', name: 'pricing', phase: 'start', detail: 'calculate' })
      emit({ type: 'tool_call', id: '1', name: 'calculate', phase: 'start', args: '{"operation":"add"}' })
      emit({ type: 'tool_call', id: '1', name: 'calculate', phase: 'end', result: '3', ok: true })
      emit({ type: 'assistant_message', text: 'The answer is 3.' })
      emit({ type: 'done' })
    },
  })

  const response = await app.request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '1 + 2?' }] }),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const body = await response.text()
  assert.match(body, /"type":"subagent"/)
  assert.match(body, /"type":"tool_call"/)
  assert.match(body, /"text":"The answer is 3\."/)
  assert.match(body, /"type":"done"/)
})

test('POST /api/chat rejects invalid bodies with a JSON 400', async () => {
  const app = createApp()
  const empty = await app.request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  })
  assert.equal(empty.status, 400)
  assert.deepEqual(await empty.json(), { error: 'Provide at least one message.' })

  const malformed = await app.request('/api/chat', { method: 'POST', body: 'not-json' })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json() as { error: string }).error, 'Request body must be valid JSON.')
})

test('POST /api/chat keeps an agent failure visible in the stream', async () => {
  const app = createApp(undefined, {
    agent: async () => { throw new Error('OPENROUTER_API_KEY is not configured on the server.') },
  })
  const response = await app.request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  })
  const body = await response.text()
  assert.match(body, /"type":"error"/)
  assert.match(body, /OPENROUTER_API_KEY is not configured/)
  assert.match(body, /"type":"done"/)
})

test('the chat interface renders history, composer and activity affordances', async () => {
  const { App } = await import('../client/App.js')
  const html = renderToStaticMarkup(React.createElement(App))
  assert.match(html, /AGENT CHAT/)
  assert.match(html, /Chat with the order agent/)
  assert.match(html, /aria-label="Chat history"/)
  assert.match(html, /aria-label="Message the agent"/)
  assert.match(html, /chat-composer/)
  assert.match(html, /class="[^"]*chat-clear[^"]*"[^>]*>Clear</)
})

test('the demo order picker starts collapsed above the agent chat', async () => {
  const { App } = await import('../client/App.js')
  const html = renderToStaticMarkup(React.createElement(App))
  assert.match(html, /<details class="demo-orders"><summary><strong>Demo orders/)
  assert.ok(html.indexOf('class="demo-orders"') < html.indexOf('id="chat-title"'))
  assert.doesNotMatch(html, /localhost \/ system-check|Say hello to your backend|Good company/)
})

test('the OpenRouter client sends the key and parses streamed tool calls', async () => {
  const requests: Array<{ authorization?: string; body: string }> = []
  let status = 200
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ authorization: request.headers.authorization, body })
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(status === 200
        ? JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'calculate', arguments: '{"a":1,"b":2,"operation":"add"}' } }] } }] })
        : JSON.stringify({ error: 'nope' }))
    })
  })

  const previousKey = process.env.OPENROUTER_API_KEY
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    process.env.OPENROUTER_API_KEY = 'test-key'
    const client = createOpenRouterClient({ baseUrl: `http://127.0.0.1:${address.port}`, model: 'test/model' })
    const completion = await client.complete({
      messages: [{ role: 'user', content: 'add 1 and 2' }],
      tools: [{ name: 'calculate', description: 'math', parameters: { type: 'object' } }],
    })
    assert.equal(requests[0]?.authorization, 'Bearer test-key')
    assert.match(requests[0]?.body ?? '', /"model":"test\/model"/)
    assert.deepEqual(completion.toolCalls, [{ id: 'call_9', name: 'calculate', argumentsText: '{"a":1,"b":2,"operation":"add"}' }])

    status = 401
    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
      (error: Error) => error.message.includes('OpenRouter request failed (401)') && !error.message.includes('test-key'),
    )
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
  }
})
