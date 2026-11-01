import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { chatSession } from '../agent/session.js'
import { createApp } from '../app.js'
import { createAgentTurn, type AgentTurnInput } from '../agent/agent.js'
import { createCommerceToolRegistry } from '../agent/tools.js'
import type { LlmClient } from '../agent/openrouter.js'
import type { AgentEvent } from '../../shared/chat.js'
import { createEvaluationEnvironment, type EvaluationEnvironment, type EvaluationSetup } from './environment.js'

/** This server has no transport capable of reaching live Shopify. The model remains real. */
export function createEvaluationApp(environment: EvaluationEnvironment = createEvaluationEnvironment(), llm?: LlmClient) {
  const traces: Array<{ at: string; sessionId?: string; messages: unknown; events: AgentEvent[] }> = []
  const app = createApp(undefined, {
    agent: async (input, emit) => {
      const trace = { at: new Date().toISOString(), sessionId: input.sessionId, messages: structuredClone(input.messages), events: [] as AgentEvent[] }
      traces.push(trace)
      const runner = createAgentTurn({ ...(llm ? { llm } : {}), actions: environment.store, handoffs: environment.handoffs, toolsFactory: (turn: AgentTurnInput) => createCommerceToolRegistry(environment.client(turn.sessionId!), { sessionId: turn.sessionId, actions: environment.store, handoffs: environment.handoffs }) })
      try {
        await runner(input, (event) => { trace.events.push(structuredClone(event)); emit(event) })
      } catch (error) {
        trace.events.push({ type: 'error', message: error instanceof Error ? error.message : 'Agent failed.' })
        throw error
      }
    },
    actions: { get store() { return environment.store }, client: (sessionId) => environment.client(sessionId) },
  })
  function localRequest(request: Request): boolean {
    const url = new URL(request.url)
    const origin = request.headers.get('origin')
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && (!origin || new URL(origin).origin === url.origin)
  }
  app.post('/api/evaluation/reset', async (c) => {
    if (!localRequest(c.req.raw)) return c.json({ error: 'Evaluation controls require a same-origin loopback request.' }, 403)
    const setup = await c.req.json<EvaluationSetup>().catch(() => ({}))
    environment.reset(setup); traces.length = 0
    return c.json({ mode: 'evaluation', setup, message: 'Controlled Shopify state reset. No live store is connected.' })
  })
  app.post('/api/evaluation/change-order', async (c) => {
    if (!localRequest(c.req.raw)) return c.json({ error: 'Evaluation controls require loopback.' }, 403)
    const body = await c.req.json<{ updatedAt?: string }>()
    if (typeof body.updatedAt !== 'string' || !Number.isFinite(Date.parse(body.updatedAt))) return c.json({ error: 'A valid updatedAt is required.' }, 400)
    environment.state.orders[0]!.updatedAt = body.updatedAt
    return c.json({ changed: true })
  })
  app.post('/api/evaluation/complete', (c) => {
    if (!localRequest(c.req.raw)) return c.json({ error: 'Evaluation controls require loopback.' }, 403)
    environment.completePending()
    return c.json(environment.inspect())
  })
  app.get('/api/evaluation/evidence', (c) => {
    if (!localRequest(c.req.raw)) return c.json({ error: 'Evaluation controls require loopback.' }, 403)
    return c.json({ handoffs: environment.handoffs.list(chatSession(c)), mode: 'evaluation', model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini', ...environment.inspect(), traces })
  })
  app.get('/', async (c) => {
    const html = await readFile(resolve('dist/client/index.html'), 'utf8')
    return c.html(html.replace('<body>', '<body><style>.chat-panel::before{content:"EVALUATION MODE · Real agent model · Controlled Shopify test data · No live store changes";display:block;padding:12px;text-align:center;background:#ffe18c;color:#263f34;font:600 13px monospace}</style><div role="status" style="position:sticky;top:0;z-index:9999;padding:12px;text-align:center;background:#ffe18c;color:#263f34;border-bottom:2px solid #263f34;font:600 15px monospace">EVALUATION MODE · Real agent model · Controlled Shopify test data · No live store changes</div>'))
  })
  app.get('/assets/*', serveStatic({ root: './dist/client' }))
  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.EVALUATION_PORT ?? 8790)
  const environment = createEvaluationEnvironment()
  const server = serve({ fetch: createEvaluationApp(environment).fetch, hostname: '127.0.0.1', port }, (info) => console.log(`Evaluation UI ready at http://127.0.0.1:${info.port}. Real model; controlled Shopify data only.`))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => { environment.close(); process.exit(0) }))
}
