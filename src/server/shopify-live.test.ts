import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createShopifyLiveClient } from './shopify/live-client.js'
import { createAgentTurn } from './agent/agent.js'
import { createCommerceToolRegistry } from './agent/tools.js'
import type { ShopifyConfig } from './shopify/config.js'
import type { FetchLike } from './shopify/token.js'
import type { AgentEvent } from '../shared/chat.js'

const config: ShopifyConfig = {
  storeDomain: 'unit-test.myshopify.com', clientId: 'client-id', clientSecret: 'client-secret',
  accessToken: null, scopes: [], apiVersion: '2026-10',
}
const contact = {
  id: 'gid://shopify/Customer/42', firstName: 'Customer', lastName: null,
  defaultEmailAddress: { emailAddress: 'customer@example.com' }, defaultPhoneNumber: null,
}
const rawOrder = {
  id: 'gid://shopify/Order/42', name: '#42', email: 'customer@example.com', phone: null, customer: contact,
  displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
  totalPriceSet: { shopMoney: { amount: '12.34', currencyCode: 'CAD' } },
  shippingAddress: null,
  lineItems: { nodes: [{ id: 'line-42', title: 'Store item', quantity: 1, variant: null }], pageInfo: { hasNextPage: true } },
  refunds: [{ id: 'refund-42', createdAt: '2026-10-30T12:00:00Z', note: 'Adjustment', totalRefundedSet: { shopMoney: { amount: '1.00', currencyCode: 'CAD' } } }],
}
const rawProduct = {
  id: 'gid://shopify/Product/42', title: 'Store item', description: 'Description from the API.', status: 'ACTIVE',
  variants: { nodes: [{ id: 'variant-42', title: 'Small', price: '12.34', availableForSale: false }], pageInfo: { hasNextPage: true } },
}
function json(body: unknown, status = 200): Response { return Response.json(body, { status }) }

test('chat cancellation reaches Shopify token and GraphQL requests', async () => {
  for (const accessToken of [null, 'dummy-token']) {
    const abort = new AbortController()
    let calls = 0
    let destination = ''
    let requestSignal: AbortSignal | null | undefined
    const client = createShopifyLiveClient({
      config: { ...config, accessToken },
      signal: abort.signal,
      fetch: async (input, init) => {
        calls++
        destination = String(input)
        requestSignal = init?.signal
        abort.abort()
        throw abort.signal.reason
      },
    })
    await assert.rejects(client.searchProducts({ query: 'pillow' }))
    await assert.rejects(client.searchProducts({ query: 'blanket' }))
    assert.match(destination, accessToken ? /\/graphql\.json$/ : /\/oauth\/access_token$/)
    assert.equal(requestSignal?.aborted, true)
    assert.equal(calls, 1)
  }
})

function transport(handler: (body: { query: string; variables: Record<string, unknown> }) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init })
    return String(input).endsWith('/admin/oauth/access_token')
      ? json({ access_token: 'private-token', expires_in: 3600 })
      : handler(JSON.parse(String(init?.body)))
  }
  return { fetch, calls }
}

test('demo orders query at most twenty configured IDs and exclude real orders and real email domains', async () => {
  const order = {
    ...rawOrder, test: true, updatedAt: '2026-11-03T12:00:00Z', cancelledAt: null,
    totalPriceSet: { presentmentMoney: { amount: '12.34', currencyCode: 'CAD' } },
    totalDiscountsSet: { presentmentMoney: { amount: '2.00', currencyCode: 'CAD' } },
    totalRefundedSet: { presentmentMoney: { amount: '1.00', currencyCode: 'CAD' } },
    shippingAddress: { formatted: ['12 Test Street'] },
  }
  const mock = transport(({ query, variables }) => {
    assert.match(query, /^query DemoOrders/)
    assert.deepEqual(variables.ids, Array.from({ length: 20 }, (_, index) => `gid://shopify/Order/${42 + index}`))
    return json({ data: { nodes: [order,
      { ...order, id: 'gid://shopify/Order/43', test: false },
      { ...order, id: 'gid://shopify/Order/44', email: 'visitor@real-shop.com' },
      { ...order, id: 'gid://shopify/Order/99' }, null,
    ] } })
  })
  const client = createShopifyLiveClient({ config, fetch: mock.fetch })
  assert.deepEqual(await client.listDemoOrders('other-shop.myshopify.com', ['42']), [])
  assert.equal(mock.calls.length, 0)
  const orders = await client.listDemoOrders(config.storeDomain, ['bad-id', '42', ...Array.from({ length: 25 }, (_, index) => String(42 + index))])
  assert.deepEqual(orders.map(({ number, email, refunded, shippingAddress }) => ({ number, email, refunded, shippingAddress })), [{
    number: '#42', email: 'customer@example.com', refunded: { amount: '1.00', currencyCode: 'CAD' }, shippingAddress: ['12 Test Street'],
  }])
  assert.equal('customer' in orders[0]!, false)
  assert.equal(orders[0]!.customerName, 'Customer')
  assert.deepEqual(orders[0]!.discount, { amount: '2.00', currencyCode: 'CAD' })
  assert.deepEqual(orders[0]!.items, [{ title: 'Store item', quantity: 1 }])
})

