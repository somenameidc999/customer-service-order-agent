import { ShopifyClientError } from './client.js'

export function currencyDigits(currency: string): number {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2 }
  catch { throw new ShopifyClientError('INVALID_INPUT', 'The refund currency is invalid.') }
}

export function moneyUnits(amount: string, currency: string): bigint {
  const match = /^(\d{1,15})(?:\.(\d+))?$/.exec(amount.trim())
  const digits = currencyDigits(currency)
  if (!match || (match[2]?.length ?? 0) > digits) throw new ShopifyClientError('INVALID_INPUT', `Use a valid ${currency} amount with at most ${digits} decimal places.`)
  return BigInt(match[1]) * 10n ** BigInt(digits) + BigInt((match[2] ?? '').padEnd(digits, '0') || '0')
}

export function moneyString(units: bigint, currency: string): string {
  const digits = currencyDigits(currency)
  const text = units.toString().padStart(digits + 1, '0')
  return digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text
}
