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

// Regression guard for PR #7 review finding P1: the request flow must not let
// read-only requests skip authorization before disclosing order/PII data.
test('the request flow authenticates read-only requests instead of skipping it', async () => {
  const architecture = await readDoc('architecture.md')
  assert.match(architecture, /read-only/i)
  assert.match(architecture, /still run the authorization half of step 6/i)
  assert.match(architecture, /order number plus\s+(a\s+)?matching email\/phone/i)
  assert.doesNotMatch(architecture, /skip steps 6/, 'read-only requests must not skip authorization')
})

// Regression guard for PR #7 review finding P2: write tool contracts must carry
// the confirmation token and the idempotency key the guardrails require.
test('write tool contracts carry a confirmation token and an idempotency key', async () => {
  const agents = await readDoc('agents.md')
  assert.match(agents, /createRefund\(\{[^}]*idempotencyKey[^}]*confirmationToken[^}]*\}/)
  const orderEditTools = ['updateShippingAddress', 'addLineItem', 'removeLineItem', 'cancelOrder']
  for (const tool of orderEditTools) {
    const signature = new RegExp(`${tool}\\(\\{[^}]*idempotencyKey[^}]*confirmationToken[^}]*\\}`)
    assert.match(agents, signature, `${tool} should take an idempotencyKey and confirmationToken`)
  }
})

// Regression guard for PR #7 review finding P2 (R18a): removing line items is
// destructive and must always require human approval.
test('the order-edit guardrail requires human approval to remove line items', async () => {
  const agents = await readDoc('agents.md')
  assert.match(agents, /destructive edits \(cancel order, remove line\s+items\)[^]*?human approval/i)
})

// Regression guard for PR #7 review finding P2 (R6a): customer lookup must follow
// the two-factor authorization rule rather than accepting a single identifier.
test('customer lookup follows the two-factor authorization rule', async () => {
  const agents = await readDoc('agents.md')
  assert.match(agents, /findCustomer\(\{[^}]*orderNumber[^}]*\}/)
  assert.match(agents, /two-factor rule/i)
  assert.match(agents, /order number plus\s+(a\s+)?matching email\/phone/i)
})

// Regression guard for PR #7 review coverage gaps (R43, R26a): the plan must assign
// chat API failure visibility and data-subject request handling to phases.
test('the plan assigns chat failure visibility and data-subject handling', async () => {
  const plan = await readDoc('implementation-plan.md')
  assert.match(plan, /failure visibility/i)
  assert.match(plan, /never swallows an agent API failure|keeps? API failures visible/i)
  assert.match(plan, /customers\/data_request/)
  assert.match(plan, /customers\/redact/)
  assert.match(plan, /data-subject/i)
})

// Regression guard for the follow-up to PR #7 review finding P3: the high-level
// capability summary must not advertise a single-identifier customer lookup, because
// the two-factor rule (order number plus matching email/phone) is the guardrail the
// normative documents enforce.
test('the capability summary matches the two-factor customer-lookup rule', async () => {
  const index = await readDoc('README.md')
  assert.match(index, /two-factor rule/i)
  assert.match(index, /order number plus\s+(a\s+)?matching email\s*(or|\/)\s*phone/i)
  assert.match(index, /single identifier is never enough/i)
  assert.doesNotMatch(
    index,
    /by email, phone, or order reference/i,
    'the summary must not allow lookup from a single identifier',
  )
})

// Regression guard for PR #7 review finding P3: the safety rules must agree across
// documents, not merely appear in each of them. The docs index is included so its
// summary cannot drift away from the normative rule.
test('security, architecture, agents, and the docs index agree on authorization, confirmation, and idempotency', async () => {
  const [security, architecture, agents, index] = await Promise.all([
    readDoc('security.md'),
    readDoc('architecture.md'),
    readDoc('agents.md'),
    readDoc('README.md'),
  ])
  for (const doc of [architecture, agents, index]) {
    assert.match(doc, /authenticat/i)
    assert.match(doc, /order number plus\s+(a\s+)?matching email\s*(or|\/)\s*phone/i)
  }
  for (const doc of [security, architecture, agents]) {
    assert.match(doc, /confirmation token/i)
  }
  for (const doc of [architecture, agents]) {
    assert.match(doc, /idempotency[ _]?key/i)
  }
})