test('live product tools preserve API IDs, currency, price and availability', async () => {
  const mock = transport(() => json({ data: { shop: { currencyCode: 'CAD' }, products: { nodes: [rawProduct] }, product: rawProduct } }))
  const client = createShopifyLiveClient({ config, fetch: mock.fetch })
  const products = await client.searchProducts({ query: 'snowboard', limit: 100 })
  assert.deepEqual(products, [{ ...rawProduct, variants: rawProduct.variants.nodes, variantsTruncated: true, currency: 'CAD' }])
  assert.equal((await client.getProduct({ productId: rawProduct.id })).id, rawProduct.id)
  assert.equal(mock.calls.filter((call) => call.url.endsWith('/admin/oauth/access_token')).length, 1)
  const sent = mock.calls[1]!
  assert.equal(sent.url, 'https://unit-test.myshopify.com/admin/api/2026-10/graphql.json')
  assert.equal(new Headers(sent.init?.headers).get('X-Shopify-Access-Token'), 'private-token')
  assert.deepEqual(JSON.parse(String(sent.init?.body)).variables, { query: 'status:active AND (snowboard)', first: 20 })
})

test('empty and missing products never fall back to sample records', async () => {
  const mock = transport(() => json({ data: { shop: { currencyCode: 'USD' }, products: { nodes: [] }, product: null } }))
  const client = createShopifyLiveClient({ config, fetch: mock.fetch })
  assert.deepEqual(await client.searchProducts({ query: 'no-match' }), [])
  await assert.rejects(client.getProduct({ productId: 'missing' }), /NOT_FOUND|did not find/)
})

test('Shopify HTTP and GraphQL failures remain failures, including partial data', async () => {
  for (const response of [
    json({}, 503), json({ data: { products: { nodes: [rawProduct] } }, errors: [{ message: 'Access denied private-token client-secret', extensions: { code: 'ACCESS_DENIED' } }] }),
    json({}), new Response('invalid JSON'),
  ]) {
    const mock = transport(() => response)
    await assert.rejects(createShopifyLiveClient({ config, fetch: mock.fetch }).searchProducts({ query: 'mug' }), (error: Error) => {
      assert.equal(error.name, 'ShopifyClientError')
      assert.doesNotMatch(error.message, /private-token|client-secret|Retro Pixel Mug/)
      return true
    })
  }
})

test('a rejected token is refreshed once and a persistent rejection stops', async () => {
  for (const persistent of [false, true]) {
    let requests = 0
    const mock = transport(() => ++requests === 1 || persistent
      ? json({}, 401)
      : json({ data: { shop: { currencyCode: 'USD' }, products: { nodes: [] } } }))
    const operation = createShopifyLiveClient({ config, fetch: mock.fetch }).searchProducts({ query: '*' })
    if (persistent) await assert.rejects(operation, /HTTP 401/)
    else assert.deepEqual(await operation, [])
    assert.equal(requests, 2)
    assert.equal(mock.calls.filter((call) => call.url.endsWith('/admin/oauth/access_token')).length, 2)
  }
})

test('order data is blocked until matching contact details verify that order', async () => {
  const mock = transport(({ query }) => json({ data: query.includes('query OrderByNumber')
    ? { orders: { nodes: [rawOrder], pageInfo: { hasNextPage: false } } }
    : { order: rawOrder, customer: contact } }))
  const client = createShopifyLiveClient({ config, fetch: mock.fetch })
  await assert.rejects(client.getOrder({ orderId: rawOrder.id }), /Verify/)
  await assert.rejects(client.getOrderByNumber({ orderNumber: '#42' }), /Verify/)
  await assert.rejects(client.getCustomer({ customerId: contact.id }), /Verify/)
  await assert.rejects(client.listCustomerOrders({ customerId: contact.id }), /Verify/)
  await assert.rejects(client.listOrderRefunds({ orderId: rawOrder.id }), /Verify/)
  assert.equal(mock.calls.length, 0)
  await assert.rejects(client.findCustomer({ orderNumber: '#42', email: 'wrong@example.com' }), /could not be verified/)
  await assert.rejects(client.getOrder({ orderId: rawOrder.id }), /Verify/)
  const verified = await client.findCustomer({ orderNumber: '#42', email: 'CUSTOMER@example.com' })
  assert.equal(verified.order.total, '12.34')
  assert.equal(verified.order.lineItemsTruncated, true)
  assert.equal((await client.getOrderByNumber({ orderNumber: '42' })).id, rawOrder.id)
  assert.equal((await client.getCustomer({ customerId: contact.id })).email, 'customer@example.com')
  assert.equal((await client.listOrderRefunds({ orderId: rawOrder.id }))[0]?.amount, '1.00')
  await assert.rejects(client.getOrder({ orderId: 'another-order' }), /Verify/)
  await assert.rejects(createShopifyLiveClient({ config, fetch: mock.fetch }).getOrder({ orderId: rawOrder.id }), /Verify/)
})

