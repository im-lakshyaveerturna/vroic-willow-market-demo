'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Customer message form for an owned order conversation. Posts to the
 * Payload-authenticated `/api/vroic/customer-support` endpoint using the
 * existing session cookie; no separate auth is introduced.
 *
 * The idempotency key is stable for the CURRENT submitted intent: it is reused
 * across retries after a lost/failed (e.g. 503) response so the store keeps one
 * message, and it rotates only on confirmed completion or when the message text
 * genuinely changes.
 */
export const OrderMessageForm = ({ orderIdPublic }: { orderIdPublic: string }) => {
  const [body, setBody] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const eventKeyRef = useRef<string>(globalThis.crypto.randomUUID())
  const lastSubmittedRef = useRef<string | null>(null)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = body.trim()
    if (!text) return
    if (lastSubmittedRef.current !== null && lastSubmittedRef.current !== text) {
      eventKeyRef.current = globalThis.crypto.randomUUID()
    }
    lastSubmittedRef.current = text
    setStatus('sending')
    try {
      const res = await fetch('/api/vroic/customer-support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: orderIdPublic, body: text, eventKey: eventKeyRef.current }),
      })
      if (res.ok) {
        eventKeyRef.current = globalThis.crypto.randomUUID()
        lastSubmittedRef.current = null
        setBody('')
        setStatus('sent')
        try {
          window.location.reload()
        } catch {
          /* non-navigable test environment */
        }
      } else {
        setStatus('error')
      }
    } catch {
      setStatus('error')
    }
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <label className="font-mono uppercase text-primary/50 text-sm" htmlFor="order-message">
        Send a message about this order
      </label>
      <textarea
        className="border rounded-md p-2 min-h-24"
        id="order-message"
        onChange={(event) => setBody(event.target.value)}
        placeholder="Write your message to the store team"
        value={body}
      />
      <div className="flex items-center gap-3">
        <Button disabled={status === 'sending' || !body.trim()} type="submit" variant="default">
          Send
        </Button>
        {status === 'error' && <span className="text-sm text-destructive">Could not send. Please try again.</span>}
      </div>
    </form>
  )
}
