// Offline test data. Never imported by the application.
import { ShopifyClientError, type ShopifyClient, type ShopifyCustomer, type ShopifyProduct, type ShopifyOrder, type ShopifyRefund, type WriteGuards } from '../shopify/client.js'

function normalizeOrderNumber(raw: string): string {
  return raw.trim().replace(/^#/, '').toLowerCase()
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) throw new ShopifyClientError('INVALID_INPUT', `"${field}" is required.`)
  return trimmed
}

function assertWriteGuards(input: WriteGuards): void {
  if (!input.idempotencyKey?.trim()) {
    throw new ShopifyClientError('IDEMPOTENCY_REQUIRED', 'A deterministic idempotencyKey is required for writes.')
  }
  if (!input.confirmationToken?.trim()) {
    throw new ShopifyClientError('CONFIRMATION_REQUIRED', 'A confirmationToken from the hub is required for writes.')
  }
}

const FIXTURE_CUSTOMERS: ShopifyCustomer[] = [
  { id: 'gid://shopify/Customer/1001', email: 'ada@example.com', phone: '+15550001111', firstName: 'Ada', lastName: 'Lovelace' },
  { id: 'gid://shopify/Customer/1002', email: 'grace@example.com', phone: '+15550002222', firstName: 'Grace', lastName: 'Hopper' },
]

const FIXTURE_PRODUCTS: ShopifyProduct[] = [
  {
    id: 'gid://shopify/Product/9001',
    title: 'Retro Pixel Mug',
    description: 'A stoneware mug with a pixel-art finish.',
    status: 'ACTIVE',
    variants: [{ id: 'gid://shopify/ProductVariant/9101', title: 'Default Title', price: '21.00', availableForSale: true }],
  },
  {
    id: 'gid://shopify/Product/9002',
    title: 'Mechanical Keyboard',
    description: 'A compact mechanical keyboard with tactile switches.',
    status: 'ACTIVE',
    variants: [{ id: 'gid://shopify/ProductVariant/9201', title: 'Default Title', price: '89.00', availableForSale: false }],
  },
]

function fixtureOrders(): ShopifyOrder[] {
  return [
    {
      id: 'gid://shopify/Order/5001',
      name: '#1001',
      customerId: 'gid://shopify/Customer/1001',
      financialStatus: 'PAID',
      fulfillmentStatus: 'FULFILLED',
      currency: 'USD',
      total: '42.00',
      shippingAddress: '1 Analytical Way, London',
      lineItems: [
        { id: 'gid://shopify/LineItem/7001', title: 'Retro Pixel Mug', quantity: 2, variantId: 'gid://shopify/ProductVariant/9101' },
      ],
      refunds: [],
    },
    {
      id: 'gid://shopify/Order/5002',
      name: '#1002',
      customerId: 'gid://shopify/Customer/1002',
      financialStatus: 'PAID',
      fulfillmentStatus: 'UNFULFILLED',
      currency: 'USD',
      total: '89.00',
      shippingAddress: '2 Compiler Lane, Arlington',
      lineItems: [
        { id: 'gid://shopify/LineItem/7002', title: 'Mechanical Keyboard', quantity: 1, variantId: 'gid://shopify/ProductVariant/9201' },
      ],
      refunds: [],
    },
  ]
}

/**
 * In-memory implementation with a small, deterministic store so every spoke can
 * be tested without live credentials. Writes are recorded so refund/edit flows
 * can be asserted; there is no network access anywhere in this class.
 */
