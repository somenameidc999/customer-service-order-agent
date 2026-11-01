import { HumanSupportStore } from '../agent/handoff.js'
import { ShopifyActionStore } from '../shopify/actions.js'
import { createShopifyLiveClient } from '../shopify/live-client.js'
import type { ShopifyConfig } from '../shopify/config.js'
import type { FetchLike } from '../shopify/token.js'
import { moneyString, moneyUnits } from '../shopify/money.js'

export type EvaluationFault = 'read_throttled' | 'read_denied' | 'read_malformed' | 'accept_then_timeout' | 'payment_pending' | 'payment_failed' | 'mutation_rejected' | null
export interface EvaluationSetup {
  fulfillmentStatus?: string
  financialStatus?: string
  refundableAmount?: string
  currency?: string
  productDescription?: string
  ambiguousOrder?: boolean
  fault?: EvaluationFault
  cancelled?: boolean
  createdAt?: string
  lineItemsTruncated?: boolean
  variantsTruncated?: boolean
}
interface Money { amount: string; currencyCode: string }
interface Customer {
  id: string; firstName: string; lastName: string
  defaultEmailAddress: { emailAddress: string }; defaultPhoneNumber: { phoneNumber: string }
}
export interface EvaluationRefund {
  id: string; note: string; createdAt: string
  totalRefundedSet: { shopMoney: Money; presentmentMoney: Money }
  transactions: { nodes: Array<{ status: string }> }
}
export interface EvaluationOrder {
  id: string; name: string; email: string; phone: string; customer: Customer
  updatedAt: string; createdAt: string; cancelledAt: string | null
  displayFinancialStatus: string; displayFulfillmentStatus: string; presentmentCurrencyCode: string
  totalPriceSet: { shopMoney: Money }
  shippingAddress: { address1: string; address2: string; city: string; provinceCode: string; zip: string; countryCodeV2: string; firstName: string; lastName: string; phone: string; company: string; formatted: string[] }
  lineItems: { nodes: Array<{ id: string; title: string; quantity: number; variant: { id: string } }>; pageInfo: { hasNextPage: boolean } }
  refunds: EvaluationRefund[]
  suggestedRefund: { maximumRefundableSet: { presentmentMoney: Money }; suggestedTransactions: Array<{ kind: string; gateway: string; parentTransaction: { id: string }; maximumRefundableSet: { presentmentMoney: Money }; amountSet: { presentmentMoney: Money } }> }
}
export interface EvaluationProduct {
  id: string; title: string; description: string; status: string
  variants: { nodes: Array<{ id: string; title: string; price: string; availableForSale: boolean }>; pageInfo: { hasNextPage: boolean } }
}
export interface EvaluationCall {
  at: string; query: string; variables: Record<string, any>; mutation: boolean; outcome?: string
}

