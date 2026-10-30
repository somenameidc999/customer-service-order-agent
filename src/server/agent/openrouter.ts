import type { ToolSpec } from './tools.js'

export interface LlmToolCall {
  id: string
  name: string
  /** Raw JSON string of the tool arguments, exactly as the provider returned it. */
  argumentsText: string
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface LlmCompletion {
  content: string | null
  toolCalls: LlmToolCall[]
}

export interface LlmClient {
  complete(input: { messages: LlmMessage[]; tools: ToolSpec[]; signal?: AbortSignal }): Promise<LlmCompletion>
}

export const DEFAULT_MODEL = 'openai/gpt-4o-mini'
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

function apiKey(): string {
  return process.env.OPENROUTER_API_KEY?.trim() ?? ''
}

export function hasOpenRouterKey(): boolean {
  return apiKey().length > 0
}

/**
 * Live OpenRouter client. The API key is read from `OPENROUTER_API_KEY`; it is
 * never logged or echoed back in errors.
 */
export function createOpenRouterClient(options: { model?: string; baseUrl?: string } = {}): LlmClient {
  const model = options.model ?? process.env.OPENROUTER_MODEL?.trim() ?? DEFAULT_MODEL
  const baseUrl = (options.baseUrl ?? process.env.OPENROUTER_BASE_URL?.trim() ?? OPENROUTER_BASE_URL).replace(/\/$/, '')

  return {
    async complete({ messages, tools, signal }) {
      const key = apiKey()
      if (!key) {
        throw new Error('OPENROUTER_API_KEY is not configured on the server, so the agent cannot reply.')
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': process.env.OPENROUTER_SITE_URL?.trim() ?? 'http://localhost:8787',
          'X-Title': 'customer-service-order-agent',
        },
        body: JSON.stringify({
          model,
          messages,
          ...(tools.length > 0 ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
        }),
        signal: signal ?? AbortSignal.timeout(60000),
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`OpenRouter request failed (${response.status}). ${detail.slice(0, 300)}`.trim())
      }

      const payload = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string | null
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
          }
        }>
      }
      const message = payload.choices?.[0]?.message
      const toolCalls: LlmToolCall[] = (message?.tool_calls ?? [])
        .filter((call) => call.function?.name)
        .map((call, index) => ({
          id: call.id ?? `call_${index}`,
          name: call.function?.name ?? 'unknown',
          argumentsText: call.function?.arguments ?? '{}',
        }))

      return { content: message?.content ?? null, toolCalls }
    },
  }
}