export function createShopifyFixtureClient(): ShopifyClient {
  const customers = FIXTURE_CUSTOMERS.map((customer) => ({ ...customer }))
  const products = FIXTURE_PRODUCTS.map((product) => ({ ...product, variants: product.variants.map((variant) => ({ ...variant })) }))
  const orders = fixtureOrders()
  const refunds: ShopifyRefund[] = []
  let nextRefundId = 1

  function findOrderByNumber(orderNumber: string): ShopifyOrder | undefined {
    const target = normalizeOrderNumber(orderNumber)
    return orders.find((order) => normalizeOrderNumber(order.name) === target)
  }

  return {
    async findCustomer(input) {
      const orderNumber = requireNonEmpty(input.orderNumber, 'orderNumber')
      const email = input.email?.trim().toLowerCase() ?? ''
      const phone = input.phone?.trim() ?? ''
      if (!email && !phone) {
        throw new ShopifyClientError('INVALID_INPUT', 'Provide an email or a phone number to verify the customer.')
      }
      const order = findOrderByNumber(orderNumber)
      if (!order) throw new ShopifyClientError('NOT_FOUND', `No order matches ${input.orderNumber.trim()}.`)
      const customer = customers.find((candidate) => candidate.id === order.customerId)
      if (!customer) throw new ShopifyClientError('NOT_FOUND', 'The order has no matching customer.')
      const emailMatches = email.length > 0 && customer.email?.toLowerCase() === email
      const phoneMatches = phone.length > 0 && customer.phone === phone
      if (!emailMatches && !phoneMatches) {
        throw new ShopifyClientError('UNAUTHORIZED', 'The supplied email/phone does not match the order owner.')
      }
      return { customer: { ...customer }, order: { ...order, lineItems: order.lineItems.map((item) => ({ ...item })) } }
    },

    async getCustomer({ customerId }) {
      const id = requireNonEmpty(customerId, 'customerId')
      const customer = customers.find((candidate) => candidate.id === id)
      if (!customer) throw new ShopifyClientError('NOT_FOUND', `No customer matches ${id}.`)
      return { ...customer }
    },

    async getOrder({ orderId }) {
      const id = requireNonEmpty(orderId, 'orderId')
      const order = orders.find((candidate) => candidate.id === id)
      if (!order) throw new ShopifyClientError('NOT_FOUND', `No order matches ${id}.`)
      return { ...order, lineItems: order.lineItems.map((item) => ({ ...item })), refunds: order.refunds.map((refund) => ({ ...refund })) }
    },

    async getOrderByNumber({ orderNumber }) {
      const order = findOrderByNumber(requireNonEmpty(orderNumber, 'orderNumber'))
      if (!order) throw new ShopifyClientError('NOT_FOUND', `No order matches ${orderNumber.trim()}.`)
      return { ...order, lineItems: order.lineItems.map((item) => ({ ...item })), refunds: order.refunds.map((refund) => ({ ...refund })) }
    },

    async listCustomerOrders({ customerId, limit }) {
      const id = requireNonEmpty(customerId, 'customerId')
      const count = Number.isFinite(limit) && (limit ?? 0) > 0 ? Math.floor(limit as number) : 10
      return orders.filter((order) => order.customerId === id).slice(0, count).map((order) => ({ ...order }))
    },

    async getProduct({ productId }) {
      const id = requireNonEmpty(productId, 'productId')
      const product = products.find((candidate) => candidate.id === id)
      if (!product) throw new ShopifyClientError('NOT_FOUND', `No product matches ${id}.`)
      return { ...product, variants: product.variants.map((variant) => ({ ...variant })) }
    },

    async searchProducts({ query, limit }) {
      const term = requireNonEmpty(query, 'query').toLowerCase()
      const count = Number.isFinite(limit) && (limit ?? 0) > 0 ? Math.floor(limit as number) : 10
      return products
        .filter((product) => product.status === 'ACTIVE')
        .filter((product) => `${product.title} ${product.description}`.toLowerCase().includes(term))
        .slice(0, count)
        .map((product) => ({ ...product, variants: product.variants.map((variant) => ({ ...variant })) }))
    },

    async listOrderRefunds({ orderId }) {
      const id = requireNonEmpty(orderId, 'orderId')
      const order = orders.find((candidate) => candidate.id === id)
      if (!order) throw new ShopifyClientError('NOT_FOUND', `No order matches ${id}.`)
      return order.refunds.map((refund) => ({ ...refund }))
    },

    async createRefund(input) {
      assertWriteGuards(input)
      const order = orders.find((candidate) => candidate.id === requireNonEmpty(input.orderId, 'orderId'))
      if (!order) throw new ShopifyClientError('NOT_FOUND', `No order matches ${input.orderId}.`)
      const amount = requireNonEmpty(input.amount, 'amount')
      const total = Number(order.total)
      if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        throw new ShopifyClientError('INVALID_INPUT', '"amount" must be a positive number.')
      }
      if (Number(amount) > total) {
        throw new ShopifyClientError('INVALID_INPUT', `Refund amount ${amount} exceeds the refundable ${order.total}.`)
      }
      const refund: ShopifyRefund = {
        id: `gid://shopify/Refund/${nextRefundId++}`,
        orderId: order.id,
        amount,
        currency: input.currency || order.currency,
        reason: input.reason,
        createdAt: new Date().toISOString(),
      }
      refunds.push(refund)
      order.refunds = [...order.refunds, refund]
      order.financialStatus = Number(amount) >= total ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
      return { ...refund }
    },

    async updateShippingAddress(input) {
      assertWriteGuards(input)
      const order = orders.find((candidate) => candidate.id === requireNonEmpty(input.orderId, 'orderId'))
      if (!order) throw new ShopifyClientError('NOT_FOUND', `No order matches ${input.orderId}.`)
      if (order.fulfillmentStatus === 'FULFILLED') {
        throw new ShopifyClientError('INVALID_INPUT', 'A fulfilled order cannot have its shipping address changed.')
      }
      order.shippingAddress = typeof input.address === 'string' ? requireNonEmpty(input.address, 'address') : Object.values(input.address).join(', ')
      return { ...order, lineItems: order.lineItems.map((item) => ({ ...item })) }
    },

    async cancelOrder(input) {
      assertWriteGuards(input)
      const order = orders.find((candidate) => candidate.id === requireNonEmpty(input.orderId, 'orderId'))
      if (!order) throw new ShopifyClientError('NOT_FOUND', `No order matches ${input.orderId}.`)
      if (order.financialStatus === 'REFUNDED') {
        throw new ShopifyClientError('INVALID_INPUT', 'A fully refunded order cannot be cancelled.')
      }
      order.financialStatus = 'VOIDED'
      order.fulfillmentStatus = 'CANCELLED'
      return { ...order, lineItems: order.lineItems.map((item) => ({ ...item })) }
    },
  }
}
