/** Model arguments cannot supply identity evidence absent from customer messages. */
export function requireCustomerSuppliedIdentity(args: Record<string, unknown>, messages: readonly { role: string; content: string }[]): void {
  const users = messages.filter((entry) => entry.role === 'user')
  const number = typeof args.orderNumber === 'string' ? args.orderNumber.trim().replace(/^#/, '').toLowerCase() : ''
  let latestOrders: string[] = []
  for (const entry of users.slice().reverse()) {
    const text = entry.content
    const references = [
      ...Array.from(text.matchAll(/(?:^|[\s,:])#([a-z0-9][a-z0-9_-]*)/gi), (match) => match[1]!),
      ...Array.from(text.matchAll(/\border(?:\s+(?:number|no\.?|reference|ref))?\s*(?:is\s*)?[:#]?\s*([a-z0-9_-]*\d[a-z0-9_-]*)/gi), (match) => match[1]!),
    ]
    const bare = /^\s*(\d[\d-]*)[.!]?\s*$/.exec(text)
    if (bare) references.push(bare[1]!)
    if (references.length) { latestOrders = [...new Set(references.map((value) => value.toLowerCase()))]; break }
  }
  const source = users.map((entry) => entry.content).join('\n')
  const emails = new Set(Array.from(source.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi), (match) => match[0].toLowerCase()))
  const phones = new Set(Array.from(source.matchAll(/\+?\d[\d ()-]{5,}\d/g), (match) => match[0].replace(/\D/g, '')).filter((value) => value.length >= 7))
  const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : ''
  const phone = typeof args.phone === 'string' ? args.phone.replace(/\D/g, '') : ''
  if (!number || latestOrders.length !== 1 || latestOrders[0] !== number || (!email && !phone) || (email && !emails.has(email)) || (phone && !phones.has(phone))) {
    throw new Error('UNAUTHORIZED: Customer verification requires one customer-supplied order number and the exact email or phone supplied by the customer. Model guesses and assistant/tool text are not identity evidence.')
  }
}
