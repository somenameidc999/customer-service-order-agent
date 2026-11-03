import { useState } from 'react'
import { Card } from 'pixel-retroui'
import { ChatPanel } from './ChatPanel'
import { DemoOrders } from './DemoOrders'

const ink = '#263f34'

export function App() {
  const [orderRevision, setOrderRevision] = useState(0)

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="/">
          <svg aria-hidden="true" viewBox="0 0 32 32" fill="currentColor">
            <path d="M12 0h8v8h4v4h8v8h-8v4h-4v8h-8v-8H8v-4H0v-8h8V8h4z" />
          </svg>
          Order support
        </a>
        <span className="live-tag"><span className="status-dot" /> SHOPIFY DEMO</span>
      </header>

      <main className="demo-main">
        <DemoOrders revision={orderRevision} />
        <section className="chat-section" aria-labelledby="chat-title">
          <Card bg="#e5e9dc" borderColor={ink} shadowColor="#c6c9b9" textColor={ink} className="chat-card">
            <h1 id="chat-title">Chat with the order agent</h1>
            <p className="card-description">Ask about an order, update a shipping address, or request a refund.</p>
            <ChatPanel onOrderChange={() => setOrderRevision((value) => value + 1)} />
          </Card>
        </section>
      </main>
    </div>
  )
}
