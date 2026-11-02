// Shipping-address policy shared by the agent guardrails and the Shopify write
// client. Shipping to a PO box is not supported by this store, so the rule is
// enforced before a proposal is created and again before any mutation.

/**
 * Match the common spellings of a PO box street line. Besides the long forms
 * ("PO Box 12", "P.O. Box 12", "P O Box 12", "POBox 12", "Post Office Box
 * 12") this covers the equally common abbreviations "POB 12" / "P.O.B. 12"
 * and "Postal Box 12" / "Post Box 12".
 *
 * The leading word boundary keeps a stray "box" ("Unit 4, Box 12") or a name
 * prefixed by an unrelated word out of the match. The trailing lookahead
 * rejects a following letter so that street names such as "Boxwood Lane" and
 * words such as "Poblano Way" (or "Postal Boxcar") do not match, while still
 * detecting the digit-suffixed forms "POB123" and "POBox123".
 */
const PO_BOX_LINE = /\b(?:p\.?\s*o\.?\s*b(?:\s*ox)?|post(?:\s*office|al)?\s*box)(?![a-z])/i

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
