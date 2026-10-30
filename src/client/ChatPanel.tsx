import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Bubble, Button, TextArea } from 'pixel-retroui'
import { limitChatHistory, type AgentEvent, type ChatMessage } from '../shared/chat'

const ink = '#263f34'

type ActivityKind = 'tool' | 'subagent' | 'hook'

interface Activity {
  id: string
  kind: ActivityKind
  label: string
  status: 'running' | 'done' | 'error'
  detail?: string
}

interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  activities: Activity[]
  pending: boolean
  failed: boolean
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function startActivity(activities: Activity[], kind: ActivityKind, label: string, detail?: string): Activity[] {
  return [...activities, { id: newId(), kind, label, status: 'running', detail }]
}

function finishActivity(
  activities: Activity[],
  kind: ActivityKind,
  label: string,
  status: 'done' | 'error',
  extra: Partial<Activity> = {},
): Activity[] {
  const index = activities.findIndex((activity) => activity.kind === kind && activity.label === label && activity.status === 'running')
  if (index === -1) return [...activities, { id: newId(), kind, label, status, ...extra }]
  return activities.map((activity, i) => (i === index ? { ...activity, status, ...extra } : activity))
}

function applyEvent(message: UiMessage, event: AgentEvent): UiMessage {
  switch (event.type) {
    case 'hook':
      return event.phase === 'start'
        ? { ...message, activities: startActivity(message.activities, 'hook', `hook: ${event.name}`, event.detail) }
        : { ...message, activities: finishActivity(message.activities, 'hook', `hook: ${event.name}`, 'done') }
    case 'subagent':
      return event.phase === 'start'
        ? { ...message, activities: startActivity(message.activities, 'subagent', `subagent: ${event.name}`, event.detail) }
        : { ...message, activities: finishActivity(message.activities, 'subagent', `subagent: ${event.name}`, 'done') }
    case 'tool_call': {
      const label = `tool: ${event.name}`
      if (event.phase === 'start') {
        return { ...message, activities: startActivity(message.activities, 'tool', label, event.args) }
      }
      return {
        ...message,
        activities: finishActivity(message.activities, 'tool', label, event.ok === false ? 'error' : 'done', { detail: event.result }),
      }
    }
    case 'assistant_message':
      return { ...message, content: event.text, pending: false }
    case 'error':
      return { ...message, failed: true, pending: false, content: message.content || event.message }
    case 'done':
      return { ...message, pending: false }
    default:
      return message
  }
}

function parseSseChunk(chunk: string): AgentEvent[] {
  const events: AgentEvent[] = []
  for (const block of chunk.split('\n\n')) {
    const line = block.split('\n').find((entry) => entry.startsWith('data:'))
    if (!line) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    try {
      events.push(JSON.parse(payload) as AgentEvent)
    } catch {
      // Ignore malformed keep-alive or partial frames.
    }
  }
  return events
}

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: string }
    if (data.error) return data.error
  } catch {
    // Fall through to a generic message.
  }
  return `The chat request failed with status ${response.status}.`
}

