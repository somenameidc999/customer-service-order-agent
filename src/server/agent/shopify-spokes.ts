import type { ToolDefinition } from './tools.js'
import {
  createShopifyFixtureClient,
  type ShopifyClient,
  type ShopifyErrorCode,
} from '../shopify/client.js'

/**
 * The Shopify subagents ("spokes") the coordinator can spawn. Each owns one
 * domain and a narrow tool set so least privilege is visible in code
 * (docs/agents.md, docs/security.md §8).
 */
export type ShopifySpokeName = 'customer' | 'product' | 'order' | 'refund'

export interface ShopifySpoke {
  name: ShopifySpokeName
  title: string
  description: string
  /** Shopify Admin API scopes used by this spoke (least privilege). */
  scopes: string[]
  /** Tool names this spoke owns, in the order they appear to the model. */
  tools: string[]
}

export const shopifySpokes: ShopifySpoke[] = [
  {
    name: 'customer',
    title: 'Shopify Customer Agent',
    description: 'Resolves who the customer is using an order number plus a matching email or phone.',
    scopes: ['read_customers'],
    tools: ['findCustomer', 'getCustomer'],
  },
  {
    name: 'product',
    title: 'Shopify Product Agent',
    description: 'Relays published product information without inventing stock levels.',
    scopes: ['read_products'],
    tools: ['getProduct', 'searchProducts'],
  },
  {
    name: 'order',
    title: 'Shopify Order Agent',
    description: 'Reads order status and performs confirmed, idempotent order edits.',
    scopes: ['read_orders', 'write_orders'],
    tools: ['getOrder', 'getOrderByNumber', 'listCustomerOrders', 'updateShippingAddress', 'cancelOrder'],
  },
  {
    name: 'refund',
    title: 'Shopify Refund Agent',
    description: 'Reads refund history and creates confirmed, idempotent refunds.',
    scopes: ['read_orders', 'write_orders'],
    tools: ['listOrderRefunds', 'createRefund'],
  },
]

function codeOf(error: unknown): ShopifyErrorCode | 'TOOL_ERROR' {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: ShopifyErrorCode }).code
    : 'TOOL_ERROR'
}

/** Format a tool outcome as evidence the coordinator can cite. */
function evidence(value: unknown): string {
  return JSON.stringify(value)
}

async function runWithEvidence<T>(operation: () => Promise<T>): Promise<string> {
  try {
    return evidence(await operation())
  } catch (error) {
    const code = codeOf(error)
    const message = error instanceof Error ? error.message : 'Tool failed.'
    throw new Error(`${code}: ${message}`)
  }
}

