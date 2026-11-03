// Pre-tool-use hooks (docs/security.md §5, §10).
//
// A hook observes a tool call the agent is about to make and can block it. The
// refund hook blocks a monetary refund above the auto-approval ceiling so it is
// queued for human review instead of being proposed to the customer. The model
// never decides the ceiling and never sees a way to bypass it.

/** Refunds strictly above this amount require human review (docs/security.md §5). */
export const REFUND_AUTO_APPROVE_MAX_DEFAULT = 500

/** The observable name of the refund guardrail hook. */
export const REFUND_ESCALATION_HOOK = 'refund-threshold'

/**
 * The auto-approval ceiling in the refund currency. Defaults to 500 and can be
 * overridden with `REFUND_AUTO_APPROVE_MAX`. A refund strictly above it is
 * escalated; a refund at or below it follows the normal confirmation flow.
 */
export function refundAutoApproveMax(): number {
  const raw = process.env.REFUND_AUTO_APPROVE_MAX?.trim()
  if (!raw) return REFUND_AUTO_APPROVE_MAX_DEFAULT
  const parsed = Number(raw.replaceAll(',', ''))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : REFUND_AUTO_APPROVE_MAX_DEFAULT
}

/** Parse a refund amount from model arguments or a normalized action payload. */
export function refundAmount(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replaceAll(',', ''))
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** True when a refund amount is strictly above the auto-approval ceiling. */
export function exceedsRefundLimit(value: unknown, max: number = refundAutoApproveMax()): boolean {
  const amount = refundAmount(value)
  return amount !== undefined && amount > max
}

export interface PreToolUseCall {
  name: string
  args: Record<string, unknown>
}

/** The reason a hook blocked a tool call and sent it to a human instead. */
export interface ToolEscalation {
  hook: string
  summary: string
}

export class RefundReviewRequired extends Error {
  constructor(readonly escalation: ToolEscalation) {
    super(escalation.summary)
    this.name = 'RefundReviewRequired'
  }
}

export type PreToolUseDecision =
  | { decision: 'allow' }
  | { decision: 'escalate'; escalation: ToolEscalation }

/** A guardrail that runs before a tool call executes. */
export interface PreToolUseHook {
  name: string
  run: (call: PreToolUseCall) => PreToolUseDecision
}

/** Human-readable escalation summary. The support store redacts contact data. */
export function refundEscalationSummary(
  amount: string | number,
  currency: string,
  orderId: string,
  reason: string,
  max: number = refundAutoApproveMax(),
): string {
  const order = orderId ? ` for order ${orderId}` : ''
  const explanation = reason ? ` Reason: ${reason}.` : ''
  return `The requested refund of ${amount} ${currency}${order} is above the ${max} ${currency} limit and requires human review.${explanation}`
}

/**
 * Block a refund whose explicit amount is above the ceiling. A full-refund
 * request omits the amount because Shopify computes the exact balance; that
 * resolved amount is checked before saving a proposal. Revisions use the
 * same createRefund tool and replace the previous proposal.
 */
export function createRefundThresholdHook(options: { max?: number } = {}): PreToolUseHook {
  return {
    name: REFUND_ESCALATION_HOOK,
    run: ({ name, args }) => {
      if (name !== 'createRefund') return { decision: 'allow' }
      const max = options.max ?? refundAutoApproveMax()
      const amount = refundAmount(args.amount)
      if (amount === undefined || amount <= max) return { decision: 'allow' }
      const currency = typeof args.currency === 'string' && args.currency.trim() ? args.currency.trim().toUpperCase() : 'USD'
      const orderId = typeof args.orderId === 'string' ? args.orderId.trim() : ''
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      return {
        decision: 'escalate',
        escalation: {
          hook: REFUND_ESCALATION_HOOK,
          summary: refundEscalationSummary(amount, currency, orderId, reason, max),
        },
      }
    },
  }
}

export function defaultToolHooks(): PreToolUseHook[] {
  return [createRefundThresholdHook()]
}
