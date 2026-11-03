import { useEffect, useState } from 'react'
import { Card } from 'pixel-retroui'
import type { HealthResponse } from '../shared/contracts'

export function SystemCheck() {
  const [response, setResponse] = useState<HealthResponse | null>(null)
  const [status, setStatus] = useState('Checking')

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/health', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      .then(async (result) => {
        if (!result.ok) throw new Error('Health request failed')
        const health = await result.json() as HealthResponse
        if (controller.signal.aborted) return
        setResponse(health)
        setStatus(`${result.status} OK`)
      })
      .catch(() => { if (!controller.signal.aborted) setStatus('Unavailable') })
    return () => controller.abort()
  }, [])

  return (
    <Card bg="#e5e9dc" borderColor="#263f34" shadowColor="#c0c6b3" textColor="#263f34" className="system-check">
      <div className="system-check-bar">
        <span className="system-check-dots" aria-hidden="true"><i /><i /><i /></span>
        <span>server / system-check</span>
      </div>
      <div className="system-check-body">
        <div className="system-check-endpoint"><span>GET</span><code>/api/health</code><span role="status">{status}</span></div>
        <pre aria-label="Live API health response"><code>{response ? JSON.stringify(response, null, 2) : status === 'Checking' ? 'Waiting for the API…' : 'Could not reach the API.'}</code></pre>
      </div>
    </Card>
  )
}
