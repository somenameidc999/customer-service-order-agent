import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { existsSync } from 'node:fs'

const port = Number(process.env.PORT ?? 8787)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.')
}

const server = serve({
  fetch: createApp(existsSync('./dist/client/index.html') ? './dist/client' : undefined).fetch,
  port,
  hostname: process.env.HOST ?? '127.0.0.1',
}, (info) => {
  console.log(`Hono ready at http://${info.address}:${info.port}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close((error) => process.exit(error ? 1 : 0))
  })
}
