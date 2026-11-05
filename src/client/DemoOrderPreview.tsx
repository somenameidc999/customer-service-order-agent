import { Card } from 'pixel-retroui'

const exampleOrder = {
  order: '#1126',
  status: 'paid',
  fulfillment: 'unfulfilled',
  total: '500.00 USD',
}

export function DemoOrderPreview() {
  return (
    <Card className="demo-order-preview">
      <div className="demo-order-preview-label"><span>EXAMPLE ORDER</span><code>{exampleOrder.order}</code></div>
      <pre aria-label="Example order JSON"><code>{JSON.stringify(exampleOrder, null, 2)}</code></pre>
    </Card>
  )
}
