import { useState } from 'react'
import type { ShopifyActionView } from '../shared/actions'

export function ActionConfirmation({ action, onChange }: { action: ShopifyActionView; onChange: (action: ShopifyActionView) => void }) {
  const [approved, setApproved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = action.status === 'pending' && Date.parse(action.expiresAt) > Date.now()
  const canCheck = ['executing','unknown','processing'].includes(action.status)

  async function submit(operation: 'confirm' | 'dismiss' | 'check') {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/actions/${encodeURIComponent(action.id)}/${operation}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: operation === 'confirm', approved }),
      })
      const result = await response.json() as { action?: ShopifyActionView; error?: string }
      if (!response.ok || !result.action) throw new Error(result.error || 'The action could not be confirmed.')
      onChange(result.action)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Check the action status before retrying.')
    } finally { setBusy(false) }
  }

  return <section className={`action-confirmation action-${action.status}`} aria-label={`${action.title} confirmation`} data-action-id={action.id}>
    <div className="action-heading"><strong>{action.title}</strong><span>{pending ? 'Awaiting confirmation' : action.status}</span></div>
    <ul>{action.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>
    {pending && <>
      <p>Review these exact details before confirming. This changes the order in Shopify.</p>
      {action.requiresApproval && <label className="action-approval"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} disabled={busy} /> I approve this action as the store operator.</label>}
      <div className="action-buttons">
        <button type="button" onClick={() => void submit('confirm')} disabled={busy || action.requiresApproval && !approved}>{busy ? 'Submitting…' : 'Confirm in Shopify'}</button>
        <button type="button" onClick={() => void submit('dismiss')} disabled={busy}>Dismiss</button>
      </div>
      <small>Proposal expires at {new Date(action.expiresAt).toLocaleTimeString()}.</small>
    </>}
    {action.result && <p role="status">{action.result.message}{action.result.shopifyId && <><br /><code>{action.result.shopifyId}</code></>}</p>}
    {action.error && <p role="alert">{action.error}</p>}
    {!pending && action.status === 'pending' && <p>This proposal expired. Request a new proposal.</p>}
    {canCheck && <button type="button" disabled={busy} onClick={() => void submit('check')}>{busy ? 'Checking…' : 'Check Shopify status'}</button>}
    {error && <p role="alert">{error}</p>}
  </section>
}
