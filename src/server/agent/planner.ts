// Deterministic coordinator routing for the hub agent.
//
// The hub classifies the customer's intent and decides which Shopify spoke(s)
// to spawn and in what order. Keeping this logic deterministic (rather than
// model-driven) means routing can be unit-tested and audited. See
// docs/agents.md ("Routing summary") and docs/architecture.md ("Request flow").

import type { ShopifySpokeName } from './shopify-spokes.js'

export type CustomerIntent =
  | 'order_status'
  | 'refund_request'
  | 'order_edit'
  | 'product_question'
  | 'general'

export interface TurnPlan {
  intent: CustomerIntent
  /** Spokes to run, in order. The hub spawns them sequentially. */
  spokes: ShopifySpokeName[]
  /** True when the hub must identify the customer before reading order data. */
  requiresCustomerIdentification: boolean
  /** True when a write needs explicit customer confirmation first. */
  requiresConfirmation: boolean
  /** True when a destructive/high-risk action needs human approval. */
  requiresHumanApproval: boolean
  /** One-line human-readable plan for the audit log and the model prompt. */
  summary: string
}

const REFUND = /\b(refund|refunds|money\s+back|reimburse(?:ment)?|charge\s?back)\b/i
const ORDER_STATUS = /\b(ready|where|status|track|tracking|shipped|shipping|delivered|delivery|arriv(?:e|ed|ing)|eta)\b/i
const EDIT_VERB = /\b(change|update|edit|cancel|remove|add|swap|correct)\b/i
const EDIT_TARGET = /\b(address|shipping|item|items|line\s?item|order)\b/i
const PRODUCT = /\b(product|item|quality|sucks|broken|defect(?:ive)?|damaged|faulty|description|review)\b/i
const PURCHASE_REFERENCE = /\b(i\s+ordered|i\s+bought|i\s+purchased|my\s+(?:order|purchase))\b/i
// Destructive order edits always require human approval, not just customer
// confirmation (docs/security.md §6, docs/agents.md routing summary).
const DESTRUCTIVE_EDIT = /\b(cancel|remove|delete)\b/i

export function classifyIntent(message: string): CustomerIntent {
  const text = message.trim()
  if (REFUND.test(text)) return 'refund_request'
  if (EDIT_VERB.test(text) && EDIT_TARGET.test(text)) return 'order_edit'
  if (ORDER_STATUS.test(text)) return 'order_status'
  if (PRODUCT.test(text)) return 'product_question'
  return 'general'
}

/**
 * Build the spoke plan for one customer message. The order encodes the hub's
 * sequencing rules: identity before order data, and order data before a write.
 */
export function planTurn(message: string): TurnPlan {
  const intent = classifyIntent(message)
  switch (intent) {
    case 'order_status':
      return {
        intent,
        spokes: ['customer', 'order'],
        requiresCustomerIdentification: true,
        requiresConfirmation: false,
        requiresHumanApproval: false,
        summary: 'Identify the customer, then read their order status.',
      }
    case 'refund_request':
      return {
        intent,
        spokes: ['customer', 'order', 'refund'],
        requiresCustomerIdentification: true,
        requiresConfirmation: true,
        requiresHumanApproval: true,
        summary: 'Identify the customer, read the order, then quote and (after confirmation) refund.',
      }
    case 'order_edit': {
      const destructive = DESTRUCTIVE_EDIT.test(message)
      return {
        intent,
        spokes: ['customer', 'order'],
        requiresCustomerIdentification: true,
        requiresConfirmation: true,
        requiresHumanApproval: destructive,
        summary: destructive
          ? 'Identify the customer, read the order, then apply the confirmed edit once a human approves it.'
          : 'Identify the customer, read the order, then apply the confirmed edit.',
      }
    }
    case 'product_question':
      return PURCHASE_REFERENCE.test(message)
        ? {
            intent,
            spokes: ['customer', 'order', 'product'],
            requiresCustomerIdentification: true,
            requiresConfirmation: false,
            requiresHumanApproval: false,
            summary: 'Identify the customer, find the product on their order, then relay product details.',
          }
        : {
            intent,
            spokes: ['product'],
            requiresCustomerIdentification: false,
            requiresConfirmation: false,
            requiresHumanApproval: false,
            summary: 'Read and relay product information.',
          }
    default:
      return {
        intent: 'general',
        spokes: [],
        requiresCustomerIdentification: false,
        requiresConfirmation: false,
        requiresHumanApproval: false,
        summary: 'Answer directly; no Shopify spoke is required.',
      }
  }
}

/**
 * Render the plan as instructions for the hub model. Inserted into the system
 * prompt so the coordinator spawns the right spokes in the right order instead
 * of guessing.
 */
export function planGuidance(plan: TurnPlan): string {
  if (plan.spokes.length === 0) {
    return 'Hub routing for this turn: no Shopify spoke is required. Answer directly.'
  }
  const sequence = plan.spokes.join(' -> ')
  return [
    `Hub routing for this turn: intent "${plan.intent}".`,
    `Spawn these spokes in order: ${sequence}.`,
    plan.requiresCustomerIdentification
      ? 'You must identify the customer with findCustomer (order number plus a matching email or phone) before reading any order data.'
      : 'No customer identification is required for this turn.',
    plan.requiresConfirmation
      ? 'Before any write, summarize the change, obtain explicit customer confirmation, and pass the confirmationToken and idempotencyKey.'
      : '',
    plan.requiresHumanApproval
      ? 'This action needs explicit human approval before the write executes; do not call the write tool until that approval is recorded.'
      : '',
    'Do not call a spoke outside this sequence.',
  ].filter((part) => part.length > 0).join(' ')
}
