import type { ShopifyActionStatus, ShopifyActionView, ShippingAddress } from '../../shared/actions.js'
import { getShopifyActionStore, type ActionPayload, type RefundTransaction, type ShopifyActionStore, type StoredShopifyAction } from './actions.js'
import { ShopifyClientError, type ShopifyClient } from './client.js'
import type { ShopifyConfig } from './config.js'
import { moneyString, moneyUnits } from './money.js'

interface Money { amount: string; currencyCode: string }
interface RefundRecord {
  id: string; note: string | null
  totalRefundedSet: { presentmentMoney: Money }
  transactions: { nodes: Array<{ status: string }> }
}
interface WriteState {
  id: string; name: string; updatedAt: string; createdAt: string; cancelledAt: string | null
  customer: { id: string } | null
  displayFinancialStatus: string | null; displayFulfillmentStatus: string
  presentmentCurrencyCode: string
  shippingAddress: (ShippingAddress & { countryCodeV2: string; phone?: string }) | null
  refunds: RefundRecord[]
  suggestedRefund?: {
    maximumRefundableSet: { presentmentMoney: Money }
    suggestedTransactions: Array<{
      kind: string; gateway: string | null; parentTransaction: { id: string } | null
      maximumRefundableSet: { presentmentMoney: Money } | null
      amountSet: { presentmentMoney: Money }
    }>
  } | null
}

export const WRITE_STATE_QUERY = `query WriteState($id: ID!, $refund: Boolean!) {
  order(id: $id) {
    id name updatedAt createdAt cancelledAt customer { id }
    displayFinancialStatus displayFulfillmentStatus presentmentCurrencyCode
    shippingAddress { address1 address2 city provinceCode zip countryCodeV2 firstName lastName phone company }
    refunds { id note totalRefundedSet { presentmentMoney { amount currencyCode } } transactions(first:100) { nodes { status } } }
    suggestedRefund(suggestFullRefund: true) @include(if: $refund) {
      maximumRefundableSet { presentmentMoney { amount currencyCode } }
      suggestedTransactions { kind gateway parentTransaction { id }
        maximumRefundableSet { presentmentMoney { amount currencyCode } }
        amountSet { presentmentMoney { amount currencyCode } }
      }
    }
  }
}`

export const REFUND_MUTATION = `mutation Refund($input: RefundInput!, $key: String!) {
  refundCreate(input: $input) @idempotent(key: $key) {
    refund { id note totalRefundedSet { presentmentMoney { amount currencyCode } } transactions(first:100) { nodes { status } } }
    userErrors { field message }
  }
}`
export const ADDRESS_MUTATION = `mutation ShippingAddress($input: OrderInput!) {
  orderUpdate(input: $input) {
    order { id shippingAddress { address1 address2 city provinceCode zip countryCodeV2 firstName lastName phone company } }
    userErrors { field message }
  }
}`
export const CANCEL_MUTATION = `mutation CancelOrder($id: ID!, $reason: OrderCancelReason!, $note: String!, $notify: Boolean!) {
  orderCancel(orderId: $id, reason: $reason, staffNote: $note, restock: true,
    notifyCustomer: $notify, refundMethod: { originalPaymentMethodsRefund: false }) {
    job { id done }
    orderCancelUserErrors { field message code }
    userErrors { field message }
  }
}`

export interface ActionOutcome { status: ShopifyActionStatus; result?: ShopifyActionView['result'] }
interface WriteOptions {
  query: <T>(document: string, variables: Record<string, unknown>) => Promise<T>
  config: () => ShopifyConfig
  requireOrder: (id: string) => string
  sessionId?: string
  actions?: ShopifyActionStore
}

function invalid(message: string): never { throw new ShopifyClientError('INVALID_INPUT', message) }
function unknown(message: string): never { throw new ShopifyClientError('OUTCOME_UNKNOWN', message) }
function trim(value: string): string { return value?.trim() ?? '' }

