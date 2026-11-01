import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import type { AgentEvent, ChatRequestBody } from '../../shared/chat.js'
import type { ShopifyActionView } from '../../shared/actions.js'
import { createEvaluationEnvironment } from './environment.js'
import { createEvaluationApp } from './server.js'
import { scenarios, type EvaluationContext, type EvaluationScenario } from './scenarios.js'
import { selectEvaluationScenarios, validateEvaluationRuns } from './selection.js'

export interface EvaluationResult {
  id: string; title: string; status: 'passed' | 'failed'; durationMs: number
  prompts: string[]; checks: string[]; error?: string; replies: string[]; events: AgentEvent[]
  evidence: unknown
}
export async function runScenario(scenario: EvaluationScenario, variant = 0): Promise<EvaluationResult> {
  const environment = createEvaluationEnvironment()
  environment.reset(scenario.setup)
  const app = createEvaluationApp(environment)
  const events: AgentEvent[] = [], checks: string[] = [], replies: string[] = []
  const messages: ChatRequestBody['messages'] = []
  const actualPrompts: string[] = []
  let sessionId = 'a'.repeat(64)
  const started = Date.now()
  const request = async (path: string, body: unknown, session = sessionId) => app.request(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `order_chat=${session}`, origin: 'http://localhost' }, body: JSON.stringify(body),
  })
  const c: EvaluationContext = {
    environment, events, sessionId,
    prove(condition: unknown, description: string): void { assert.ok(condition, description); checks.push(description) },
    async turn(prompt) {
      if (!actualPrompts.length && variant === 1) prompt = `Hello, I need help. ${prompt}`
      if (!actualPrompts.length && variant === 2) prompt = `Please help with the following request: ${prompt}`
      actualPrompts.push(prompt)
      messages.push({ role: 'user', content: prompt })
      const response = await request('/api/chat', { messages })
      assert.equal(response.status, 200, 'Chat request succeeds')
      const cookie = response.headers.get('set-cookie')?.match(/order_chat=([a-f0-9]{64})/)
      if (cookie) { sessionId = cookie[1]!; c.sessionId = sessionId }
      const batch = (await response.text()).split('\n\n').filter((s) => s.startsWith('data: ')).map((s) => JSON.parse(s.slice(6)) as AgentEvent)
      events.push(...batch)
      const errors = batch.filter((e) => e.type === 'error')
      assert.equal(errors.length, 0, `No unhandled agent error: ${JSON.stringify(errors)}`)
      const reply = batch.filter((e): e is Extract<AgentEvent, { type: 'assistant_message' }> => e.type === 'assistant_message').map((e) => e.text).join('\n')
      assert.ok(reply.trim(), 'Agent provides visible reply')
      if (!environment.calls.some((call) => call.mutation)) assert.doesNotMatch(reply, /\bI have (?:successfully )?(?:refunded|cancelled|updated)|\b(?:refund|cancellation) (?:has )?(?:succeeded|completed)\b/i, 'Assistant cannot claim a completed write without a mutation')
      replies.push(reply); messages.push({ role: 'assistant', content: reply })
      return reply
    },
    actions: () => environment.store.list(sessionId), handoffs: () => environment.handoffs.list(sessionId), request,
    async confirm(action, overrides = {}) {
      const response = await request(`/api/actions/${action.id}/confirm`, { confirmed: true, approved: true, ...overrides })
      assert.equal(response.status, 200, `Confirmation HTTP response: ${response.status}`)
      return (await response.json() as { action: ShopifyActionView }).action
    },
    async check(action) {
      const response = await request(`/api/actions/${action.id}/check`, {})
      assert.equal(response.status, 200)
      return (await response.json() as { action: ShopifyActionView }).action
    },
  }
  let error: string | undefined
  try { await scenario.run(c) } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
  const result: EvaluationResult = { id: scenario.id, title: scenario.title, status: error ? 'failed' : 'passed', durationMs: Date.now() - started,
    prompts: actualPrompts, checks, ...(error ? { error } : {}), replies, events,
    evidence: { ...environment.inspect(), actions: c.actions(), handoffs: environment.handoffs.list(sessionId) } }
  environment.close()
  return result
}
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export async function runEvaluations(options: { ids?: string[]; output?: string; repeat?: number; variants?: number } = {}) {
  const selected = selectEvaluationScenarios(scenarios, options.ids)
  const repeat = options.repeat ?? 1, variants = options.variants ?? 1
  validateEvaluationRuns(repeat, variants)
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error('OPENROUTER_API_KEY is required. Model evaluations never fall back to scripted responses.')
  const directory = resolve(options.output ?? 'artifacts/evaluations')
  await mkdir(directory, { recursive: true })
  const results: EvaluationResult[] = []
  for (let repetition = 0; repetition < repeat; repetition++) for (let variant = 0; variant < variants; variant++) for (const scenario of selected) {
    const result = await runScenario(scenario, variant); results.push(result)
    await writeFile(resolve(directory, `${result.id}-v${variant + 1}-r${repetition + 1}.json`), JSON.stringify(result, null, 2))
    console.log(`${result.status.toUpperCase()} ${result.id} ${result.title}${result.error ? `: ${result.error}` : ''}`)
  }
  const report = { at: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini', mode: 'Real model; production coordinator and Shopify client; controlled Shopify API',
    passed: results.filter((r) => r.status === 'passed').length, failed: results.filter((r) => r.status === 'failed').length, results }
  await writeFile(resolve(directory, 'results.json'), JSON.stringify(report, null, 2))
  await writeFile(resolve(directory, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Order agent evaluations</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;color:#183b2d}h1{font-size:30px}article{border:1px solid #b6c9bd;border-radius:10px;margin:16px 0;padding:20px}.passed{border-left:8px solid #21864b}.failed{border-left:8px solid #bb3434}pre{white-space:pre-wrap;background:#f2f5ef;padding:12px}small{color:#53635a}</style><h1>Order agent evaluation evidence</h1><p>${report.passed} passed · ${report.failed} failed</p><p>${escape(report.mode)}</p><small>${escape(report.model)} · ${report.at} · ${report.revision}</small>${results.map((r) => `<article class="${r.status}"><h2>${r.id}. ${escape(r.title)} — ${r.status.toUpperCase()}</h2>${r.error ? `<p>${escape(r.error)}</p>` : ''}<ul>${r.checks.map((c) => `<li>${escape(c)}</li>`).join('')}</ul>${r.prompts.map((p, i) => `<p><b>Customer:</b> ${escape(p)}</p><pre>${escape(r.replies[i] ?? '(not reached)')}</pre>`).join('')}<details><summary>Observed tool sequence</summary><pre>${escape(r.events.filter((e) => e.type === 'tool_call' && e.phase === 'start').map((e) => e.type === 'tool_call' ? `${e.name} ${e.args ?? ''}` : '').join('\n'))}</pre></details></article>`).join('')}`)
  console.log(`Results: ${report.passed} passed, ${report.failed} failed. ${directory}/report.html`)
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const ids = process.argv.find((v) => v.startsWith('--ids='))?.slice(6).split(',')
  const output = process.argv.find((v) => v.startsWith('--output='))?.slice(9)
  const repeat = Number(process.argv.find((v) => v.startsWith('--repeat='))?.slice(9) ?? 1)
  const variants = Number(process.argv.find((v) => v.startsWith('--variants='))?.slice(11) ?? 1)
  const report = await runEvaluations({ ids, output, repeat, variants }); process.exitCode = report.failed ? 1 : 0
}
