import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'

test('health returns an actual server timestamp', async () => {
  const response = await createApp().request('/api/health')
  assert.equal(response.status, 200)
  const health = await response.json()
  assert.equal(health.status, 'ok')
  assert.equal(health.service, 'hono')
  assert.ok(Math.abs(Date.now() - Date.parse(health.timestamp)) < 5000)
})

test('greeting uses a trimmed name and defaults to builder', async () => {
  const app = createApp()
  const response = await app.request('/api/hello?name=%20Ada%20')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    message: 'Hello, Ada! Your full stack is connected.',
    source: 'Hono API',
  })
  assert.match((await (await app.request('/api/hello')).json()).message, /Hello, builder!/)
})

test('greeting rejects empty and oversized names', async () => {
  for (const name of ['   ', 'x'.repeat(41)]) {
    const response = await createApp().request(`/api/hello?name=${encodeURIComponent(name)}`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Use a name between 1 and 40 characters.' })
  }
})

test('only the root serves an HTML page; assets remain available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hono-react-'))
  try {
    await mkdir(join(directory, 'assets'))
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>Starter</title>')
    await writeFile(join(directory, 'assets', 'app.js'), 'console.log("starter")')
    const app = createApp(directory)
    const home = await app.request('/')
    assert.equal(home.status, 200)
    assert.match(home.headers.get('content-type') ?? '', /text\/html/)
    assert.equal((await app.request('/assets/app.js')).status, 200)
    for (const path of ['/dashboard', '/about', '/api/missing', '/index.html']) {
      const response = await app.request(path)
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), { error: 'Not found' })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
