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
  | 'human_request'
  | 'withdraw_request'
  | 'unsupported_edit'
  | 'action_status'
  | 'cancel_refund'

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

const REFUND = /\b(refund|refunds|money\s+back|reimburse(?:ment)?|charge\s?back|charged\s+(?:me\s+)?twice|double[- ]charged|duplicate\s+charge)\b/i
const ORDER_STATUS = /\b(ready|where|status|track|tracking|shipped|shipping|delivered|delivery|arriv(?:e|ed|ing)|eta)\b/i
const EDIT_VERB = /\b(change|update|edit|cancel|remove|add|swap|correct)\b/i
const EDIT_TARGET = /\b(address|shipping|item|items|line\s?item|order)\b/i
const PRODUCT = /\b(product|item|quality|sucks|broken|defect(?:ive)?|damaged|faulty|description|review)\b/i
const PURCHASE_REFERENCE = /\b(i\s+ordered|i\s+bought|i\s+purchased|my\s+(?:order|purchase))\b/i
// Destructive order edits always require human approval, not just customer
// confirmation (docs/security.md §6, docs/agents.md routing summary).
const DESTRUCTIVE_EDIT = /\b(cancel|remove|delete)\b/i

interface ScopedOperations {
  text: string
  refund?: boolean
  cancel?: boolean
  edit?: boolean
}

