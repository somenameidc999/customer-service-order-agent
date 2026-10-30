import type { Context } from 'hono'
import { CHAT_LIMITS, type AgentEvent, type ChatMessage, type ChatRequestBody, type ChatRole } from '../../shared/chat.js'
import { createAgentTurn, type AgentRunner } from './agent.js'

const ROLES: ChatRole[] = ['user', 'assistant']

export interface ValidatedMessage {
  role: ChatRole
  content: string
}

export function validateChatBody(body: unknown): { ok: true; messages: ValidatedMessage[] } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Request body must be a JSON object.' }
  const messages = (body as ChatRequestBody).messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'Provide at least one message.' }
  }
  if (messages.length > CHAT_LIMITS.maxMessages) {
    return { ok: false, error: `Provide at most ${CHAT_LIMITS.maxMessages} messages.` }
  }
  const validated: ValidatedMessage[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object' || !ROLES.includes(message.role) || typeof message.content !== 'string') {
      return { ok: false, error: 'Each message needs a role of "user" or "assistant" and string content.' }
    }
    const content = message.content.trim()
    if (!content) return { ok: false, error: 'Messages cannot be empty.' }
    if (content.length > CHAT_LIMITS.maxMessageLength) {
      return { ok: false, error: `Messages must be ${CHAT_LIMITS.maxMessageLength} characters or fewer.` }
    }
    validated.push({ role: message.role, content })
  }
  return { ok: true, messages: validated }
}

function toChatMessages(messages: ValidatedMessage[]): ChatMessage[] {
  const now = new Date().toISOString()
  return messages.map((message, index) => ({
    id: `m${index}`,
    role: message.role,
    content: message.content,
    createdAt: now,
  }))
}

function streamEvent(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/**
 * `POST /api/chat` streams an agent turn as server-sent events. Failures are
 * streamed as an explicit `error` event so the interface can keep them visible.
 */
export function createChatHandler(runTurn: AgentRunner = createAgentTurn()) {
  return async (c: Context): Promise<Response> => {
    const contentLength = Number(c.req.header('content-length') ?? '0')
    if (contentLength > CHAT_LIMITS.maxRequestBodyBytes) {
      return c.json({ error: 'Request body is too large.' }, 413)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Request body must be valid JSON.' }, 400)
    }

    const result = validateChatBody(body)
    if (!result.ok) return c.json({ error: result.error }, 400)

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false
        const emit = (event: AgentEvent) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(streamEvent(event)))
          } catch {
            closed = true
          }
        }
        try {
          await runTurn({ messages: toChatMessages(result.messages) }, emit)
        } catch (error) {
          emit({ type: 'error', message: error instanceof Error ? error.message : 'The agent failed unexpectedly.' })
        } finally {
          emit({ type: 'done' })
          closed = true
          try {
            controller.close()
          } catch {
            // Already closed by the client disconnecting.
          }
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }
}
