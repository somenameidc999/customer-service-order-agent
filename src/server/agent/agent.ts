import type { AgentEvent, ChatMessage } from '../../shared/chat.js'
import { createOpenRouterClient, type LlmClient, type LlmMessage } from './openrouter.js'
import { planGuidance, planTurn } from './planner.js'
import { createCommerceToolRegistry, type ToolRegistry } from './tools.js'

export type AgentEmitter = (event: AgentEvent) => void

export interface AgentTurnInput {
  messages: ChatMessage[]
}

/** Shape the chat route depends on; injectable so tests stay offline. */
export type AgentRunner = (input: AgentTurnInput, emit: AgentEmitter) => Promise<void>

export interface AgentOptions {
  llm?: LlmClient
  tools?: ToolRegistry
  maxRounds?: number
}

const SYSTEM_PROMPT = [
  'You are the hub coordinator for a customer service order application.',
  'You do not call Shopify directly: decide which spoke (subagent) should handle each',
  'step, spawn it by calling its tool, and aggregate the result into one reply.',
  'Prefer calling a tool over guessing whenever a tool can answer the question:',
  'use findCustomer/getCustomer for identity, the order tools for order status and edits,',
  'the product tools for product information, the refund tools for refund history and refunds,',
  'get_server_time for date or time questions, calculate for arithmetic, and search_docs for',
  'questions about how this application or agent works.',
  'Never disclose order or customer data before the customer has been identified.',
  'After a tool returns, use its result in your reply.',
].join(' ')

/**
 * Hooks run before and after each model request. Each hook is observable through
 * a `hook` event so the chat interface can show that a hook is being used.
 */
interface AgentHook {
  name: string
  run: (context: { messages: LlmMessage[]; round: number }) => void | Promise<void>
}

function defaultHooks(): AgentHook[] {
  return [
    {
      name: 'guardrails',
      run: ({ messages }) => {
        const last = messages[messages.length - 1]
        if (last && typeof last.content === 'string' && last.content.length > 4000) {
          throw new Error('Message is too long for the agent.')
        }
      },
    },
    {
      name: 'logging',
      run: ({ round }) => {
        console.log(`[agent] model request round=${round}`)
      },
    },
  ]
}

function parseArguments(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function toLlmMessages(messages: ChatMessage[], guidance?: string): LlmMessage[] {
  return [
    { role: 'system', content: guidance ? `${SYSTEM_PROMPT} ${guidance}` : SYSTEM_PROMPT },
    ...messages
      .filter((message) => message.content.trim().length > 0)
      .map((message) => ({ role: message.role, content: message.content })),
  ]
}

function lastUserMessage(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === 'user') return message.content
  }
  return ''
}

/**
 * Run one conversational turn: request a completion, execute any tool calls
 * through their owning spoke, then produce a final assistant message. Every
 * hook, spoke and tool call is emitted as an event.
 */
export function createAgentTurn(options: AgentOptions = {}): AgentRunner {
  const llm = options.llm ?? createOpenRouterClient()
  const tools = options.tools ?? createCommerceToolRegistry()
  const maxRounds = options.maxRounds ?? 5
  const hooks = defaultHooks()

  return async function runTurn(input, emit) {
    emit({ type: 'hook', name: 'agent-turn', phase: 'start' })
    try {
      // The coordinator plans before the model runs so the right spokes are
      // spawned in the right order (identity before order data, etc.).
      const plan = planTurn(lastUserMessage(input.messages))
      emit({
        type: 'plan',
        intent: plan.intent,
        spokes: plan.spokes,
        requiresCustomerIdentification: plan.requiresCustomerIdentification,
        requiresConfirmation: plan.requiresConfirmation,
      })
      const messages = toLlmMessages(input.messages, planGuidance(plan))

      for (let round = 0; round < maxRounds; round += 1) {
        for (const hook of hooks) {
          emit({ type: 'hook', name: hook.name, phase: 'start' })
          await hook.run({ messages, round })
          emit({ type: 'hook', name: hook.name, phase: 'end' })
        }

        const completion = await llm.complete({ messages, tools: tools.specs })

        if (completion.toolCalls.length === 0) {
          emit({ type: 'assistant_message', text: completion.content?.trim() || 'I did not have a reply for that.' })
          return
        }

        messages.push({
          role: 'assistant',
          content: completion.content ?? '',
          tool_calls: completion.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.argumentsText },
          })),
        })

        for (const call of completion.toolCalls) {
          const tool = tools.get(call.name)
          const spoke = tool?.spoke ?? 'unknown'
          emit({ type: 'subagent', name: spoke, phase: 'start', detail: call.name })
          emit({ type: 'tool_call', id: call.id, name: call.name, phase: 'start', args: call.argumentsText })

          let result: string
          let ok = true
          try {
            result = tool ? await tool.run(parseArguments(call.argumentsText)) : `Unknown tool "${call.name}".`
            if (!tool) ok = false
          } catch (error) {
            ok = false
            result = error instanceof Error ? error.message : 'Tool failed.'
          }

          emit({ type: 'tool_call', id: call.id, name: call.name, phase: 'end', result, ok })
          emit({ type: 'subagent', name: spoke, phase: 'end', detail: call.name })
          messages.push({ role: 'tool', content: result, tool_call_id: call.id })
        }
      }

      emit({ type: 'error', message: 'The agent reached its maximum number of tool rounds.' })
    } finally {
      emit({ type: 'hook', name: 'agent-turn', phase: 'end' })
    }
  }
}
