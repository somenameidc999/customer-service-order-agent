// Domain types and the client interface the Shopify spokes talk to.
//
// Production tools use the live Shopify client. Tests inject an offline client.

export interface ShopifyCustomer {
  id: string
  email: string | null
  phone: string | null
  firstName: string | null
  lastName: string | null
}

export interface ShopifyLineItem {
  id: string
  title: string
  quantity: number
  variantId: string | null
}

export interface ShopifyRefund {
  id: string
  orderId: string
  amount: string
  currency: string
  reason: string
  createdAt: string
}

export interface ShopifyOrder {
  id: string
  /** Human-facing order reference such as `#1001`. */
  name: string
  customerId: string
  financialStatus: string
  fulfillmentStatus: string
  currency: string
  total: string
  shippingAddress: string
  lineItems: ShopifyLineItem[]
  refunds: ShopifyRefund[]
  lineItemsTruncated?: boolean
}

export interface ShopifyProductVariant {
  id: string
  title: string
  price: string
  availableForSale: boolean
}

export interface ShopifyProduct {
  id: string
  title: string
  description: string
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED'
  variants: ShopifyProductVariant[]
  currency?: string
  variantsTruncated?: boolean
}

export interface FindCustomerInput {
  orderNumber: string
  email?: string
  phone?: string
}

export interface FindCustomerOutput {
  customer: ShopifyCustomer
  order: ShopifyOrder
}

export interface WriteGuards {
  /** Legacy test-client guards. Live approvals are created by the server, never the model. */
  idempotencyKey?: string
  confirmationToken?: string
}

export type ShopifyErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'UNAUTHORIZED'
  | 'CONFIRMATION_REQUIRED'
  | 'IDEMPOTENCY_REQUIRED'
  | 'NOT_SUPPORTED'
  | 'API_ERROR'
  | 'OUTCOME_UNKNOWN'
  | 'STALE_ACTION'

export class ShopifyClientError extends Error {
  readonly code: ShopifyErrorCode
  readonly retryable: boolean

  constructor(code: ShopifyErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(message)
    this.name = 'ShopifyClientError'
    this.code = code
    this.retryable = options.retryable ?? false
  }
}

/**
 * The narrow surface the Shopify spokes depend on. Every method is
 * deterministic for a given store state so spoke behavior is fixture-testable.
 */
export interface ShopifyClient {
  findCustomer(input: FindCustomerInput): Promise<FindCustomerOutput>
  getCustomer(input: { customerId: string }): Promise<ShopifyCustomer>
  getOrder(input: { orderId: string }): Promise<ShopifyOrder>
  getOrderByNumber(input: { orderNumber: string }): Promise<ShopifyOrder>
  listCustomerOrders(input: { customerId: string; limit?: number }): Promise<ShopifyOrder[]>
  getProduct(input: { productId: string }): Promise<ShopifyProduct>
  searchProducts(input: { query: string; limit?: number }): Promise<ShopifyProduct[]>
  listOrderRefunds(input: { orderId: string }): Promise<ShopifyRefund[]>
  createRefund(input: WriteGuards & {
    orderId: string
    amount?: string
    currency: string
    reason: string
    notifyCustomer?: boolean
  }): Promise<ShopifyRefund | import('../../shared/actions.js').PendingShopifyAction>
  updateShippingAddress(input: WriteGuards & {
    orderId: string
    address: string | import('../../shared/actions.js').ShippingAddress
  }): Promise<ShopifyOrder | import('../../shared/actions.js').PendingShopifyAction>
  cancelOrder(input: WriteGuards & { orderId: string; reason: string; notifyCustomer?: boolean }): Promise<ShopifyOrder | import('../../shared/actions.js').PendingShopifyAction>
}
