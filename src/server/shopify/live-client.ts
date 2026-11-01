import { createShopifyWrites } from './write-client.js'
import type { ShopifyActionStore } from './actions.js'
import { loadShopifyConfig, type ShopifyConfig } from './config.js'
import { createShopifyTokenProvider, type FetchLike, type ShopifyTokenProvider } from './token.js'
import {
  ShopifyClientError, type ShopifyClient, type ShopifyCustomer, type ShopifyOrder,
  type ShopifyProduct, type ShopifyRefund,
} from './client.js'

interface Connection<T> { nodes: T[]; pageInfo: { hasNextPage: boolean } }
interface RawCustomer {
  id: string
  firstName: string | null
  lastName: string | null
  defaultEmailAddress: { emailAddress: string } | null
  defaultPhoneNumber: { phoneNumber: string } | null
}
interface Money { amount: string; currencyCode: string }
interface RawRefund {
  id: string; createdAt: string; note: string | null
  totalRefundedSet: { shopMoney: Money }
}
interface RawOrder {
  id: string; name: string; email: string | null; phone: string | null
  customer: RawCustomer | null
  displayFinancialStatus: string | null; displayFulfillmentStatus: string
  totalPriceSet: { shopMoney: Money }
  shippingAddress: { formatted: string[] } | null
  lineItems: Connection<{ id: string; title: string; quantity: number; variant: { id: string } | null }>
  refunds: RawRefund[]
}
type OrderIdentity = Pick<RawOrder, 'id' | 'name' | 'email' | 'phone' | 'customer'>
interface RawProduct extends Omit<ShopifyProduct, 'variants'> {
  variants: Connection<ShopifyProduct['variants'][number]>
}

const CUSTOMER_FIELDS = `id firstName lastName
  defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }`
const PRODUCT_FIELDS = `id title description status
  variants(first: 25) { nodes { id title price availableForSale } pageInfo { hasNextPage } }`
const ORDER_FIELDS = `id name email phone customer { ${CUSTOMER_FIELDS} }
  displayFinancialStatus displayFulfillmentStatus totalPriceSet { shopMoney { amount currencyCode } }
  shippingAddress { formatted }
  lineItems(first: 100) { nodes { id title quantity variant { id } } pageInfo { hasNextPage } }
  refunds { id createdAt note totalRefundedSet { shopMoney { amount currencyCode } } }`

export interface ShopifyLiveClientOptions {
  config?: ShopifyConfig
  tokenProvider?: ShopifyTokenProvider
  fetch?: FetchLike
  requestTimeoutMs?: number
  sessionId?: string
  actions?: ShopifyActionStore
}

function required(value: string, field: string): string {
  if (!value?.trim()) throw new ShopifyClientError('INVALID_INPUT', `"${field}" is required.`)
  return value.trim()
}

function count(limit?: number): number {
  return Number.isFinite(limit) && (limit ?? 0) > 0 ? Math.min(Math.floor(limit!), 20) : 10
}

