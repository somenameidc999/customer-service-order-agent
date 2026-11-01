import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

;(globalThis as Record<string, unknown>).React = React

test('assistant Markdown renders headings, emphasis, lists, tables, links and code', async () => {
  const { MarkdownMessage } = await import('../client/MarkdownMessage.js')
  const text = '# Products\n\n**Snowboard** and *boots*.\n\n- First\n- Second\n\n| Product | Price |\n| --- | --- |\n| Board | $10 |\n\n`inline`\n\n```js\nconst price = 10\n```\n\n[Shop](https://example.com)'
  const html = renderToStaticMarkup(React.createElement(MarkdownMessage, { text }))
  for (const pattern of [/<h1>Products<\/h1>/, /<strong>Snowboard<\/strong>/, /<em>boots<\/em>/, /<ul>/, /<li>First<\/li>/, /<table>/, /<th>Product<\/th>/, /<code>inline<\/code>/, /<pre><code class="language-js">/, /href="https:\/\/example.com"/]) assert.match(html, pattern)
  assert.doesNotMatch(html, /\*\*Snowboard\*\*/)
})

test('assistant Markdown does not execute raw HTML, scripts, unsafe links or remote images', async () => {
  const { MarkdownMessage } = await import('../client/MarkdownMessage.js')
  const text = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[Bad](javascript:alert%281%29)\n\n![Tracking](https://example.com/tracker.png)'
  const html = renderToStaticMarkup(React.createElement(MarkdownMessage, { text }))
  assert.doesNotMatch(html, /<script|<img|javascript:|onerror|src=/)
  assert.match(html, /Tracking/)
})

test('refund confirmation requires operator approval and completed results show Shopify evidence', async () => {
  const { ActionConfirmation } = await import('../client/ActionConfirmation.js')
  const action: import('../shared/actions.js').ShopifyActionView = {
    id: 'action-1', kind: 'refund', orderName: '#42', title: 'Refund 12.34 USD', details: ['Order #42'],
    requiresApproval: true, status: 'pending', expiresAt: new Date(Date.now() + 60000).toISOString(),
  }
  const html = renderToStaticMarkup(React.createElement(ActionConfirmation, { action, onChange: () => {} }))
  assert.match(html, /type="checkbox"/)
  assert.match(html, /disabled="">Confirm in Shopify/)
  const completed = renderToStaticMarkup(React.createElement(ActionConfirmation, { action: {
    ...action, status: 'succeeded', result: { message: 'Shopify processed the refund.', shopifyId: 'gid://shopify/Refund/42' },
  }, onChange: () => {} }))
  assert.match(completed, /Shopify processed the refund/)
  assert.match(completed, /gid:\/\/shopify\/Refund\/42/)
  assert.doesNotMatch(completed, /Confirm in Shopify/)
})