function asString(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`"${field}" is required.`)
  return text
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asCount(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

/**
 * Build the tool definitions for every Shopify spoke. The coordinator sees
 * these alongside the built-in tools, and each definition records its owning
 * spoke so the agent can emit `subagent` events.
 */
export function createShopifySpokeTools(client: ShopifyClient = createShopifyFixtureClient()): ToolDefinition[] {
  return [
    {
      spoke: 'customer',
      spec: {
        name: 'findCustomer',
        description: 'Resolve the customer behind an order. Requires the order number plus a matching email or phone. Always run this before reading order details.',
        parameters: {
          type: 'object',
          properties: {
            orderNumber: { type: 'string', description: 'Order reference such as "#1001".' },
            email: { type: 'string', description: 'Email on the order (one of email/phone required).' },
            phone: { type: 'string', description: 'Phone on the order (one of email/phone required).' },
          },
          required: ['orderNumber'],
          additionalProperties: false,
        },
      },
      run: (args) => runWithEvidence(() => client.findCustomer({
        orderNumber: asString(args.orderNumber, 'orderNumber'),
        email: optionalString(args.email),
        phone: optionalString(args.phone),
      })),
    },
    {
      spoke: 'customer',
      spec: {
        name: 'getCustomer',
        description: 'Load a customer profile by customer ID once the customer has been resolved.',
        parameters: {
          type: 'object',
          properties: { customerId: { type: 'string', description: 'Shopify customer GID.' } },
          required: ['customerId'],
          additionalProperties: false,
        },
      },
      run: (args) => runWithEvidence(() => client.getCustomer({ customerId: asString(args.customerId, 'customerId') })),
    },
    {
      spoke: 'product',
      spec: {
        name: 'getProduct',
        description: 'Read a product by ID: title, description, variants and prices.',
        parameters: {
          type: 'object',
          properties: { productId: { type: 'string', description: 'Shopify product GID.' } },
          required: ['productId'],
          additionalProperties: false,
        },
      },
      run: (args) => runWithEvidence(() => client.getProduct({ productId: asString(args.productId, 'productId') })),
    },
    {
      spoke: 'product',
      spec: {
        name: 'searchProducts',
        description: 'Search published products by title or description.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term.' },
            limit: { type: 'number', description: 'Maximum results.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      run: (args) => runWithEvidence(() => client.searchProducts({
        query: asString(args.query, 'query'),
        limit: asCount(args.limit),
      })),
    },
    {
      spoke: 'order',
      spec: {
        name: 'getOrder',
        description: 'Read an order by ID: status, totals, line items and refund history.',
        parameters: {
          type: 'object',
          properties: { orderId: { type: 'string', description: 'Shopify order GID.' } },
          required: ['orderId'],
          additionalProperties: false,
        },
      },
      run: (args) => runWithEvidence(() => client.getOrder({ orderId: asString(args.orderId, 'orderId') })),
    },
    {
      spoke: 'order',
      spec: {
        name: 'getOrderByNumber',
        description: 'Read an order by its human-facing number such as "#1001".',
        parameters: {
          type: 'object',
          properties: { orderNumber: { type: 'string', description: 'Order reference such as "#1001".' } },
          required: ['orderNumber'],
          additionalProperties: false,
        },
      },
      run: (args) => runWithEvidence(() => client.getOrderByNumber({ orderNumber: asString(args.orderNumber, 'orderNumber') })),
    },
    {
      spoke: 'order',
      spec: {
        name: 'listCustomerOrders',
        description: 'List recent orders for a resolved customer.',
        parameters: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: 'Shopify customer GID.' },
            limit: { type: 'number', description: 'Maximum results.' },
          },
          required: ['customerId'],
          additionalProperties: false,
        },
      },
      run: (args) => runWithEvidence(() => client.listCustomerOrders({
        customerId: asString(args.customerId, 'customerId'),
        limit: asCount(args.limit),
      })),
    },
    {
      spoke: 'order',
      spec: {
        name: 'updateShippingAddress',
        description: 'Edit an order\'s shipping address. Requires customer confirmation: pass the confirmationToken and a deterministic idempotencyKey.',
        parameters: {
          type: 'object',
          properties: {
            orderId: { type: 'string', description: 'Shopify order GID.' },
            address: { type: 'string', description: 'New shipping address.' },
            confirmationToken: { type: 'string', description: 'Token recorded by the hub after customer confirmation.' },
            idempotencyKey: { type: 'string', description: 'Deterministic key so retries do not double-apply.' },
          },
          required: ['orderId', 'address', 'confirmationToken', 'idempotencyKey'],
          additionalProperties: false,
        },
      },
      run: (args) => runWithEvidence(() => client.updateShippingAddress({
        orderId: asString(args.orderId, 'orderId'),
        address: asString(args.address, 'address'),
        confirmationToken: String(args.confirmationToken ?? ''),
        idempotencyKey: String(args.idempotencyKey ?? ''),
      })),
    },
    {
      spoke: 'order',
      spec: {
        name: 'cancelOrder',
        description: 'Cancel an order (destructive). Requires human approval plus a confirmationToken and a deterministic idempotencyKey.',
        parameters: {
          type: 'object',
          properties: {
            orderId: { type: 'string', description: 'Shopify order GID.' },
            reason: { type: 'string', description: 'Cancellation reason.' },
            confirmationToken: { type: 'string', description: 'Token recorded by the hub after customer confirmation.' },
            idempotencyKey: { type: 'string', description: 'Deterministic key so retries do not double-apply.' },
          },
          required: ['orderId', 'reason', 'confirmationToken', 'idempotencyKey'],
          additionalProperties: false,
        },
      },
      run: (args) => runWithEvidence(() => client.cancelOrder({
        orderId: asString(args.orderId, 'orderId'),
        reason: asString(args.reason, 'reason'),
        confirmationToken: String(args.confirmationToken ?? ''),
        idempotencyKey: String(args.idempotencyKey ?? ''),
      })),
    },
    {
      spoke: 'refund',
      spec: {
        name: 'listOrderRefunds',
        description: 'Read the refund history for an order.',
        parameters: {
          type: 'object',
          properties: { orderId: { type: 'string', description: 'Shopify order GID.' } },
          required: ['orderId'],
          additionalProperties: false,
        },
      },
      run: (args) => runWithEvidence(() => client.listOrderRefunds({ orderId: asString(args.orderId, 'orderId') })),
    },
    {
      spoke: 'refund',
      spec: {
        name: 'createRefund',
        description: 'Create a refund (write). Requires customer confirmation: pass the confirmationToken and a deterministic idempotencyKey. Amount is bounded by the order total.',
        parameters: {
          type: 'object',
          properties: {
            orderId: { type: 'string', description: 'Shopify order GID.' },
            amount: { type: 'string', description: 'Refund amount, as a decimal string.' },
            currency: { type: 'string', description: 'ISO currency code.' },
            reason: { type: 'string', description: 'Refund reason.' },
            confirmationToken: { type: 'string', description: 'Token recorded by the hub after customer confirmation.' },
            idempotencyKey: { type: 'string', description: 'Deterministic key so retries do not double-refund.' },
          },
          required: ['orderId', 'amount', 'reason', 'confirmationToken', 'idempotencyKey'],
          additionalProperties: false,
        },
      },
      run: (args) => runWithEvidence(() => client.createRefund({
        orderId: asString(args.orderId, 'orderId'),
        amount: asString(args.amount, 'amount'),
        currency: optionalString(args.currency) ?? 'USD',
        reason: asString(args.reason, 'reason'),
        confirmationToken: String(args.confirmationToken ?? ''),
        idempotencyKey: String(args.idempotencyKey ?? ''),
      })),
    },
  ]
}
