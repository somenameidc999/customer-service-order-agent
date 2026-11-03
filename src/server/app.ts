import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { basicAuth } from 'hono/basic-auth'
import type { HealthResponse, HelloResponse } from '../shared/contracts.js'
import type { AgentRunner } from './agent/agent.js'
import { createChatHandler } from './agent/chat-route.js'
import { registerActionRoutes, type ActionRouteOptions } from './shopify/action-routes.js'
import { loadDeploymentConfig } from './deployment.js'

export interface AppOptions {
  /** Override the agent runner (used by tests to stay offline). */
  agent?: AgentRunner
  actions?: ActionRouteOptions
  environment?: NodeJS.ProcessEnv
}

export function createApp(clientDirectory?: string, options: AppOptions = {}) {
  const app = new Hono()
  const deployment = loadDeploymentConfig(options.environment)

  app.get('/api/health', (c) => c.json({
    status: 'ok',
    service: 'hono',
    timestamp: new Date().toISOString(),
  } satisfies HealthResponse))

  // Fly checks only liveness. All app pages, assets, and other APIs require login.
  if (deployment.credentials) {
    app.use('*', async (c, next) => {
      c.header('Cache-Control', 'private, no-store')
      await next()
    }, basicAuth({ ...deployment.credentials, realm: 'Order agent demo' }))
  }

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
  app.post('/api/chat', createChatHandler(options.agent, Boolean(deployment.publicOrigin)))
  registerActionRoutes(app, { ...options.actions, publicOrigin: deployment.publicOrigin })

  // Serve exactly one frontend page. Unknown paths return JSON with status 404.
  if (clientDirectory) {
    app.get('/', serveStatic({ path: `${clientDirectory}/index.html` }))
    app.get('/assets/*', serveStatic({ root: clientDirectory }))
  }
  app.notFound((c) => c.json({ error: 'Not found' }, 404))

  return app
}