/** Keep a negative qualifier attached to its own operation, not the whole turn. */
function scopedOperations(message: string): ScopedOperations {
  // Quoted instructions are evidence, not a fresh customer request. Do not
  // treat apostrophes inside contractions as quotation delimiters.
  const text = message.replace(/"[^"\n]*"|“[^”\n]*”|(?:^|\s)'[^'\n]+'(?=\s|[.,;!?]|$)/g, ' ')
  const result: ScopedOperations = { text }
  const words = /\b(cancel|refunds?|reimburse(?:ment)?|money\s+back|charge\s?back|charged\s+(?:me\s+)?twice|double[- ]charged|duplicate\s+charge|change|update|edit|remove|add|swap|correct)\b/gi
  const ignored: Array<{ start: number; end: number }> = []
  let previous: { end: number; clauseStart: number; negative: boolean } | undefined
  for (const match of text.matchAll(words)) {
    const start = match.index!
    const boundaries = Array.from(text.slice(0, start).matchAll(/[.!?;,\n]|\b(?:but|however|actually)\b/gi))
    const boundary = boundaries.at(-1)
    const clauseStart = boundary ? boundary.index! + boundary[0].length : 0
    const prefix = text.slice(clauseStart, start)
    const kind = /^cancel$/i.test(match[0]) ? 'cancel' : REFUND.test(match[0]) ? 'refund' : 'edit'
    const historical = /\b(?:earlier|previously|yesterday|last time)\b/i.test(prefix) && /\b(?:said|asked|wanted|requested)\b/i.test(prefix) && !/\b(?:now|please)\b/i.test(prefix)
    if (historical) { ignored.push({ start, end: start + match[0].length }); continue }
    const directNegative = /\b(?:(?:do not|don't|don’t|never|not|no longer)\s+(?:(?:want|wish|need|request|authorize)(?:\s+to)?\s+)?(?:an?\s+)?|(?:no|without)\s+(?:an?\s+)?|instead of\s+|stop\s+(?:(?:the|my|this)\s+)?)$/i.test(prefix)
    const sharedNegative = previous?.negative && previous.clauseStart === clauseStart &&
      /\b(?:and|or|nor)\s*$/i.test(text.slice(previous.end, start)) &&
      !/\b(?:please|now|instead|i want|i need)\b/i.test(text.slice(previous.end, start))
    const negative = directNegative || Boolean(sharedNegative)
    result[kind] = !negative
    if (negative) ignored.push({ start, end: start + match[0].length })
    previous = { end: start + match[0].length, clauseStart, negative }
  }
  // The existing domain keyword rules see only non-negated, current operations.
  for (const span of ignored.reverse()) result.text = result.text.slice(0, span.start) + ' '.repeat(span.end - span.start) + result.text.slice(span.end)
  return result
}

export function classifyIntent(message: string): CustomerIntent {
  const operations = scopedOperations(message.trim())
  const text = operations.text
  if ((/^\s*(?:(?:an?|the)\s+)?agent(?:\s+please)?[.!]?\s*$/i.test(text) || /\b(?:speak|talk|connect|transfer)\b.{0,25}\b(?:agent|person)\b/i.test(text) || /\b(?:human|real person|representative|supervisor|support agent|speak to someone|talk to someone)\b/i.test(text)) && !/\b(?:no|not|don't|do not) (?:need|want) (?:a )?human\b/i.test(text)) return 'human_request'
  if (/^\s*(?:please\s+)?(?:stop|wait|hold on|forget it|cancel that|cancel the request)(?:\s+please)?[.!]?\s*$/i.test(message.trim()) || /\b(?:never ?mind|cancel (?:the |my |this )?(?:refund request|cancellation request|request|proposal)|hold off|leave (?:it|the order) (?:alone|unchanged))\b/i.test(text)) return 'withdraw_request'
  if ((operations.refund === false || operations.cancel === false || operations.edit === false) && !operations.refund && !operations.cancel && !operations.edit) return 'withdraw_request'
  if (/\b(?:did|has|is|was)\b.*\b(?:refund|cancellation|address|change)\b.*\b(?:go through|complete|completed|processed|succeed|succeeded|saved|done|pending)\b|\b(?:refund|cancellation|action) status\b|\bcheck (?:the |my )?(?:action|refund|cancellation)\b/i.test(text)) return 'action_status'
  if (EDIT_VERB.test(text) && /\b(?:quantity|quantities|discount|line items?|products?|size|color|colour|two more|more items)\b/i.test(text) && !/\b(?:shipping|address)\b/i.test(text)) return 'unsupported_edit'
  if (operations.refund && operations.cancel) return 'cancel_refund'
  if (operations.refund) return 'refund_request'
  if ((operations.cancel || operations.edit) && EDIT_VERB.test(text) && EDIT_TARGET.test(text)) return 'order_edit'
  if (ORDER_STATUS.test(text)) return 'order_status'
  if (PRODUCT.test(text)) return 'product_question'
  return 'general'
}

/**
 * Build the spoke plan for one customer message. The order encodes the hub's
 * sequencing rules: identity before order data, and order data before a write.
 */
export function planTurn(message: string, history: readonly { role: string; content: string }[] = []): TurnPlan {
  let intent = classifyIntent(message)
  // A reply containing identifiers continues the most recent customer task. Never
  // infer authorization from history; findCustomer must still run in this turn.
  if (intent === 'general' && /(?:#[a-z0-9-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:yes|please|that one|go ahead)\b|\$\s*-?\d|\b(?:USD|CAD|EUR|GBP|JPY)\s*\d|\d{4,})/i.test(message)) {
    const users = history.filter((entry) => entry.role === 'user' && entry.content !== message)
    for (const previous of users.slice().reverse()) {
      const prior = classifyIntent(previous.content)
      if (prior !== 'general') { intent = prior; break }
    }
  }
  switch (intent) {
    case 'human_request':
    case 'withdraw_request':
    case 'unsupported_edit':
    case 'action_status':
      return { intent, spokes: [], requiresCustomerIdentification: false, requiresConfirmation: false,
        requiresHumanApproval: intent === 'human_request', summary: intent === 'human_request'
          ? 'Queue the conversation for human support and stop automated changes.'
          : intent === 'withdraw_request' ? 'Withdraw pending proposals without changing Shopify.'
          : intent === 'action_status' ? 'Read the session-bound action status; never repeat the mutation.'
          : 'Explain unsupported item, quantity and discount edits; offer human support.' }
    case 'cancel_refund':
      return { intent, spokes: ['customer', 'order', 'refund'], requiresCustomerIdentification: true,
        requiresConfirmation: true, requiresHumanApproval: true,
        summary: 'Identify the customer, propose cancellation first, then handle the separate refund after cancellation is confirmed.' }
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
      const destructive = DESTRUCTIVE_EDIT.test(scopedOperations(message).text) && scopedOperations(message).cancel !== false
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
  if (plan.intent === 'action_status') return 'Call getActionStatus to read and refresh the recorded action outcome. Do not create another action. Status belongs to this session and needs no new order lookup.'
  if (plan.intent === 'cancel_refund') return 'The customer requested cancellation AND a refund. Identify the customer first. Prepare only the cancellation proposal now. Explain captured payments are not refunded by cancellation; the refund is a separate step after cancellation is confirmed. Do not prepare two conflicting proposals. Never claim either operation is complete from a proposal.'
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
      ? 'Call the write tool to prepare an exact proposal. Execution requires explicit customer confirmation in its UI card; never invent a confirmation token or idempotency key.'
      : '',
    plan.requiresHumanApproval
      ? 'This action needs explicit human approval in its confirmation card before Shopify execution. Preparing a proposal does not execute the write.'
      : '',
    'Do not call a spoke outside this sequence.',
  ].filter((part) => part.length > 0).join(' ')
}