export function validateAddress(value: string | ShippingAddress): ShippingAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Provide the shipping address as separate street, city, postal code, country code, and optional province fields.')
  const address: ShippingAddress = { address1: '', city: '', zip: '', countryCode: '' }
  for (const key of ['address1','address2','city','provinceCode','zip','countryCode','firstName','lastName','phone','company'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || value[key]!.length > 200) invalid(`The address field ${key} is invalid.`)
      address[key] = value[key]!.trim()
    }
  }
  for (const key of ['address1','city','zip','countryCode'] as const) if (!address[key]) invalid(`The shipping address needs ${key}.`)
  address.countryCode = address.countryCode.toUpperCase()
  if (!/^[A-Z]{2}$/.test(address.countryCode)) invalid('Use a two-letter country code for the shipping address.')
  if (address.provinceCode) address.provinceCode = address.provinceCode.toUpperCase()
  return address
}

function equalAddress(actual: WriteState['shippingAddress'], desired: ShippingAddress): boolean {
  if (!actual) return false
  return Object.entries(desired).every(([key, value]) => trim(String(key === 'countryCode' ? actual.countryCodeV2 : actual[key as keyof ShippingAddress] ?? '')).toUpperCase() === value.trim().toUpperCase())
}

function refundOutcome(record: RefundRecord): ActionOutcome {
  const statuses = record.transactions.nodes.map((entry) => entry.status)
  const money = record.totalRefundedSet.presentmentMoney
  if (statuses.some((status) => ['FAILURE','ERROR'].includes(status))) return { status: 'failed', result: { shopifyId: record.id, message: 'Shopify created the refund record, but the payment gateway reported a failure. Check the refund in Shopify before retrying.' } }
  const done = statuses.length > 0 && statuses.every((status) => status === 'SUCCESS')
  return { status: done ? 'succeeded' : 'processing', result: { shopifyId: record.id,
    message: done ? `Shopify processed a refund of ${money.amount} ${money.currencyCode}.` : `Shopify accepted the refund of ${money.amount} ${money.currencyCode}. Payment processing is pending.` } }
}