function orderNumber(value: string): string { return value.replace(/^#/, '').toLowerCase() }
function quoted(value: string): string { return `"${value.replace(/[\\"]/g, '\\$&')}"` }

function customer(raw: RawCustomer): ShopifyCustomer {
  return { id: raw.id, firstName: raw.firstName, lastName: raw.lastName,
    email: raw.defaultEmailAddress?.emailAddress ?? null,
    phone: raw.defaultPhoneNumber?.phoneNumber ?? null }
}

function refund(raw: RawRefund, orderId: string): ShopifyRefund {
  return { id: raw.id, orderId, amount: raw.totalRefundedSet.shopMoney.amount,
    currency: raw.totalRefundedSet.shopMoney.currencyCode, reason: raw.note ?? '', createdAt: raw.createdAt }
}

function order(raw: RawOrder): ShopifyOrder {
  return { id: raw.id, name: raw.name, customerId: raw.customer?.id ?? '',
    financialStatus: raw.displayFinancialStatus ?? 'UNKNOWN', fulfillmentStatus: raw.displayFulfillmentStatus,
    currency: raw.totalPriceSet.shopMoney.currencyCode, total: raw.totalPriceSet.shopMoney.amount,
    shippingAddress: raw.shippingAddress?.formatted.join(', ') ?? '',
    lineItems: raw.lineItems.nodes.map(({ variant, ...item }) => ({ ...item, variantId: variant?.id ?? null })),
    lineItemsTruncated: raw.lineItems.pageInfo.hasNextPage,
    refunds: raw.refunds.map((entry) => refund(entry, raw.id)) }
}

function product(raw: RawProduct, currency: string): ShopifyProduct {
  return { id: raw.id, title: raw.title, description: raw.description, status: raw.status,
    variants: raw.variants.nodes, variantsTruncated: raw.variants.pageInfo.hasNextPage, currency }
}

/** Live Shopify data. Writes create proposals and execute only through confirmed actions. */
export function createShopifyLiveClient(options: ShopifyLiveClientOptions = {}) {
  // Load credentials on first use so a missing configuration appears as a tool error.
  let config = options.config
  let provider = options.tokenProvider
  const request = options.fetch ?? globalThis.fetch
  const verifiedCustomers = new Set<string>()
  const verifiedOrders = new Map<string, string>()
  const verifiedOrderNames = new Map<string, string>()

  async function query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    const mutation = document.trimStart().startsWith('mutation ')
    config ??= loadShopifyConfig()
    provider ??= createShopifyTokenProvider({ config, fetch: request })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await provider.getAccessToken()
      const redact = (message: string) => [token, config!.clientSecret, config!.accessToken ?? '']
        .reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, message).slice(0, 500)
      let response: Response
      try {
        response = await request(`https://${config.storeDomain}/admin/api/${config.apiVersion}/graphql.json`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ query: document, variables }),
          signal: AbortSignal.timeout(options.requestTimeoutMs ?? 15000),
        })
      } catch {
        throw new ShopifyClientError(mutation ? 'OUTCOME_UNKNOWN' : 'API_ERROR', mutation ? 'The connection ended before Shopify confirmed the change. Check the action status before retrying.' : 'Could not reach Shopify. Please try again.', { retryable: !mutation })
      }
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel()
        provider.invalidate()
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new ShopifyClientError(mutation && response.status >= 500 ? 'OUTCOME_UNKNOWN' : 'API_ERROR', `Shopify request failed (HTTP ${response.status}).`, {
          retryable: response.status === 429 || response.status >= 500,
        })
      }
      let payload: { data?: T | null; errors?: Array<{ message?: string; extensions?: { code?: string } }> }
      try { payload = await response.json() as typeof payload } catch {
        throw new ShopifyClientError(mutation ? 'OUTCOME_UNKNOWN' : 'API_ERROR', 'Shopify returned an invalid response.')
      }
      if (payload.errors?.length) {
        throw new ShopifyClientError(mutation ? 'OUTCOME_UNKNOWN' : 'API_ERROR', `Shopify could not complete the request: ${redact(payload.errors.map((error) => error.message ?? 'API error').join('; '))}`, {
          retryable: payload.errors.some((error) => error.extensions?.code === 'THROTTLED'),
        })
      }
      if (!payload.data || typeof payload.data !== 'object') {
        throw new ShopifyClientError(mutation ? 'OUTCOME_UNKNOWN' : 'API_ERROR', 'Shopify returned no request data.')
      }
      if (mutation) {
        for (const result of Object.values(payload.data)) {
          if (!result || typeof result !== 'object') continue
          const body = result as { userErrors?: Array<{ message: string }>; orderCancelUserErrors?: Array<{ message: string }> }
          const errors = [...(body.userErrors ?? []), ...(body.orderCancelUserErrors ?? [])]
          if (errors.length) throw new ShopifyClientError('INVALID_INPUT', `Shopify rejected the change: ${redact(errors.map((error) => error.message).join('; '))}`)
        }
      }
      return payload.data
    }
    throw new ShopifyClientError('API_ERROR', 'Shopify authentication failed.')
  }

  function requireCustomer(id: string): void {
    if (!verifiedCustomers.has(id)) throw new ShopifyClientError('UNAUTHORIZED', 'Verify the customer with an order number and matching email or phone first.')
  }

  function requireOrder(id: string): string {
    const owner = verifiedOrders.get(id)
    if (!owner) throw new ShopifyClientError('UNAUTHORIZED', 'Verify this order with its order number and matching email or phone first.')
    return owner
  }

  async function readOrder(id: string): Promise<RawOrder> {
    const data = await query<{ order: RawOrder | null }>(`query Order($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id })
    if (!data.order) throw new ShopifyClientError('NOT_FOUND', 'Shopify did not find this order.')
    return data.order
  }

  async function lookupOrder(number: string): Promise<OrderIdentity> {
    const data = await query<{ orders: Connection<OrderIdentity> }>(
      `query OrderByNumber($query: String!) { orders(first: 20, query: $query) { nodes { id name email phone customer { ${CUSTOMER_FIELDS} } } pageInfo { hasNextPage } } }`,
      { query: `name:${quoted(number.replace(/^#/, ''))}` },
    )
    const matches = data.orders.nodes.filter((entry) => orderNumber(entry.name) === orderNumber(number))
    if (matches.length > 1 || data.orders.pageInfo.hasNextPage) {
      throw new ShopifyClientError('AMBIGUOUS', 'Shopify returned multiple possible orders. Please confirm the full order number.')
    }
    if (!matches[0]) throw new ShopifyClientError('NOT_FOUND', 'The order and contact details could not be verified.')
    return matches[0]
  }

  const writes = createShopifyWrites({ query, requireOrder, config: () => config ??= loadShopifyConfig(),
    sessionId: options.sessionId, actions: options.actions })
  const client: ShopifyClient & Pick<typeof writes, 'executeAction' | 'checkAction'> = {
    async searchProducts({ query: term, limit }) {
      const search = required(term, 'query')
      const data = await query<{ shop: { currencyCode: string }; products: Connection<RawProduct> }>(
        `query SearchProducts($query: String!, $first: Int!) { shop { currencyCode } products(first: $first, query: $query) { nodes { ${PRODUCT_FIELDS} } pageInfo { hasNextPage } } }`,
        { query: search === '*' ? 'status:active' : `status:active AND (${search})`, first: count(limit) },
      )
      return data.products.nodes.filter((entry) => entry.status === 'ACTIVE').map((entry) => product(entry, data.shop.currencyCode))
    },
    async getProduct({ productId }) {
      const data = await query<{ shop: { currencyCode: string }; product: RawProduct | null }>(
        `query Product($id: ID!) { shop { currencyCode } product(id: $id) { ${PRODUCT_FIELDS} } }`, { id: required(productId, 'productId') },
      )
      if (!data.product || data.product.status !== 'ACTIVE') throw new ShopifyClientError('NOT_FOUND', 'Shopify did not find an active product with this ID.')
      return product(data.product, data.shop.currencyCode)
    },
    async findCustomer({ orderNumber: number, email, phone }) {
      const normalizedEmail = email?.trim().toLowerCase()
      const normalizedPhone = phone?.replace(/\D/g, '')
      if (!normalizedEmail && !normalizedPhone) throw new ShopifyClientError('INVALID_INPUT', 'Provide the order number and matching email or phone to verify the customer.')
      const raw = await lookupOrder(required(number, 'orderNumber'))
      if (!raw.customer || !((normalizedEmail && raw.email?.toLowerCase() === normalizedEmail) ||
        (normalizedPhone && raw.phone?.replace(/\D/g, '') === normalizedPhone))) {
        throw new ShopifyClientError('UNAUTHORIZED', 'The order and contact details could not be verified.')
      }
      verifiedCustomers.add(raw.customer.id)
      verifiedOrders.set(raw.id, raw.customer.id)
      verifiedOrderNames.set(orderNumber(raw.name), raw.id)
      return { customer: customer(raw.customer), order: order(await readOrder(raw.id)) }
    },
    async getCustomer({ customerId }) {
      requireCustomer(required(customerId, 'customerId'))
      const data = await query<{ customer: RawCustomer | null }>(`query Customer($id: ID!) { customer(id: $id) { ${CUSTOMER_FIELDS} } }`, { id: customerId })
      if (!data.customer) throw new ShopifyClientError('NOT_FOUND', 'Shopify did not find this customer.')
      return customer(data.customer)
    },
    async getOrder({ orderId }) {
      requireOrder(required(orderId, 'orderId'))
      return order(await readOrder(orderId))
    },
    async getOrderByNumber({ orderNumber: number }) {
      const id = verifiedOrderNames.get(orderNumber(required(number, 'orderNumber')))
      if (!id) throw new ShopifyClientError('UNAUTHORIZED', 'Verify this order with its order number and matching email or phone first.')
      return order(await readOrder(id))
    },
    async listCustomerOrders({ customerId, limit }) {
      requireCustomer(required(customerId, 'customerId'))
      const data = await query<{ customer: { orders: Connection<{ id: string }> } | null }>(
        `query CustomerOrders($id: ID!, $first: Int!) { customer(id: $id) { orders(first: $first, reverse: true) { nodes { id } pageInfo { hasNextPage } } } }`,
        { id: customerId, first: count(limit) },
      )
      if (!data.customer) throw new ShopifyClientError('NOT_FOUND', 'Shopify did not find this customer.')
      const orders: ShopifyOrder[] = []
      for (const { id } of data.customer.orders.nodes) {
        const entry = await readOrder(id)
        if (entry.customer?.id !== customerId) continue
        verifiedOrders.set(entry.id, customerId)
        verifiedOrderNames.set(orderNumber(entry.name), entry.id)
        orders.push(order(entry))
      }
      return orders
    },
    async listOrderRefunds({ orderId }) {
      requireOrder(required(orderId, 'orderId'))
      return (await readOrder(orderId)).refunds.map((entry) => refund(entry, orderId))
    },
    ...writes,
  }
  return client
}