export function ChatPanel() {
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    const node = scrollRef.current
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight
  }, [messages])

  function onScroll() {
    const node = scrollRef.current
    if (!node) return
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
  }

  async function sendMessage() {
    const text = draft.trim()
    if (!text || busy) return

    const userMessage: UiMessage = { id: newId(), role: 'user', content: text, activities: [], pending: false, failed: false }
    const assistantId = newId()
    const assistantMessage: UiMessage = { id: assistantId, role: 'assistant', content: '', activities: [], pending: true, failed: false }
    // The server rejects more than `CHAT_LIMITS.maxMessages` messages, so keep
    // only the most recent turns; otherwise a long chat is stranded after ~26 turns.
    const history = limitChatHistory(
      [...messages.filter((message) => message.content.trim().length > 0), userMessage]
        .map((message): ChatMessage => ({ id: message.id, role: message.role, content: message.content, createdAt: new Date().toISOString() })),
    )

    stickToBottom.current = true
    setMessages((current) => [...current, userMessage, assistantMessage])
    setDraft('')
    setError('')
    setBusy(true)

    const updateAssistant = (transform: (message: UiMessage) => UiMessage) => {
      setMessages((current) => current.map((message) => (message.id === assistantId ? transform(message) : message)))
    }

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      })
      if (!response.ok) throw new Error(await readError(response))
      if (!response.body) throw new Error('The chat response had no body.')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const separator = buffer.lastIndexOf('\n\n')
        if (separator === -1) continue
        const complete = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        for (const event of parseSseChunk(complete)) updateAssistant((message) => applyEvent(message, event))
      }
      if (buffer.trim()) {
        for (const event of parseSseChunk(buffer)) updateAssistant((message) => applyEvent(message, event))
      }
      updateAssistant((message) => (message.pending ? { ...message, pending: false } : message))
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : 'Could not reach the agent.'
      setError(detail)
      updateAssistant((message) => ({ ...message, pending: false, failed: true, content: message.content || detail }))
    } finally {
      setBusy(false)
    }
  }

  function clearConversation() {
    if (busy) return
    setMessages([])
    setDraft('')
    setError('')
    stickToBottom.current = true
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-toolbar">
        <span className="chat-toolbar-title"><span className="status-dot" /> AGENT CHAT</span>
        <span className="chat-toolbar-actions">
          <span className="chat-toolbar-hint">Enter to send · Shift+Enter for a new line</span>
          <Button
            type="button"
            onClick={clearConversation}
            disabled={busy || messages.length === 0}
            bg="#f4f2e9"
            textColor={ink}
            shadow="#d9c5ad"
            borderColor={ink}
            className="button chat-clear"
          >
            Clear
          </Button>
        </span>
      </div>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-live="polite" aria-label="Chat history">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Start a conversation with the agent.</p>
            <p className="chat-empty-hint">Tool calls, subagents and hooks appear in the history as they run.</p>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`chat-message chat-message-${message.role}`}>
            <Bubble
              direction={message.role === 'user' ? 'right' : 'left'}
              bg={message.role === 'user' ? '#f2a38d' : '#fffdf5'}
              borderColor={ink}
              textColor={ink}
              className="chat-bubble"
            >
              <span className="chat-role">{message.role === 'user' ? 'You' : 'Agent'}</span>
              {message.activities.length > 0 && (
                <ul className="chat-activities" aria-label={`${message.role === 'user' ? 'You' : 'Agent'} activity`}>
                  {message.activities.map((activity) => (
                    <li key={activity.id} className={`chat-activity chat-activity-${activity.kind} is-${activity.status}`}>
                      <span className="chat-activity-icon" aria-hidden="true">
                        {activity.kind === 'tool' ? '⚙' : activity.kind === 'subagent' ? '⛓' : '⚑'}
                      </span>
                      <span className="chat-activity-label">{activity.label}</span>
                      <span className="chat-activity-status">
                        {activity.status === 'running' ? 'running…' : activity.status === 'error' ? 'failed' : 'done'}
                      </span>
                      {activity.detail && <span className="chat-activity-detail">{activity.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {message.content && <span className="chat-text">{message.content}</span>}
              {message.pending && !message.content && <span className="chat-typing">Agent is thinking…</span>}
            </Bubble>
          </div>
        ))}
      </div>

      {error && (
        <div className="chat-error" role="alert">
          <strong>Agent unavailable.</strong> {error}
        </div>
      )}

      <div className="chat-composer">
        <TextArea
          aria-label="Message the agent"
          placeholder="Ask the agent anything…"
          value={draft}
          rows={3}
          maxLength={4000}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          bg="#f4f2e9"
          textColor={ink}
          borderColor={ink}
          className="chat-input"
        />
        <Button
          type="button"
          onClick={() => void sendMessage()}
          disabled={busy || !draft.trim()}
          bg="#a8c7a0"
          textColor={ink}
          shadow="#d9c5ad"
          borderColor={ink}
          className="button chat-send"
        >
          {busy ? 'Working…' : 'Send'}
        </Button>
      </div>
    </div>
  )
}
