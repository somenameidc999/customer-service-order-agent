import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ShopifyClient } from '../shopify/client.js'
import { createShopifyLiveClient } from '../shopify/live-client.js'
import type { AuthorizationContext } from './authorization.js'
import { createShopifySpokeTools } from './shopify-spokes.js'

/** A tool exposed to the model, owned by a single spoke (subagent). */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * Per-turn execution context. The hub creates a fresh authorization context for
 * every agent turn so a verified identity never leaks between turns or sessions.
 */
export interface ToolContext {
  authorization: AuthorizationContext
}

export interface ToolDefinition {
  /** The spoke (subagent) that owns and executes this tool. */
  spoke: string
  spec: ToolSpec
  /**
   * Execute the tool. Resolves to a short human-readable result. Tools that
   * touch customer data fail closed when the context carries no identity.
   */
  run: (args: Record<string, unknown>, context?: ToolContext) => Promise<string> | string
}

const docsDirectory = fileURLToPath(new URL('../../../docs/', import.meta.url))

function asNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`"${field}" must be a finite number.`)
  return parsed
}

/**
 * Search the repository documentation. This is a real, offline tool so the
 * knowledge spoke can answer questions about this project without inventing
 * facts or reaching the network.
 */
async function searchDocs(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '').trim().toLowerCase()
  if (!query) throw new Error('"query" is required.')
  const files = ['README.md', 'architecture.md', 'agents.md', 'shopify-integration.md', 'security.md', 'implementation-plan.md']
  const matches: string[] = []
  for (const file of files) {
    let contents: string
    try {
      contents = await readFile(join(docsDirectory, file), 'utf8')
    } catch {
      continue
    }
    contents.split('\n').forEach((line, index) => {
      if (line.toLowerCase().includes(query) && matches.length < 8) {
        matches.push(`${file}:${index + 1}: ${line.trim().slice(0, 200)}`)
      }
    })
  }
  return matches.length > 0 ? matches.join('\n') : `No documentation matched "${query}".`
}

export const toolDefinitions: ToolDefinition[] = [
  {
    spoke: 'system',
    spec: {
      name: 'get_server_time',
      description: 'Return the current server time in ISO-8601 format. Use when the user asks what time or date it is.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: () => new Date().toISOString(),
  },
  {
    spoke: 'pricing',
    spec: {
      name: 'calculate',
      description: 'Perform deterministic arithmetic on two numbers. Use instead of doing math in your head.',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'Left operand.' },
          b: { type: 'number', description: 'Right operand.' },
          operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
        },
        required: ['a', 'b', 'operation'],
        additionalProperties: false,
      },
    },
    run: (args) => {
      const a = asNumber(args.a, 'a')
      const b = asNumber(args.b, 'b')
      switch (args.operation) {
        case 'add': return String(a + b)
        case 'subtract': return String(a - b)
        case 'multiply': return String(a * b)
        case 'divide':
          if (b === 0) throw new Error('Cannot divide by zero.')
          return String(a / b)
        default: throw new Error('"operation" must be one of add, subtract, multiply, divide.')
      }
    },
  },
  {
    spoke: 'knowledge',
    spec: {
      name: 'search_docs',
      description: 'Search this project\'s documentation for a term and return matching lines. Use when asked about how this application or agent works.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Term to search for.' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    run: (args) => searchDocs(args),
  },
]

export interface ToolRegistry {
  specs: ToolSpec[]
  get: (name: string) => ToolDefinition | undefined
}

export function createToolRegistry(definitions: ToolDefinition[] = toolDefinitions): ToolRegistry {
  const byName = new Map(definitions.map((definition) => [definition.spec.name, definition]))
  return {
    specs: definitions.map((definition) => definition.spec),
    get: (name) => byName.get(name),
  }
}

/**
 * The hub's full tool set: built-in utilities plus every Shopify spoke.
 * Application calls use live Shopify data. Tests must inject their own client.
 */
export function createCommerceToolRegistry(client?: ShopifyClient, context?: { sessionId?: string }): ToolRegistry {
  client ??= createShopifyLiveClient({ sessionId: context?.sessionId })
  return createToolRegistry([...toolDefinitions, ...createShopifySpokeTools(client)])
}
