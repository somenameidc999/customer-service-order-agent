import { classifyIntent } from './planner.js'

const FULL_REFUND = /\b(?:full|entire|all|remaining)\b.{0,30}\b(?:refund|balance|payment|amount)|\brefund\b.{0,30}\b(?:full|entire|all|remaining)\b/i

/** Explicit customer money requests constrain model-created refund proposals. */
export interface CustomerRefundAmount { amount: string; currency?: string }

function currentTaskMessages(messages: readonly { role: string; content: string }[]): readonly { role: string; content: string }[] {
  const users = messages.filter((entry) => entry.role === 'user')
  // A fresh action request starts fresh monetary/notification consent. Identifier
  // replies and bare amount corrections remain inside the current task.
  for (let index = users.length - 1; index >= 0; index--) {
    const intent = classifyIntent(users[index]!.content)
    if (['refund_request', 'order_edit', 'cancel_refund', 'withdraw_request', 'human_request', 'unsupported_edit'].includes(intent)) return users.slice(index)
  }
  return users
}

export function requestedRefundAmount(messages: readonly { role: string; content: string }[]): CustomerRefundAmount | undefined {
  for (const entry of currentTaskMessages(messages).slice().reverse()) {
    if (entry.role !== 'user') continue
    const text = entry.content.replace(/-\s*\$/g, '$-')
    // A new request for all remaining funds supersedes an earlier partial amount.
    if (FULL_REFUND.test(text)) return undefined
    const number = '(-?\\d[\\d,]*(?:\\.\\d+)?)'
    const code = '(USD|CAD|AUD|NZD|EUR|GBP|JPY|KWD|BHD|CHF|SEK|NOK|DKK|INR)'
    // Prefer an amount attached to a refund instruction over other quoted prices.
    const directed = new RegExp(`\\b(?:refund|reimburse)(?: me)?\\s+(?:of\\s+)?(?:\\$\\s*)?${number}(?:\\s*${code})?`, 'i').exec(text)
    const symbol = new RegExp(`\\$\\s*${number}(?:\\s*${code})?`, 'i').exec(text)
    const afterCode = new RegExp(`\\b${code}\\s*${number}\\b`, 'i').exec(text)
    const beforeCode = new RegExp(`\\b${number}\\s*${code}\\b`, 'i').exec(text)
    const dollars = new RegExp(`\\b${number}\\s+dollars\\b`, 'i').exec(text)
    const match = directed ?? symbol ?? beforeCode ?? dollars
    if (match) return { amount: match[1]!.replaceAll(',', ''), ...(match[2] ? { currency: match[2].toUpperCase() } : {}) }
    if (afterCode) return { amount: afterCode[2]!.replaceAll(',', ''), currency: afterCode[1]!.toUpperCase() }
  }
  return undefined
}

/** Notifications are an additional side effect and require a customer instruction. */
export function requestedCustomerNotification(messages: readonly { role: string; content: string }[]): boolean {
  for (const entry of currentTaskMessages(messages).slice().reverse()) {
    if (entry.role !== 'user') continue
    const text = entry.content
    if (/\b(?:do not|don't|don’t|no need to|never)\s+(?:send|email|notify)|\bno\s+(?:email|notification|receipt)\b/i.test(text)) return false
    if (/\b(?:notify\s+(?:me|the customer)|email\s+me|send\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:refund\s+|cancellation\s+|confirmation\s+)?(?:email|notification|receipt|confirmation))\b/i.test(text)) return true
  }
  return false
}

/** An explicit full refund delegates the amount to Shopify's current balance. */
export function requestedFullRefund(messages: readonly { role: string; content: string }[]): boolean {
  if (requestedRefundAmount(messages)) return false
  return currentTaskMessages(messages).some((entry) => FULL_REFUND.test(entry.content))
}
