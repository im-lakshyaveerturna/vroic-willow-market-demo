'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

interface Message {
  id: string
  direction: string
  authorType: string
  body: string
  createdAt: string
}

/**
 * Customer conversation history. Shows the newest page and exposes older pages
 * through the conversation-bound cursor returned by the customer API, so no
 * history is silently truncated.
 */
export const OrderHistory = ({
  orderIdPublic,
  initialMessages,
  initialCursor,
  initialHasMore,
}: {
  orderIdPublic: string
  initialMessages: Message[]
  initialCursor: string | null
  initialHasMore: boolean
}) => {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [cursor, setCursor] = useState<string | null>(initialCursor)
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const loadOlder = async () => {
    if (!cursor) return
    setLoading(true)
    setError(false)
    try {
      const res = await fetch(
        `/api/vroic/customer-support?orderId=${encodeURIComponent(orderIdPublic)}&cursor=${encodeURIComponent(cursor)}`,
      )
      if (!res.ok) {
        setError(true)
        return
      }
      const data = await res.json()
      setMessages((prev) => [...((data.messages as Message[]) ?? []), ...prev])
      setCursor((data.next_cursor as string | null) ?? null)
      setHasMore(Boolean(data.has_more))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      {hasMore && (
        <div className="mb-4 flex items-center gap-3">
          <Button disabled={loading} onClick={loadOlder} type="button" variant="outline">
            {loading ? 'Loading…' : 'Load older messages'}
          </Button>
          {error && <span className="text-sm text-destructive">Could not load older messages.</span>}
        </div>
      )}
      {messages.length === 0 ? (
        <p className="text-sm text-primary/60 mb-4">No messages yet.</p>
      ) : (
        <ul className="flex flex-col gap-3 mb-6">
          {messages.map((message) => (
            <li
              className={message.direction === 'staff' ? 'self-start' : 'self-end text-right'}
              data-direction={message.direction}
              key={message.id}
            >
              <p className="font-mono uppercase text-primary/40 text-xs">
                {message.direction === 'staff' ? 'Store team' : 'You'}
              </p>
              <p className="bg-card border rounded-lg px-3 py-2 inline-block text-left">{message.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