/** Controlled Shopify HTTP transport. Every agent tool still uses the production live client. */
export function createEvaluationEnvironment(options: { journalPath?: string; now?: () => number } = {}) {
  const now = options.now ?? Date.now
  const config: ShopifyConfig = {
    storeDomain: 'evaluation.myshopify.com', clientId: 'evaluation-client', clientSecret: 'evaluation-secret',
    accessToken: 'evaluation-token', apiVersion: '2026-10', scopes: [],
  }
  let store = new ShopifyActionStore(options.journalPath ?? ':memory:', now)
  let handoffs = new HumanSupportStore(options.journalPath ? `${options.journalPath}.support` : ':memory:')
  const calls: EvaluationCall[] = []
  const state: { orders: EvaluationOrder[]; products: EvaluationProduct[]; jobs: Array<{ id: string; orderId: string; done: boolean }> } = { orders: [], products: [], jobs: [] }
  let sequence = 0
  let setup: EvaluationSetup = {}
  let fault: EvaluationFault = null
  let faultRemaining = 0
  const idempotentRefunds = new Map<string, EvaluationRefund>()
  const timestamp = () => new Date(now() + sequence++).toISOString()
  const clone = <T>(value: T): T => structuredClone(value)
  function setFault(next: EvaluationFault, times = next?.startsWith('read_') ? Number.POSITIVE_INFINITY : 1) {
    fault = next; faultRemaining = times
  }
  function consumeFault(): EvaluationFault {
    const active = faultRemaining > 0 ? fault : null
    if (active) faultRemaining -= 1
    return active
  }
  function reset(next: EvaluationSetup = {}) {
    setup = clone(next)
    calls.length = 0; state.jobs.length = 0; idempotentRefunds.clear(); sequence = 0
    if (!options.journalPath) {
      store.close(); handoffs.close()
      store = new ShopifyActionStore(':memory:', now); handoffs = new HumanSupportStore(':memory:')
    }
    const currency = next.currency ?? 'USD'
    const money = (amount: string): Money => ({ amount, currencyCode: currency })
    state.orders = ['Ada', 'Grace'].map((name, index): EvaluationOrder => {
      const number = 1001 + index
      const customer: Customer = { id: `gid://shopify/Customer/${number}`, firstName: name, lastName: index ? 'Hopper' : 'Lovelace',
        defaultEmailAddress: { emailAddress: `${name.toLowerCase()}@example.com` }, defaultPhoneNumber: { phoneNumber: index ? '+14155550102' : '+14155550101' } }
      const remaining = index ? moneyString(moneyUnits('25', currency), currency) : next.refundableAmount ?? moneyString(moneyUnits('25', currency), currency)
      const units = moneyUnits(remaining, currency)
      const first = units < moneyUnits(currency === 'JPY' ? '10' : '10.00', currency) ? units : moneyUnits(currency === 'JPY' ? '10' : '10.00', currency)
      const balances = [first, units - first]
      return {
        id: `gid://shopify/Order/${number}`, name: `#${number}`, email: customer.defaultEmailAddress.emailAddress,
        phone: customer.defaultPhoneNumber.phoneNumber, customer, updatedAt: timestamp(), createdAt: next.createdAt ?? new Date(now() - 86400000).toISOString(), cancelledAt: index || !next.cancelled ? null : timestamp(),
        displayFinancialStatus: index ? 'PAID' : next.financialStatus ?? 'PAID', displayFulfillmentStatus: index ? 'UNFULFILLED' : next.fulfillmentStatus ?? 'UNFULFILLED', presentmentCurrencyCode: currency,
        totalPriceSet: { shopMoney: money(currency === 'JPY' ? '25' : '25.00') },
        shippingAddress: { address1: index ? '2 Other Street' : '1 Old Street', address2: 'Suite 4', city: 'Seattle', provinceCode: 'WA', zip: '98101', countryCodeV2: 'US', firstName: customer.firstName, lastName: customer.lastName, phone: customer.defaultPhoneNumber.phoneNumber, company: 'Evaluation Co', formatted: ['1 Old Street', 'Seattle WA 98101', 'US'] },
        lineItems: { nodes: [{ id: `gid://shopify/LineItem/${number}`, title: 'Retro Pixel Mug', quantity: 1, variant: { id: 'gid://shopify/ProductVariant/2001' } }], pageInfo: { hasNextPage: next.lineItemsTruncated ?? false } },
        refunds: [], suggestedRefund: { maximumRefundableSet: { presentmentMoney: money(moneyString(units, currency)) }, suggestedTransactions: balances.map((balance, i) => ({ kind: 'SUGGESTED_REFUND', gateway: i ? 'evaluation-card' : 'evaluation-wallet', parentTransaction: { id: `gid://shopify/OrderTransaction/${number}-${i + 1}` }, maximumRefundableSet: { presentmentMoney: money(moneyString(balance, currency)) }, amountSet: { presentmentMoney: money(moneyString(balance, currency)) } })) },
      }
    })
    state.products = [{ id: 'gid://shopify/Product/2001', title: 'Retro Pixel Mug', description: next.productDescription ?? 'A ceramic mug with a pixel design. Holds 350 ml.', status: 'ACTIVE', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/2001', title: 'Blue', price: currency === 'JPY' ? '25' : '25.00', availableForSale: true }], pageInfo: { hasNextPage: next.variantsTruncated ?? false } } }]
    setFault(next.fault ?? null)
  }
  function completePending() {
    for (const order of state.orders) for (const refund of order.refunds) {
      for (const transaction of refund.transactions.nodes) if (transaction.status === 'PENDING') transaction.status = 'SUCCESS'
    }
    for (const job of state.jobs) if (!job.done) {
      job.done = true
      const order = state.orders.find((candidate) => candidate.id === job.orderId)!
      order.cancelledAt = timestamp(); order.updatedAt = timestamp()
    }
  }
  const fetch: FetchLike = async (url, init) => {
    if (String(url) !== `https://${config.storeDomain}/admin/api/${config.apiVersion}/graphql.json`) throw new Error('Evaluation transport rejected an unexpected network destination.')
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> }
    const mutation = body.query.trimStart().startsWith('mutation ')
    const call: EvaluationCall = { at: timestamp(), ...clone(body), mutation }
    calls.push(call)
    const applicableFault = fault && (mutation ? !fault.startsWith('read_') : fault.startsWith('read_')) ? consumeFault() : null
    if (applicableFault === 'read_throttled') { call.outcome = 'HTTP 429'; return Response.json({ errors: ['Throttled'] }, { status: 429 }) }
    if (applicableFault === 'read_denied') { call.outcome = 'ACCESS_DENIED'; return Response.json({ errors: [{ message: 'Access denied for Order.', extensions: { code: 'ACCESS_DENIED' } }] }) }
    if (applicableFault === 'read_malformed') { call.outcome = 'malformed'; return new Response('not-json') }
    const query = body.query, variables = body.variables ?? {}
    const json = (data: unknown) => { call.outcome ??= 'ok'; return Response.json({ data: clone(data) }) }
    const order = state.orders.find((candidate) => candidate.id === (variables.id ?? variables.input?.orderId ?? variables.input?.id))
    if (!mutation) {
      if (query.includes('query OrderByNumber')) {
        const match = String(variables.query).match(/name:\s*"?([^"\s]+)"?/i)?.[1]?.replace(/^#/, '')
        const matches = state.orders.filter((candidate) => candidate.name.replace(/^#/, '').toLowerCase() === match?.toLowerCase())
        return json({ orders: { nodes: setup.ambiguousOrder && matches.length ? [...matches, { ...matches[0], id: 'gid://shopify/Order/ambiguous' }] : matches, pageInfo: { hasNextPage: false } } })
      }
      if (query.includes('query CustomerOrders')) return json({ customer: { orders: { nodes: state.orders.filter((candidate) => candidate.customer.id === variables.id).map(({ id }) => ({ id })), pageInfo: { hasNextPage: false } } } })
      if (query.includes('query Customer(')) return json({ customer: state.orders.find((candidate) => candidate.customer.id === variables.id)?.customer ?? null })
      if (query.includes('query SearchProducts')) {
        const term = String(variables.query ?? '').replace(/status:active\s*(AND)?/gi, '').replace(/\b(?:title|product_type|tag|vendor):/gi, '').replace(/[()"*]/g, '').trim().toLowerCase()
        return json({ shop: { currencyCode: state.orders[0]!.presentmentCurrencyCode }, products: { nodes: state.products.filter((product) => !term || `${product.title} ${product.description}`.toLowerCase().includes(term)).slice(0, variables.first ?? 20), pageInfo: { hasNextPage: false } } })
      }
      if (query.includes('query Product(')) return json({ shop: { currencyCode: state.orders[0]!.presentmentCurrencyCode }, product: state.products.find((product) => product.id === variables.id) ?? null })
      if (query.includes('query Order(') || query.includes('query WriteState(')) return json({ order: order ?? null })
      throw new Error(`Unsupported evaluation query: ${query.slice(0, 80)}`)
    }
    if (!order) throw new Error('Evaluation mutation requested an unknown order.')
    if (applicableFault === 'mutation_rejected') {
      call.outcome = 'userErrors'
      const key = query.includes('refundCreate') ? 'refundCreate' : query.includes('orderUpdate') ? 'orderUpdate' : 'orderCancel'
      return json({ [key]: { userErrors: [{ field: ['input'], message: 'Evaluation policy rejected the change.' }], orderCancelUserErrors: [] } })
    }
    let result: unknown
    if (query.includes('refundCreate')) {
      const previous = idempotentRefunds.get(String(variables.key))
      if (previous) return json({ refundCreate: { refund: previous, userErrors: [] } })
      const currency = variables.input.currency as string
      let total = 0n
      for (const allocation of variables.input.transactions as Array<{ amount: string; parentId: string }>) {
        const units = moneyUnits(allocation.amount, currency)
        const gateway = order.suggestedRefund.suggestedTransactions.find((candidate) => candidate.parentTransaction.id === allocation.parentId)
        if (!gateway || units > moneyUnits(gateway.maximumRefundableSet.presentmentMoney.amount, currency)) throw new Error('Evaluation transport rejected excessive payment allocation.')
        const balance = moneyString(moneyUnits(gateway.maximumRefundableSet.presentmentMoney.amount, currency) - units, currency)
        gateway.maximumRefundableSet.presentmentMoney.amount = balance; gateway.amountSet.presentmentMoney.amount = balance; total += units
      }
      const amount = moneyString(total, currency)
      const record: EvaluationRefund = { id: `gid://shopify/Refund/${10000 + sequence++}`, note: variables.input.note, createdAt: timestamp(), totalRefundedSet: { shopMoney: { amount, currencyCode: currency }, presentmentMoney: { amount, currencyCode: currency } }, transactions: { nodes: [{ status: applicableFault === 'payment_pending' ? 'PENDING' : applicableFault === 'payment_failed' ? 'FAILURE' : 'SUCCESS' }] } }
      order.refunds.push(record); idempotentRefunds.set(String(variables.key), record)
      const remaining = moneyUnits(order.suggestedRefund.maximumRefundableSet.presentmentMoney.amount, currency) - total
      order.suggestedRefund.maximumRefundableSet.presentmentMoney.amount = moneyString(remaining, currency)
      order.displayFinancialStatus = remaining === 0n ? 'REFUNDED' : 'PARTIALLY_REFUNDED'; order.updatedAt = timestamp()
      result = { refundCreate: { refund: record, userErrors: [] } }
    } else if (query.includes('orderUpdate')) {
      const { countryCode, ...fields } = variables.input.shippingAddress
      order.shippingAddress = { ...order.shippingAddress, ...fields, countryCodeV2: countryCode }
      order.shippingAddress.formatted = [order.shippingAddress.address1, `${order.shippingAddress.city} ${order.shippingAddress.zip}`, countryCode]
      order.updatedAt = timestamp(); result = { orderUpdate: { order, userErrors: [] } }
    } else if (query.includes('orderCancel')) {
      const job = { id: `gid://shopify/Job/${sequence++}`, orderId: order.id, done: false }
      state.jobs.push(job); result = { orderCancel: { job: { id: job.id, done: false }, userErrors: [], orderCancelUserErrors: [] } }
    } else throw new Error(`Unsupported evaluation mutation: ${query.slice(0, 80)}`)
    if (applicableFault === 'accept_then_timeout') { call.outcome = 'accepted_then_timeout'; throw new Error('Evaluation connection ended after the mutation was accepted.') }
    return json(result)
  }
  reset()
  return {
    config, state, calls, fetch,
    get store() { return store },
    get handoffs() { return handoffs },
    client: (sessionId: string) => createShopifyLiveClient({ config, fetch, actions: store, sessionId }),
    reset, setFault, completePending,
    reopenJournal: () => {
      if (!options.journalPath) throw new Error('A file journal is required to simulate a process restart.')
      store.close(); store = new ShopifyActionStore(options.journalPath, now)
    },
    inspect: () => ({ state: clone(state), calls: clone(calls), mutationCount: calls.filter((call) => call.mutation).length }),
    close: () => { store.close(); handoffs.close() },
  }
}
export type EvaluationEnvironment = ReturnType<typeof createEvaluationEnvironment>
