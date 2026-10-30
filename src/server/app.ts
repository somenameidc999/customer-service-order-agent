import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { HealthResponse, HelloResponse } from '../shared/contracts.js'
import type { AgentRunner } from './agent/agent.js'
import { createChatHandler } from './agent/chat-route.js'

export interface AppOptions {
  /** Override the agent runner (used by tests to stay offline). */
  agent?: AgentRunner
}

export function createApp(clientDirectory?: string, options: AppOptions = {}) {
  const app = new Hono()

  app.get('/api/health', (c) => c.json({
    status: 'ok',
    service: 'hono',
    timestamp: new Date().toISOString(),
  } satisfies HealthResponse))

  app.get('/api/hello', (c) => {
    const name = (c.req.query('name') ?? 'builder').trim()
    if (!name || name.length > 40) {
      return c.json({ error: 'Use a name between 1 and 40 characters.' }, 400)
    }

    return c.json({
      message: `Hello, ${name}! Your full stack is connected.`,
      source: 'Hono API',
    } satisfies HelloResponse)
  })

  // Streaming chat surface. The interface calls this with the conversation so far.
  app.post('/api/chat', createChatHandler(options.agent))

  // Serve exactly one frontend page. Unknown paths return JSON with status 404.
  if (clientDirectory) {
    app.get('/', serveStatic({ path: `${clientDirectory}/index.html` }))
    app.get('/assets/*', serveStatic({ root: clientDirectory }))
  }
  app.notFound((c) => c.json({ error: 'Not found' }, 404))

  return app
}
