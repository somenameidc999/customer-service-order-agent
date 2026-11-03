import type { Hono } from 'hono'
import { chatSession } from '../agent/session.js'
import { jsonBodyError, readJsonBody } from '../request-security.js'
import { ActionError, getShopifyActionStore, type ShopifyActionStore } from './actions.js'
import { ShopifyClientError } from './client.js'
import { createShopifyLiveClient } from './live-client.js'

export interface ActionRouteOptions {
  store?: ShopifyActionStore
  client?: (sessionId: string) => Pick<ReturnType<typeof createShopifyLiveClient>, 'executeAction' | 'checkAction'>
}

export function registerActionRoutes(app: Hono, options: ActionRouteOptions = {}, publicOrigin?: string): void {
  const store = () => options.store ?? getShopifyActionStore()
  const client = options.client ?? ((sessionId: string) => createShopifyLiveClient({ sessionId }))

  app.get('/api/actions', (c) => c.json({ actions: store().list(chatSession(c, Boolean(publicOrigin))) }))

  app.post('/api/actions/:id/:operation', async (c) => {
    const parsed = await readJsonBody(c.req.raw)
    if ('status' in parsed) return c.json({ error: jsonBodyError(parsed.status) }, parsed.status)
    const body = parsed.value
    if (!body || typeof body !== 'object') return c.json({ error: 'Provide an action request object.' }, 400)
    const { id, operation } = c.req.param()
    const session = chatSession(c, Boolean(publicOrigin))
    try {
      if (operation === 'dismiss') return c.json({ action: store().cancel(id, session) })
      const action = store().get(id, session)
      if (operation === 'check') {
        if (!['unknown','processing','executing'].includes(action.view.status)) return c.json({ action: action.view })
        const outcome = await client(session).checkAction(action)
        return c.json({ action: store().finish(action, outcome.status, outcome.result).view })
      }
      if (operation !== 'confirm') return c.json({ error: 'Unknown action operation.' }, 404)
      if ((body as { confirmed?: unknown }).confirmed !== true) return c.json({ error: 'Explicit confirmation is required.' }, 400)
      // A replay returns its existing result. Neither the model nor the browser can change the stored payload.
      if (action.view.status !== 'pending') return c.json({ action: action.view })
      const claimed = store().claim(id, session, (body as { approved?: unknown }).approved === true)
      try {
        const outcome = await client(session).executeAction(claimed)
        return c.json({ action: store().finish(claimed, outcome.status, outcome.result).view })
      } catch (error) {
        const uncertain = error instanceof ShopifyClientError && error.code === 'OUTCOME_UNKNOWN'
        const message = error instanceof ShopifyClientError ? error.message : 'The action outcome could not be confirmed. Check Shopify before retrying.'
        return c.json({ action: store().finish(claimed, uncertain || !(error instanceof ShopifyClientError) ? 'unknown' : 'failed', undefined, message).view })
      }
    } catch (error) {
      if (error instanceof ActionError) return c.json({ error: error.message }, error.status as 400 | 404 | 409)
      if (error instanceof ShopifyClientError) return c.json({ error: error.message }, 409)
      return c.json({ error: 'The action could not be loaded. Please try again.' }, 500)
    }
  })
}
