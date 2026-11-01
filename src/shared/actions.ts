export type ShopifyActionKind = 'refund' | 'shipping_address' | 'cancel_order'
export type ShopifyActionStatus = 'pending' | 'executing' | 'succeeded' | 'processing' | 'failed' | 'unknown' | 'cancelled' | 'expired'

export interface ShippingAddress {
  address1: string
  address2?: string
  city: string
  provinceCode?: string
  zip: string
  countryCode: string
  firstName?: string
  lastName?: string
  phone?: string
  company?: string
}

export interface ShopifyActionView {
  id: string
  kind: ShopifyActionKind
  orderName: string
  title: string
  details: string[]
  requiresApproval: boolean
  status: ShopifyActionStatus
  expiresAt: string
  result?: { message: string; shopifyId?: string }
  error?: string
}

export interface PendingShopifyAction { pendingAction: ShopifyActionView }
