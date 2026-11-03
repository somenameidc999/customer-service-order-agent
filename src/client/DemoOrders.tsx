import { useEffect, useState } from 'react'
import type { DemoOrder } from '../shared/demo-orders'

const ORDERS_PER_PAGE = 10

function formatStatus(status: string | null) {
  return status ? status.toLowerCase().replaceAll('_', ' ') : 'Unknown'
}

function formatMoney(money: DemoOrder['total']) {
  return `${money.amount} ${money.currencyCode}`
}

export function DemoOrders({ revision }: { revision: number }) {
  const [open, setOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [orders, setOrders] = useState<DemoOrder[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copyFeedback, setCopyFeedback] = useState('')
  const [page, setPage] = useState(0)
  const orderCount = orders?.length ?? 0
  const pageCount = Math.ceil(orderCount / ORDERS_PER_PAGE)
  const currentPage = Math.min(page, Math.max(0, pageCount - 1))
  const first = currentPage * ORDERS_PER_PAGE
  const visibleOrders = orders?.slice(first, first + ORDERS_PER_PAGE)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetch('/api/demo-orders', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not refresh demo orders.')
        const data = await response.json() as { orders: DemoOrder[] }
        if (!controller.signal.aborted) setOrders(data.orders)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Could not refresh demo orders. Try again.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [open, refresh, revision])

  async function copyOrder(order: DemoOrder) {
    try {
      await navigator.clipboard.writeText(`Order ${order.number}. My email is ${order.email}.`)
      setCopyFeedback(`Copied ${order.number} and its demo email.`)
    } catch {
      setCopyFeedback('Copy the order number and email from the details above.')
    }
  }

  return (
    <details className="demo-orders" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><strong>Demo orders</strong><span>Test orders from Shopify</span></summary>
      <div className="demo-order-content" aria-busy={loading}>
        <div className="demo-order-tools">
          <p>Use the order number and demo email in chat. Use sample details when testing changes.</p>
          <button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh orders'}</button>
        </div>
        {error && <p role="alert">{error}{orders?.length ? ' Showing the last loaded details.' : ''}</p>}
        {!orders && loading && <p role="status">Loading demo orders…</p>}
        {orders?.length === 0 && !error && !loading && <p>No demo orders are configured.</p>}
        <div className="demo-order-list">
          {visibleOrders?.map((order) => (
            <details key={order.number} name="demo-order" className="demo-order">
              <summary>
                <strong>{order.number}</strong>
                <span className="demo-order-status">{order.cancelledAt ? 'Cancelled' : formatStatus(order.financialStatus)}</span>
                <span>{formatMoney(order.total)}</span>
              </summary>
              <div className="demo-order-details">
                <dl>
                  {order.customerName && <div><dt>Customer</dt><dd>{order.customerName}</dd></div>}
                  <div className="demo-order-wide"><dt>Demo email</dt><dd><code>{order.email}</code></dd></div>
                  <div><dt>Payment</dt><dd className="demo-order-status">{formatStatus(order.financialStatus)}</dd></div>
                  <div><dt>Fulfillment</dt><dd className="demo-order-status">{formatStatus(order.fulfillmentStatus)}</dd></div>
                  <div><dt>Refunded</dt><dd>{formatMoney(order.refunded)}</dd></div>
                  <div><dt>Discount</dt><dd>{formatMoney(order.discount)}</dd></div>
                  <div className="demo-order-wide"><dt>Shipping address</dt><dd>{order.shippingAddress.join(', ') || 'None'}</dd></div>
                  <div><dt>Updated in Shopify</dt><dd><time dateTime={order.updatedAt}>{new Date(order.updatedAt).toLocaleString()}</time></dd></div>
                  {order.cancelledAt && <div><dt>Cancelled</dt><dd><time dateTime={order.cancelledAt}>{new Date(order.cancelledAt).toLocaleString()}</time></dd></div>}
                </dl>
                {order.items.length > 0 && <ul aria-label="Order items">{order.items.map((item, index) => <li key={index}>{item.quantity} × {item.title}</li>)}</ul>}
                {order.itemsTruncated && <p>Showing the first 20 items.</p>}
                <button type="button" onClick={() => void copyOrder(order)}>Copy order and email</button>
                <span className="demo-order-copy" role="status">{copyFeedback}</span>
              </div>
            </details>
          ))}
        </div>
        {pageCount > 1 && <nav className="demo-order-pages" aria-label="Demo order pages">
          <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
          <span aria-live="polite">Orders {first + 1}–{first + (visibleOrders?.length ?? 0)} of {orderCount}</span>
          <button type="button" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next</button>
        </nav>}
      </div>
    </details>
  )
}
