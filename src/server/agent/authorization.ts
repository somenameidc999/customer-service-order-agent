// Deterministic, server-side authorization for customer data.
//
// Authorization is never derived from model output. The only way to establish
// an identity is a successful `findCustomer` call, which proves the caller
// knows the order number plus a matching email/phone. The verified identity
// lives for exactly one agent turn and is threaded into every spoke tool, so an
// order/PII tool invoked without it fails closed. See docs/security.md §3 and
// docs/architecture.md ("Authorization is enforced for reads too").

/** A customer identity proven by the two-factor `findCustomer` rule. */
export interface VerifiedIdentity {
  customerId: string
  /** Orders already proven to belong to this identity during the turn. */
  orderIds: ReadonlySet<string>
}

/** Per-turn authorization state shared by every spoke the hub spawns. */
export interface AuthorizationContext {
  readonly identity: VerifiedIdentity | null
  /** Record the customer resolved by a successful two-factor lookup. */
  identify(identity: { customerId: string; orderIds?: Iterable<string> }): void
}

export function createAuthorizationContext(): AuthorizationContext {
  let identity: VerifiedIdentity | null = null
  return {
    get identity() {
      return identity
    },
    identify(next) {
      identity = { customerId: next.customerId, orderIds: new Set(next.orderIds ?? []) }
    },
  }
}
