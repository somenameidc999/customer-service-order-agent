import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Issue #1 delivers design and plan documentation for a hub-and-spoke customer
// service agent. This test guards the documentation set so required topics cannot
// silently disappear. It reads the docs rather than importing app code, so it does
// not couple to the runtime and stays offline.
const docsDirectory = fileURLToPath(new URL('../../docs/', import.meta.url))

const documents = [
  'README.md',
  'architecture.md',
  'agents.md',
  'shopify-integration.md',
  'security.md',
  'implementation-plan.md',
] as const

async function readDoc(name: (typeof documents)[number]) {
  return readFile(join(docsDirectory, name), 'utf8')
}

test('the documentation set exists and the index links every document', async () => {
  const index = await readDoc('README.md')
  for (const name of documents) {
    const contents = await readDoc(name)
    assert.ok(contents.trim().length > 0, `${name} should not be empty`)
    if (name !== 'README.md') {
      assert.match(index, new RegExp(`\\(\\./${name.replace('.', '\\.')}\\)`), `index should link ${name}`)
    }
  }
})

test('architecture documents the hub-and-spoke design and spoke coordination', async () => {
  const architecture = await readDoc('architecture.md')
  assert.match(architecture, /hub-and-spoke/i)
  assert.match(architecture, /the hub/i)
  assert.match(architecture, /spokes?/i)
  assert.match(architecture, /coordinat/i)
  assert.match(architecture, /SpokeRequest|SpokeResult/)
})

test('agent catalog names the hub and each required spoke capability', async () => {
  const agents = await readDoc('agents.md')
  assert.match(agents, /hub agent/i)
  const requiredSpokes = [
    /customer lookup/i,
    /order read/i,
    /product read/i,
    /pricing/i,
    /refund/i,
    /order edit/i,
  ]
  for (const spoke of requiredSpokes) {
    assert.match(agents, spoke, `agents.md should describe the ${spoke} spoke`)
  }
})

test('Shopify integration documents client ID/secret to access token auth', async () => {
  const shopify = await readDoc('shopify-integration.md')
  assert.match(shopify, /client[_\s-]?id/i)
  assert.match(shopify, /client[_\s-]?secret/i)
  assert.match(shopify, /access token/i)
  assert.match(shopify, /oauth/i)
  assert.match(shopify, /SHOPIFY_CLIENT_ID/)
  assert.match(shopify, /SHOPIFY_CLIENT_SECRET/)
})

test('security documents refund guardrails and secret handling', async () => {
  const security = await readDoc('security.md')
  assert.match(security, /refund/i)
  assert.match(security, /human approval/i)
  assert.match(security, /idempotency/i)
  assert.match(security, /secret/i)
  assert.match(security, /\.env/)
  assert.match(security, /audit/i)
})

test('implementation plan defines phases and a definition of done', async () => {
  const plan = await readDoc('implementation-plan.md')
  assert.match(plan, /phase 0/i)
  assert.match(plan, /definition of done/i)
  assert.match(plan, /npm run check/)
  assert.match(plan, /ShopifyFixtureClient/)
})