test('order lookup validates exact names and never guesses an ambiguous order', async () => {
  for (const nodes of [[{ ...rawOrder, name: '#420' }], [rawOrder, rawOrder]]) {
    const mock = transport(() => json({ data: { orders: { nodes, pageInfo: { hasNextPage: false } } } }))
    await assert.rejects(createShopifyLiveClient({ config, fetch: mock.fetch }).findCustomer({ orderNumber: '#42', email: 'customer@example.com' }))
  }
})

test('verified customer order listing reads real orders and refuses another owner', async () => {
  const mock = transport(({ query, variables }) => {
    if (query.includes('query OrderByNumber')) return json({ data: { orders: { nodes: [rawOrder], pageInfo: { hasNextPage: false } } } })
    if (query.includes('query CustomerOrders')) return json({ data: { customer: { orders: { nodes: [{ id: rawOrder.id }, { id: 'another-order' }] } } } })
    return json({ data: { order: variables.id === 'another-order' ? { ...rawOrder, id: 'another-order', customer: { ...contact, id: 'another-customer' } } : rawOrder } })
  })
  const client = createShopifyLiveClient({ config, fetch: mock.fetch })
  await client.findCustomer({ orderNumber: '#42', email: 'customer@example.com' })
  const orders = await client.listCustomerOrders({ customerId: contact.id })
  assert.deepEqual(orders.map((order) => order.id), [rawOrder.id])
  await assert.rejects(client.getOrder({ orderId: 'another-order' }), /Verify/)
})

test('unverified live writes cannot claim success or mutate Shopify', async () => {
  const mock = transport(() => { throw new Error('must not call Shopify') })
  const client = createShopifyLiveClient({ config, fetch: mock.fetch })
  const guards = { orderId: rawOrder.id, confirmationToken: 'claimed-confirmation', idempotencyKey: 'test-key' }
  await assert.rejects(client.cancelOrder({ ...guards, reason: 'requested' }), /Verify/)
  await assert.rejects(client.updateShippingAddress({ ...guards, address: 'new address' }), /Verify/)
  await assert.rejects(client.createRefund({ ...guards, amount: '1.00', currency: 'CAD', reason: 'requested' }), /Verify/)
  assert.equal(mock.calls.length, 0)
})

test('default agent registry reaches Shopify and does not retain verification across turns', async () => {
  const previousFetch = globalThis.fetch
  const previousEnv = { ...process.env }
  const mock = transport(({ query }) => {
    if (query.includes('query OrderByNumber')) return json({ data: { orders: { nodes: [rawOrder], pageInfo: { hasNextPage: false } } } })
    if (query.includes('query Order(')) return json({ data: { order: rawOrder } })
    return json({ data: { shop: { currencyCode: 'CAD' }, products: { nodes: [rawProduct] } } })
  })
  try {
    globalThis.fetch = mock.fetch
    process.env.SHOPIFY_STORE_DOMAIN = config.storeDomain
    process.env.SHOPIFY_CLIENT_ID = config.clientId
    process.env.SHOPIFY_CLIENT_SECRET = config.clientSecret
    delete process.env.SHOPIFY_ACCESS_TOKEN
    const products = JSON.parse(await createCommerceToolRegistry().get('searchProducts')!.run({ query: '*' })) as Array<{ id: string }>
    assert.equal(products[0]?.id, rawProduct.id)
    const events: AgentEvent[] = []
    let round = 0
    const turn = createAgentTurn({ llm: { complete: async () => {
      const call = round++ === 0
        ? { id: 'identity', name: 'findCustomer', argumentsText: '{"orderNumber":"#42","email":"customer@example.com"}' }
        : round === 3 ? { id: 'order', name: 'getOrder', argumentsText: JSON.stringify({ orderId: rawOrder.id }) } : null
      return { content: call ? null : 'Finished', toolCalls: call ? [call] : [] }
    } } })
    const input = { messages: [{ id: 'm1', role: 'user' as const, content: 'Check order #42. My email is customer@example.com.', createdAt: new Date().toISOString() }] }
    await turn(input, (event) => events.push(event))
    await turn(input, (event) => events.push(event))
    const outcomes = events.filter((event) => event.type === 'tool_call' && event.phase === 'end')
    assert.equal(outcomes[0]?.type === 'tool_call' && outcomes[0].ok, true)
    assert.equal(outcomes[1]?.type === 'tool_call' && outcomes[1].ok, false)
    assert.ok(mock.calls.some((call) => call.url.includes(config.storeDomain)))
    process.env.SHOPIFY_CLIENT_ID = ''
    process.env.SHOPIFY_CLIENT_SECRET = ''
    const before = mock.calls.length
    await assert.rejects(createCommerceToolRegistry().get('searchProducts')!.run({ query: '*' }), /Shopify is not configured/)
    assert.equal(mock.calls.length, before, 'missing credentials cannot produce sample records or reach the network')
  } finally {
    globalThis.fetch = previousFetch
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
    Object.assign(process.env, previousEnv)
  }
})
