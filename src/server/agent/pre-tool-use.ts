import { isPoBoxAddress } from '../../shared/address.js'

/**
 * A hook that runs immediately before a tool executes. Throwing from the hook
 * blocks the call: the tool never runs, the call is reported as failed, and no
 * proposal or Shopify mutation is created.
 */
export interface PreToolUseContext {
  /** Name of the tool the model is about to call. */
  tool: string
  /** Parsed, not-yet-executed tool arguments. */
  args: Record<string, unknown>
}

export interface PreToolUseHook {
  name: string
  run: (context: PreToolUseContext) => void | Promise<void>
}

export const PO_BOX_BLOCKED_MESSAGE = 'PO_BOX_BLOCKED: Shipping to a PO box is not supported. Provide a physical street address.'

/**
 * Pre-tool-use hook for `updateShippingAddress`: a shipping address that is a
 * PO box is refused before the update tool can build a confirmation card.
 */
export function addressPoBoxHook(): PreToolUseHook {
  return {
    name: 'block-po-box-address',
    run: ({ tool, args }) => {
      if (tool !== 'updateShippingAddress' || !isPoBoxAddress(args.address)) return
      throw new Error(PO_BOX_BLOCKED_MESSAGE)
    },
  }
}

/** The pre-tool-use hooks every agent turn runs, in order. */
export function defaultPreToolUseHooks(): PreToolUseHook[] {
  return [addressPoBoxHook()]
}
