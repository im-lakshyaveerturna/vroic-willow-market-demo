import configPromise from '@payload-config'
import { headers as getHeaders } from 'next/headers.js'
import { getPayload } from 'payload'

import { toPublicId } from '@/vroic/ids'
import { getSupportThreadByOrder, listSupportMessagesPage } from '@/vroic/state'
import { OrderHistory } from './OrderHistory'
import { OrderMessageForm } from './OrderMessageForm'

/**
 * Server-rendered conversation for an owned order. Reads the SAME persisted
 * thread/messages that the signed Vroic staff `support.get`/`support.reply`
 * operate on, so a staff reply is visible to the customer here. History is
 * paged through the conversation-bound cursor; older pages remain reachable.
 */
export const OrderConversation = async ({ orderId }: { orderId: number }) => {
  const headers = await getHeaders()
  const payload = await getPayload({ config: configPromise })
  const { user } = await payload.auth({ headers })
  if (!user) return null

  const thread = await getSupportThreadByOrder(payload, orderId)
  const page = thread
    ? await listSupportMessagesPage(payload, { threadId: thread.id, cursor: null, limit: 20 })
    : { messages: [], nextCursor: null, hasMore: false }
  const orderIdPublic = toPublicId(orderId)

  return (
    <div>
      <h2 className="font-mono text-primary/50 mb-4 uppercase text-sm">Messages</h2>
      <OrderHistory
        initialCursor={page.nextCursor}
        initialHasMore={page.hasMore}
        initialMessages={page.messages}
        orderIdPublic={orderIdPublic}
      />
      <OrderMessageForm orderIdPublic={orderIdPublic} />
    </div>
  )
}
