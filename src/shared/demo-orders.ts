export interface DemoOrder {
  number: string
  email: string
  financialStatus: string | null
  fulfillmentStatus: string
  cancelledAt: string | null
  updatedAt: string
  total: { amount: string; currencyCode: string }
  refunded: { amount: string; currencyCode: string }
  shippingAddress: string[]
  items: { title: string; quantity: number }[]
  itemsTruncated: boolean
}
