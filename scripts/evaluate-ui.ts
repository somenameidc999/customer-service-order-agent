import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { scenarios, type EvaluationContext } from '../src/server/evaluation/scenarios.js'
import { selectEvaluationScenarios } from '../src/server/evaluation/selection.js'
import type { EvaluationEnvironment } from '../src/server/evaluation/environment.js'
import type { AgentEvent } from '../src/shared/chat.js'
import type { ShopifyActionView } from '../src/shared/actions.js'

const base = process.env.EVALUATION_URL ?? 'http://127.0.0.1:8790'
const output = resolve(process.env.EVALUATION_OUTPUT ?? 'artifacts/evaluations/ui')
const ids = process.argv.find((v) => v.startsWith('--ids='))?.slice(6).split(',')
const selected = selectEvaluationScenarios(scenarios, ids)
await mkdir(output, { recursive: true })
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const executablePath = process.env.CHROME_PATH ?? (process.platform === 'darwin' && existsSync(macChrome) ? macChrome : undefined)
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true })
const results = []
try {
  for (const scenario of selected) {
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 1 })
    const page = await browserContext.newPage()
    const checks: string[] = [], replies: string[] = [], events: AgentEvent[] = []
    let evidence: any, actions: ShopifyActionView[] = [], pending: Promise<unknown> = Promise.resolve()
    const rawRequest = async (path: string, body: unknown, session?: string) => {
      const response = await page.request.post(`${base}${path}`, { data: body, ...(session ? { headers: { cookie: `order_chat=${session}` } } : {}) })
      return new Response(await response.text(), { status: response.status(), headers: response.headers() })
    }
    await rawRequest('/api/evaluation/reset', scenario.setup ?? {})
    await page.goto(base)
    await page.getByRole('textbox', { name: 'Message the agent' }).waitFor()
    const sync = async () => {
      evidence = await (await page.request.get(`${base}/api/evaluation/evidence`)).json()
      actions = (await (await page.request.get(`${base}/api/actions`)).json()).actions
      events.splice(0, events.length, ...evidence.traces.flatMap((t: any) => t.events))
    }
    await sync()
    const confirming = new Set<string>()
    const assertActionDisplay = async (action: ShopifyActionView) => {
      const card = page.locator(`[data-action-id="${action.id}"]`)
      if (['executing', 'processing', 'unknown', 'failed', 'succeeded'].includes(action.status)) {
        const receipt = page.getByRole('log', { name: 'Chat history' }).locator(`[data-action-receipt="${action.id}"]`)
        await receipt.waitFor({ state: 'visible', timeout: 30000 })
        await receipt.locator('.action-heading span').filter({ hasText: new RegExp(`^${action.status}$`, 'i') }).waitFor({ state: 'visible' })
        assert.deepEqual(await receipt.locator('li').allTextContents(), action.details, 'The chat record keeps all reviewed action details')
        if (action.result) assert.ok((await receipt.innerText()).includes(action.result.message), 'The chat receipt shows the confirmed Shopify result')
        if (action.result?.shopifyId) assert.equal(await receipt.locator('code').innerText(), action.result.shopifyId)
        assert.equal(await page.locator('.chat-actions').locator(card).count(), 0)
        return
      }
      const expected = action.status === 'pending' ? 'Awaiting confirmation' : action.status
      await card.locator('.action-heading span').filter({ hasText: new RegExp(`^${expected}$`, 'i') }).waitFor({ state: 'visible', timeout: 30000 })
    }
    // A button changes its label while a request is in flight. Wait for the
    // actual response and rendered status, rather than the old label disappearing.
    const clickAction = async (action: ShopifyActionView, operation: 'confirm' | 'check') => {
      const card = page.getByRole('region', { name: `${action.title} confirmation` })
      const responsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/actions/${action.id}/${operation}` && response.request().method() === 'POST',
      { timeout: 30000 })
      await card.getByRole('button', { name: operation === 'confirm' ? 'Confirm in Shopify' : 'Check Shopify status', exact: true }).click()
      const response = await responsePromise
      assert.equal(response.status(), 200, `UI ${operation} receives a successful action response`)
      const body = await response.json() as { action: ShopifyActionView }
      await assertActionDisplay(body.action)
      return body.action
    }
    const c: EvaluationContext = {
      sessionId: (await browserContext.cookies()).find((cookie) => cookie.name === 'order_chat')!.value,
      environment: { get calls() { return evidence.calls }, get state() { return evidence.state }, completePending() { pending = rawRequest('/api/evaluation/complete', {}) } } as unknown as EvaluationEnvironment,
      events, actions: () => actions, handoffs: () => evidence.handoffs,
      prove(condition, description) { assert.ok(condition, description); checks.push(description) },
      async turn(prompt) {
        await pending
        await page.getByRole('textbox', { name: 'Message the agent' }).fill(prompt)
        await page.getByRole('button', { name: 'Send', exact: true }).click()
        await page.waitForFunction(() => !document.querySelector('.chat-typing') && !!document.querySelector('.chat-message-assistant:last-child .chat-text, .chat-message-assistant:last-child .markdown-message, .chat-message-assistant:last-child .chat-role') && !document.querySelector('button.chat-send')?.textContent?.includes('Working'), undefined, { timeout: 90000 })
        await sync()
        const trace = evidence.traces.at(-1)
        const errors = trace.events.filter((e: AgentEvent) => e.type === 'error')
        assert.equal(errors.length, 0, JSON.stringify(errors))
        const reply = trace.events.filter((e: AgentEvent) => e.type === 'assistant_message').map((e: any) => e.text).join('\n')
        assert.ok(reply.trim(), 'Actual UI receives assistant reply')
        if (!evidence.calls.some((call: { mutation: boolean }) => call.mutation)) assert.doesNotMatch(reply, /\bI have (?:successfully )?(?:refunded|cancelled|updated)|\b(?:refund|cancellation) (?:has )?(?:succeeded|completed)\b/i, 'UI cannot claim a completed write without a mutation')
        replies.push(reply); return reply
      },
      async confirm(action, overrides = {}) {
        await pending
        if (scenario.id === '16') await rawRequest('/api/evaluation/change-order', { updatedAt: evidence.state.orders[0].updatedAt })
        if (Object.keys(overrides).length || confirming.has(action.id)) {
          const result = await rawRequest(`/api/actions/${action.id}/confirm`, { confirmed: true, approved: true, ...overrides })
          assert.equal(result.status, 200); const body = await result.json()
          // A real confirmation click reloads the recorded replay result into the existing card.
          if (Object.keys(overrides).length) {
            const card = page.getByRole('region', { name: `${action.title} confirmation` })
            const checkbox = card.getByRole('checkbox')
            if (await checkbox.count()) await checkbox.check()
            await clickAction(action, 'confirm')
          }
          await sync(); return body.action
        }
        confirming.add(action.id)
        const card = page.getByRole('region', { name: `${action.title} confirmation` })
        const checkbox = card.getByRole('checkbox')
        if (await checkbox.count()) await checkbox.check()
        await clickAction(action, 'confirm')
        await sync(); return actions.find((a) => a.id === action.id)!
      },
      async check(action) {
        await pending
        const card = page.getByRole('region', { name: `${action.title} confirmation` })
        const button = card.getByRole('button', { name: 'Check Shopify status', exact: true })
        if (await button.count()) {
          await clickAction(action, 'check')
        } else await rawRequest(`/api/actions/${action.id}/check`, {})
        await sync(); return actions.find((a) => a.id === action.id)!
      },
      request: rawRequest,
    }
    let error: string | undefined
    try {
      await scenario.run(c)
      for (const action of actions) await assertActionDisplay(action)
      checks.push('Confirmation cards and full chat action records match persisted server statuses')
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
    await sync()
    // Capture the actual chat and action cards. Expand the scroll area only so all conversation turns are visible.
    await page.addStyleTag({ content: '.chat-scroll{max-height:none!important;height:auto!important;overflow:visible!important}.chat-panel{max-height:none!important}.chat-activity-detail{max-height:72px;overflow:hidden}' })
    await page.locator('.chat-panel').screenshot({ path: resolve(output, `${scenario.id}.png`) })
    const result = { id: scenario.id, title: scenario.title, status: error ? 'failed' : 'passed', ...(error ? { error } : {}), checks, prompts: scenario.prompts, replies, evidence }
    results.push(result)
    await writeFile(resolve(output, `${scenario.id}.json`), JSON.stringify(result, null, 2))
    console.log(`${result.status.toUpperCase()} UI ${scenario.id} ${scenario.title}${error ? `: ${error}` : ''}`)
    await browserContext.close()
  }
} finally { await browser.close() }
const passed = results.filter((r) => r.status === 'passed').length
await writeFile(resolve(output, 'results.json'), JSON.stringify({ mode: 'Actual browser UI; real model; controlled Shopify API', passed, failed: results.length - passed, results }, null, 2))
await writeFile(resolve(output, 'gallery.html'), `<!doctype html><meta charset="utf-8"><title>Agent UI evidence</title><style>body{font:16px system-ui;background:#f5f1e8;color:#193f30;margin:30px}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}article{background:white;padding:16px;border:1px solid #bed0be;border-radius:12px}img{width:100%;height:420px;object-fit:contain;object-position:top}a{color:inherit}</style><h1>Agent UI evaluation evidence</h1><p>${passed}/${results.length} passed · Actual prompts and action cards · Real model · Controlled Shopify test data</p><main>${results.map((r) => `<article><h2>${r.id}. ${r.title} — ${r.status}</h2><a href="${r.id}.png"><img src="${r.id}.png" alt="Actual chat result for ${r.title}"></a></article>`).join('')}</main>`)
console.log(`UI results: ${passed} passed, ${results.length - passed} failed. ${output}/gallery.html`)
process.exitCode = results.length === passed ? 0 : 1
