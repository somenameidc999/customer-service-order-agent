import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Card, Input } from 'pixel-retroui'
import type { ErrorResponse, HealthResponse, HelloResponse } from '../shared/contracts'
import { ChatPanel } from './ChatPanel'

const ink = '#263f34'
const repoUrl = 'https://github.com/somenameidc999/hono-react-starter'

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d={diagonal ? 'M5 19 19 5M5 5h14v14' : 'M4 12h16m-6-6 6 6-6 6'} />
  </svg>
}

function Spark({ className = '' }: { className?: string }) {
  return <svg aria-hidden="true" className={className} viewBox="0 0 32 32" fill="currentColor">
    <path d="M12 0h8v8h4v4h8v8h-8v4h-4v8h-8v-8H8v-4H0v-8h8V8h4z" />
  </svg>
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [name, setName] = useState('Builder')
  const [reply, setReply] = useState<HelloResponse | null>(null)
  const [requestError, setRequestError] = useState('')
  const [pending, setPending] = useState(false)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const [copyState, setCopyState] = useState('Copy command')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/health', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      .then(async (response) => {
        if (!response.ok) throw new Error('Health check failed')
        setHealth(await response.json() as HealthResponse)
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setHealthError(true)
      })
    return () => { controller.abort(); clearTimeout(copyTimer.current) }
  }, [])

  async function sayHello(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setRequestError('')
    setReply(null)
    setElapsed(null)
    const started = performance.now()
    try {
      const response = await fetch(`/api/hello?${new URLSearchParams({ name })}`, { signal: AbortSignal.timeout(10000) })
      const data = await response.json() as HelloResponse | ErrorResponse
      if (!response.ok || 'error' in data) {
        throw new Error('error' in data ? data.error : 'The request failed. Try again.')
      }
      setReply(data)
      setElapsed(Math.round(performance.now() - started))
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Could not reach Hono. Check the API server.')
    } finally {
      setPending(false)
    }
  }

  async function copyCommand() {
    clearTimeout(copyTimer.current)
    try {
      await navigator.clipboard.writeText('npm run dev')
      setCopyState('Copied!')
    } catch {
      setCopyState('Select and copy the command')
    }
    copyTimer.current = setTimeout(() => setCopyState('Copy command'), 3000)
  }

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Hono and React home"><Spark /> <span>hono<span className="brand-plus">+</span>react<span className="brand-dot">.</span></span></a>
        <div className="header-right">
          <span className={`server-status ${healthError ? 'is-error' : ''}`} role="status"><span className="status-dot" />{health ? 'All systems ready' : healthError ? 'API offline' : 'Connecting to API'}</span>
          <span className="header-divider" />
          <a className="text-link" href={repoUrl} target="_blank" rel="noreferrer">GitHub <Arrow diagonal /></a>
        </div>
      </header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="eyebrow"><span className="tiny-square" /> A LITTLE STARTER. A LOT OF POSSIBILITY.</div>
            <h1 id="hero-title">Small stack.<br />Big <span className="ideas">ideas<svg aria-hidden="true" viewBox="0 0 320 16" preserveAspectRatio="none"><path d="m2 9 82-5 91 5 142-6M8 14l298-2" /></svg></span><span className="coral">.</span></h1>
            <p className="hero-description">Your next thing starts here. A fast Hono backend,<br className="desktop-break" /> a React frontend, and a little retro personality.</p>
            <div className="hero-actions">
              <Button bg={ink} textColor="#f8f4e8" borderColor={ink} shadow="#b0b8a5" className="button hero-button" onClick={() => { document.getElementById('playground')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); document.getElementById('name')?.focus({ preventScroll: true }) }}>Try the API <Arrow /></Button>
              <a className="text-link docs-link" href="https://retroui.io/" target="_blank" rel="noreferrer">Explore RetroUI <Arrow diagonal /></a>
            </div>
            <div className="hero-note"><span>✳</span> TypeScript throughout. Ready for your first commit.</div>
          </div>

          <div className="hero-visual">
            <div className="floating-label"><Spark /> LESS SETUP, MORE MAKING</div>
            <Card bg="#e5e9dc" borderColor={ink} shadowColor="#c0c6b3" textColor={ink} className="health-card">
              <div className="window-bar"><div className="window-dots"><i /><i /><i /></div><span>localhost / system-check</span><span className="window-cross">+</span></div>
              <div className="health-body">
                <div className="endpoint"><span className="method">GET</span><code>/api/health</code><span className={`http-status ${healthError ? 'is-error' : ''}`}>{health ? '200 OK' : healthError ? 'OFFLINE' : 'WAITING'}</span></div>
                <pre aria-label="Live API health response"><code>{health ? <>{'{'}<br />{'  '}<span className="code-key">"status"</span>: <span className="code-string">"{health.status}"</span>,<br />{'  '}<span className="code-key">"service"</span>: <span className="code-string">"{health.service}"</span>,<br />{'  '}<span className="code-key">"timestamp"</span>:<br />{'    '}<span className="code-string">"{health.timestamp}"</span><br />{'}'}</> : healthError ? 'Could not reach the Hono API.\nStart the API with npm run dev.' : 'Connecting to your Hono API…'}</code></pre>
                <div className="health-footer"><span className="terminal-cursor" />{health ? 'Backend connected. You’re good to go.' : healthError ? 'Check that the API server is running.' : 'Checking your connection…'}</div>
              </div>
            </Card>
            <div className="visual-caption"><span>REACT</span><span className="connection-line" /><span className="connection-diamond" /><span className="connection-line" /><span>HONO</span><span className="caption-label">one happy stack</span></div>
          </div>
        </section>

        <div className="section-rule"><span>YOUR WORKBENCH</span><span>01 / START SOMETHING GOOD</span></div>

        <section className="workbench" aria-label="Starter workbench">
          <Card bg="#fffdf5" borderColor={ink} shadowColor="#c6c9b9" textColor={ink} className="playground-card">
            <div className="card-topline"><span className="eyebrow">01 / THE PLAYGROUND</span><span className="live-tag"><span className="status-dot" /> LIVE API</span></div>
            <h2 id="playground">Say hello to your backend<span className="coral">.</span></h2>
            <p className="card-description">A real request. A real response. The whole stack, saying hi.</p>
            <form onSubmit={sayHello}>
              <div className="field-label-row">
                <label htmlFor="name">YOUR NAME</label>
                <span id="name-hint" className="field-hint">Use 1–40 characters.</span>
              </div>
              <div className="form-row">
                <Input id="name" name="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Ada" required maxLength={40} aria-describedby="name-hint" bg="#f4f2e9" textColor={ink} borderColor={ink} className="name-input" />
                <Button type="submit" disabled={pending} bg="#f2a38d" textColor={ink} shadow="#d9c5ad" borderColor={ink} className="button send-button">{pending ? 'Sending…' : 'Send request'} <Arrow /></Button>
              </div>
            </form>
            <div className={`response-box ${requestError ? 'response-error' : ''}`} role="status" aria-live="polite">
              <div className="response-label"><span>{requestError ? 'REQUEST FAILED' : reply ? 'RESPONSE FROM HONO' : 'RESPONSE WILL APPEAR HERE'}</span><span>{elapsed !== null ? `200 OK · ${elapsed} ms` : '↵'}</span></div>
              <p>{pending ? 'Your greeting is on its way…' : requestError || reply?.message || 'A tiny round trip from React to Hono and back.'}</p>
            </div>
          </Card>

          <Card bg="#e5e9dc" borderColor={ink} shadowColor="#c6c9b9" textColor={ink} className="stack-card">
            <div className="card-topline"><span className="eyebrow">02 / UNDER THE HOOD</span><Spark className="small-spark" /></div>
            <h2>Good company.</h2>
            <p className="card-description">Four tools. One clean starting point.</p>
            <ul className="stack-list">
              <li><span className="tech-icon hono-icon">H</span><div><strong>Hono</strong><span>Small, fast API server</span></div><span className="tech-tag">BACKEND</span></li>
              <li><span className="tech-icon react-icon">✳</span><div><strong>React</strong><span>A canvas for your ideas</span></div><span className="tech-tag">FRONTEND</span></li>
              <li><span className="tech-icon retro-icon">▦</span><div><strong>RetroUI</strong><span>Pixels with personality</span></div><span className="tech-tag">COMPONENTS</span></li>
              <li><span className="tech-icon ts-icon">TS</span><div><strong>TypeScript</strong><span>A little more confidence</span></div><span className="tech-tag">END TO END</span></li>
            </ul>
          </Card>
        </section>

        <div className="section-rule"><span>AGENT CHAT</span><span>02 / TALK TO THE ASSISTANT</span></div>

        <section className="chat-section" aria-labelledby="chat-title">
          <Card bg="#e5e9dc" borderColor={ink} shadowColor="#c6c9b9" textColor={ink} className="chat-card">
            <div className="card-topline"><span className="eyebrow">03 / CHAT WITH THE AGENT</span><span className="live-tag"><span className="status-dot" /> OPENROUTER</span></div>
            <h2 id="chat-title">Send a message. Watch the agent work<span className="coral">.</span></h2>
            <p className="card-description">Your messages, the agent&apos;s replies, and every tool call, subagent and hook in between.</p>
            <ChatPanel />
          </Card>
        </section>

        <section className="launch-strip" aria-label="Development command">
          <div className="launch-title"><span className="prompt-symbol">&gt;_</span><div><strong>Make yourself at home.</strong><span>Edit <code>src/client/App.tsx</code> and see what happens.</span></div></div>
          <div className="command"><span aria-hidden="true">$</span><code>npm run dev</code><button onClick={copyCommand} aria-label="Copy npm run dev to clipboard" title="Copy npm run dev"><svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M8 8h12v13H8zM4 16H2V2h13v2" /></svg></button><span className="copy-feedback" role="status">{copyState !== 'Copy command' ? copyState : ''}</span></div>
        </section>
      </main>

      <footer><span>A fresh start, with a familiar feeling.</span><span>ONE PAGE. ENDLESS POSSIBILITIES. <Spark /></span></footer>
    </div>
  )
}
