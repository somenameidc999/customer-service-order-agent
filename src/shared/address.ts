// Shipping-address policy shared by the agent guardrails and the Shopify write
// client. Shipping to a PO box is not supported by this store, so the rule is
// enforced before a proposal is created and again before any mutation.

/**
 * Match the common spellings of a PO box street line: "PO Box 12", "P.O. Box
 * 12", "P O Box 12", "POBox 12" and "Post Office Box 12". The trailing word
 * boundary keeps street names such as "Boxwood Lane" out of the match.
 */
const PO_BOX_LINE = /\b(?:p\.?\s*o\.?|post\s*office)\s*box\b/i

/** True when a single address line names a PO box rather than a street. */
export function isPoBoxLine(value: unknown): boolean {
  return typeof value === 'string' && PO_BOX_LINE.test(value)
}

/** True when either supplied address line names a PO box. */
export function isPoBoxAddress(address: unknown): boolean {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return false
  const lines = address as { address1?: unknown; address2?: unknown }
  return isPoBoxLine(lines.address1) || isPoBoxLine(lines.address2)
}
