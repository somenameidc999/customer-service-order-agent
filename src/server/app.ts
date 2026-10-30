import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { HealthResponse, HelloResponse } from '../shared/contracts.js'

export function createApp(clientDirectory?: string) {
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

  // Serve exactly one frontend page. Unknown paths return JSON with status 404.
  if (clientDirectory) {
    app.get('/', serveStatic({ path: `${clientDirectory}/index.html` }))
    app.get('/assets/*', serveStatic({ root: clientDirectory }))
  }
  app.notFound((c) => c.json({ error: 'Not found' }, 404))

  return app
}
