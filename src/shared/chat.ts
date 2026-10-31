// Shared types for the chat interface. These are used by both the Hono chat
// route (server) and the chat panel (client).

export type ChatRole = 'user' | 'assistant'

/** A single turn in the visible chat history. */
export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: string
}

/**
 * Events streamed from `POST /api/chat` while a turn is running. The client
 * renders assistant text plus live activity for hooks, subagents and tool calls.
 */
export type AgentEvent =
  | { type: 'hook'; name: string; phase: 'start' | 'end'; detail?: string }
  | { type: 'plan'; intent: string; spokes: string[]; requiresCustomerIdentification: boolean; requiresConfirmation: boolean }
  | { type: 'subagent'; name: string; phase: 'start' | 'end'; detail?: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      phase: 'start' | 'end'
      args?: string
      result?: string
      ok?: boolean
    }
  | { type: 'assistant_message'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

/** Request body accepted by `POST /api/chat`. */
export interface ChatRequestBody {
  messages: Array<{ role: ChatRole; content: string }>
}

export const CHAT_LIMITS = {
  maxMessages: 50,
  maxMessageLength: 4000,
  maxRequestBodyBytes: 64 * 1024,
} as const

/**
 * `POST /api/chat` rejects a body with more than `CHAT_LIMITS.maxMessages`
 * messages. The panel builds history from the whole visible conversation, so
 * trim it to the most recent messages before sending. Without this a chat
 * becomes permanently unusable once it passes the server limit.
 */
export function limitChatHistory<T>(messages: readonly T[], maxMessages: number = CHAT_LIMITS.maxMessages): T[] {
  const limit = Number.isFinite(maxMessages) ? Math.max(0, Math.floor(maxMessages)) : CHAT_LIMITS.maxMessages
  if (limit === 0) return []
  return messages.length > limit ? messages.slice(messages.length - limit) : messages.slice()
}

/** Keep visible history intact while fitting the server's count, text and byte limits. */
export function buildChatRequest(messages: readonly Pick<ChatMessage, 'role' | 'content'>[]): ChatRequestBody {
  const history = limitChatHistory(messages)
    .map(({ role, content }) => ({ role, content: content.slice(0, CHAT_LIMITS.maxMessageLength) }))
    .filter(({ content }) => content.trim().length > 0)
  const encoder = new TextEncoder()
  while (history.length > 1 && encoder.encode(JSON.stringify({ messages: history })).byteLength > CHAT_LIMITS.maxRequestBodyBytes) {
    history.shift()
  }
  return { messages: history }
}