export function createShopifyWrites(options: WriteOptions): Pick<ShopifyClient, 'createRefund' | 'updateShippingAddress' | 'cancelOrder'> & {
  executeAction: (action: StoredShopifyAction) => Promise<ActionOutcome>
  checkAction: (action: StoredShopifyAction) => Promise<ActionOutcome>
} {
  async function state(id: string, refund = false): Promise<WriteState> {
    const result = await options.query<{ order: WriteState | null }>(WRITE_STATE_QUERY, { id, refund })
    if (!result.order) throw new ShopifyClientError('NOT_FOUND', 'Shopify did not find this order.')
    return result.order
  }

  function editable(raw: WriteState): void {
    if (raw.cancelledAt || raw.displayFinancialStatus === 'VOIDED' || raw.displayFinancialStatus === 'REFUNDED') invalid('This order is cancelled, voided, or fully refunded and cannot be edited.')
    if (raw.displayFulfillmentStatus !== 'UNFULFILLED') invalid('Only an unfulfilled order can be changed or cancelled through this chat.')
  }

  function allocate(raw: WriteState, amount: string, currency: string): RefundTransaction[] {
    const suggestion = raw.suggestedRefund
    if (!suggestion) invalid('Shopify could not calculate the refundable amount for this order.')
    if (currency !== raw.presentmentCurrencyCode || suggestion.maximumRefundableSet.presentmentMoney.currencyCode !== currency) invalid('The refund must use the order payment currency.')
    let remaining = moneyUnits(amount, currency)
    if (raw.cancelledAt || raw.displayFinancialStatus === 'VOIDED') invalid('This order is cancelled or voided. Review its payment state in Shopify before refunding.')
    if (remaining <= 0n || remaining > moneyUnits(suggestion.maximumRefundableSet.presentmentMoney.amount, currency)) invalid('The refund amount must be positive and cannot exceed the remaining refundable balance.')
    const days = process.env.REFUND_WINDOW_DAYS
    if (days && (!/^\d+$/.test(days) || Date.now() - Date.parse(raw.createdAt) > Number(days) * 86400000)) invalid('The order is outside the configured refund window.')
    const transactions: RefundTransaction[] = []
    for (const candidate of suggestion.suggestedTransactions) {
      // Shopify's suggestion enum differs from the mutation's transaction kind.
      if (candidate.kind !== 'SUGGESTED_REFUND' || !candidate.parentTransaction || !candidate.gateway) continue
      const available = candidate.maximumRefundableSet?.presentmentMoney ?? candidate.amountSet.presentmentMoney
      if (available.currencyCode !== currency) continue
      const units = moneyUnits(available.amount, currency)
      const part = units < remaining ? units : remaining
      if (part > 0n) transactions.push({ orderId: raw.id, parentId: candidate.parentTransaction.id, gateway: candidate.gateway, kind: 'REFUND', amount: moneyString(part, currency) })
      remaining -= part
      if (remaining === 0n) break
    }
    if (remaining > 0n) invalid('The original payment methods do not have enough refundable funds for this amount.')
    return transactions
  }

  async function prepare(orderId: string, payload: (raw: WriteState) => ActionPayload, withRefund = false): Promise<{ pendingAction: ShopifyActionView }> {
    const owner = options.requireOrder(orderId)
    if (!options.sessionId) throw new ShopifyClientError('CONFIRMATION_REQUIRED', 'Start this action in the chat so its exact details can be confirmed.')
    const raw = await state(orderId, withRefund)
    if (!raw.customer || raw.customer.id !== owner) invalid('The order no longer belongs to the verified customer.')
    const input = payload(raw)
    let title: string, details: string[]
    if (input.kind === 'refund') {
      title = `Refund ${input.amount} ${input.currency}`
      details = [`Order ${raw.name}`, `Return ${input.amount} ${input.currency} to the original payment method(s).`,
        `Reason: ${input.reason}`, `${input.notifyCustomer ? 'Send' : 'Do not send'} a customer refund notification. Inventory quantities will not change.`]
    } else if (input.kind === 'shipping_address') {
      title = 'Update shipping address'
      details = [`Order ${raw.name}`, `Current address: ${raw.shippingAddress ? [raw.shippingAddress.address1, raw.shippingAddress.city, raw.shippingAddress.zip, raw.shippingAddress.countryCodeV2].filter(Boolean).join(', ') : 'None'}`,
        `New address: ${Object.values(input.address).filter(Boolean).join(', ')}`]
    } else {
      title = 'Cancel order'
      details = [`Order ${raw.name}`, `Reason: ${input.reason}`, `Cancel the order permanently and restock its items. ${input.notifyCustomer ? 'Notify' : 'Do not notify'} the customer.`,
        'Captured payments will not be refunded. Any payment authorization hold may be released.']
    }
    const view = (options.actions ?? getShopifyActionStore()).prepare({ sessionId: options.sessionId,
      storeDomain: options.config().storeDomain, orderId: raw.id, orderName: raw.name,
      customerId: raw.customer.id, updatedAt: raw.updatedAt, payload: input, title, details })
    return { pendingAction: view }
  }

  async function recheck(action: StoredShopifyAction): Promise<WriteState> {
    if (action.storeDomain !== options.config().storeDomain || action.sessionId !== options.sessionId) throw new ShopifyClientError('UNAUTHORIZED', 'This action does not belong to this chat or store.')
    const raw = await state(action.orderId, action.payload.kind === 'refund')
    if (raw.customer?.id !== action.customerId) throw new ShopifyClientError('UNAUTHORIZED', 'The order owner changed. Verify the customer again.')
    return raw
  }

  return {
    createRefund: ({ orderId, amount, currency, reason, notifyCustomer = false }) => prepare(orderId, (raw) => {
      if (!trim(reason) || reason.length > 500) invalid('Provide a refund reason of at most 500 characters.')
      const actualCurrency = currency || raw.presentmentCurrencyCode
      const requested = amount ?? raw.suggestedRefund?.maximumRefundableSet.presentmentMoney.amount
      if (!requested) invalid('Shopify could not calculate a refund amount.')
      const units = moneyUnits(requested, actualCurrency)
      const normalized = moneyString(units, actualCurrency)
      return { kind: 'refund', amount: normalized, currency: actualCurrency, reason: trim(reason), notifyCustomer, transactions: allocate(raw, normalized, actualCurrency) }
    }, true),
    updateShippingAddress: ({ orderId, address }) => prepare(orderId, (raw) => {
      editable(raw)
      const desired = validateAddress(address)
      return { kind: 'shipping_address', address: { firstName: raw.shippingAddress?.firstName ?? '', lastName: raw.shippingAddress?.lastName ?? '', address2: '', ...(raw.shippingAddress?.phone ? { phone: raw.shippingAddress.phone } : {}), ...(raw.shippingAddress?.company ? { company: raw.shippingAddress.company } : {}), ...desired } }
    }),
    cancelOrder: ({ orderId, reason, notifyCustomer = false }) => prepare(orderId, (raw) => {
      editable(raw)
      const normalized = reason.toUpperCase()
      if (!['CUSTOMER','DECLINED','FRAUD','INVENTORY','STAFF','OTHER'].includes(normalized)) invalid('Choose a valid cancellation reason.')
      return { kind: 'cancel_order', reason: normalized, notifyCustomer }
    }),
    async executeAction(action) {
      if (action.view.status !== 'executing') throw new ShopifyClientError('CONFIRMATION_REQUIRED', 'Confirm the stored proposal before executing a Shopify change.')
      const raw = await recheck(action)
      if (raw.updatedAt !== action.updatedAt) throw new ShopifyClientError('STALE_ACTION', 'The order changed after this proposal. Request a new proposal before confirming.')
      const payload = action.payload
      if (payload.kind === 'refund') {
        const transactions = allocate(raw, payload.amount, payload.currency)
        const data = await options.query<{ refundCreate: { refund: RefundRecord | null; userErrors: unknown[] } }>(REFUND_MUTATION, {
          key: action.id, input: { orderId: raw.id, currency: payload.currency, note: `${payload.reason}\n[agent-action:${action.id}]`, notify: payload.notifyCustomer,
            allowOverRefunding: false, transactions },
        })
        if (!data.refundCreate?.refund || !Array.isArray(data.refundCreate.userErrors)) unknown('The refund response was incomplete. Check Shopify before retrying.')
        return refundOutcome(data.refundCreate.refund)
      }
      editable(raw)
      if (payload.kind === 'shipping_address') {
        const { countryCode, ...fields } = payload.address
        const data = await options.query<{ orderUpdate: { order: WriteState | null; userErrors: unknown[] } }>(ADDRESS_MUTATION, {
          input: { id: raw.id, shippingAddress: { ...fields, countryCode } },
        })
        if (!data.orderUpdate?.order || !Array.isArray(data.orderUpdate.userErrors) || !equalAddress(data.orderUpdate.order.shippingAddress, payload.address)) unknown('Shopify has not confirmed the exact new address. Check the order before retrying.')
        return { status: 'succeeded', result: { shopifyId: raw.id, message: `Shopify updated the shipping address on order ${raw.name}.` } }
      }
      const data = await options.query<{ orderCancel: { job: { id: string; done: boolean } | null; userErrors: unknown[]; orderCancelUserErrors: unknown[] } }>(CANCEL_MUTATION, {
        id: raw.id, reason: payload.reason, notify: payload.notifyCustomer, note: `Confirmed in the order assistant [agent-action:${action.id}]`,
      })
      if (!data.orderCancel?.job || !Array.isArray(data.orderCancel.userErrors) || !Array.isArray(data.orderCancel.orderCancelUserErrors)) unknown('The cancellation response was incomplete. Check Shopify before retrying.')
      return { status: 'processing', result: { shopifyId: data.orderCancel.job.id, message: `Shopify accepted the cancellation of order ${raw.name}. Check its status to confirm completion.` } }
    },
    async checkAction(action) {
      const raw = await recheck(action)
      const payload = action.payload
      if (payload.kind === 'refund') {
        const record = raw.refunds.find((entry) => entry.note?.includes(`[agent-action:${action.id}]`))
        if (record) return refundOutcome(record)
      } else if (payload.kind === 'shipping_address' && equalAddress(raw.shippingAddress, payload.address)) {
        return { status: 'succeeded', result: { shopifyId: raw.id, message: `Shopify confirms the updated shipping address on order ${raw.name}.` } }
      } else if (payload.kind === 'cancel_order' && raw.cancelledAt) {
        return { status: 'succeeded', result: { shopifyId: raw.id, message: `Shopify confirms order ${raw.name} is cancelled.` } }
      }
      return { status: 'unknown', result: { message: 'Shopify has not confirmed the outcome. Check the order in Shopify before requesting another change.' } }
    },
  }
}
