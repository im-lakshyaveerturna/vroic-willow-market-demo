/**
 * Owner-access grant: links a signed Vroic owner principal to an existing
 * authorized backend owner account, then redirects to a fixed owner page.
 *
 * The grant is a one-time, short-lived, signed payload. The nonce is consumed
 * atomically in the application's own Postgres database. Existing authentication
 * is preserved: a customer is never promoted and ownership is never inferred
 * from email or signup order.
 */
import jwt from 'jsonwebtoken'
import type { Payload, PayloadRequest } from 'payload'
import { fail } from './errors'
import {
  MAX_OWNER_BODY_BYTES,
  configuredApplicationId,
  operationSecret,
  parseOwnerGrant,
  verifyOwnerAccessSignature,
} from './protocol'
import { consumeOwnerNonce, linkPrincipal } from './store'

const OWNER_PAGE = '/admin'
const COOKIE_NAME = 'payload-token'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function errorResponse(error: unknown): Response {
  const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'internal_error'
  const status = error instanceof Error && 'status' in error ? Number((error as { status: unknown }).status) : 500
  return Response.json({ error: code }, { status })
}

async function findOwnerAccount(payload: Payload) {
  const configuredEmail = process.env.VROIC_OWNER_EMAIL
  if (configuredEmail) {
    const found = await payload.find({
      collection: 'users',
      where: { and: [{ email: { equals: configuredEmail } }, { roles: { contains: 'admin' } }] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    if (found.docs[0]) return found.docs[0] as { id: number; email: string }
  }
  const admins = await payload.find({
    collection: 'users',
    where: { roles: { contains: 'admin' } },
    sort: 'createdAt',
    limit: 2,
    depth: 0,
    overrideAccess: true,
  })
  if (admins.docs.length === 0) fail('owner_account_unavailable', 409, 'No authorized backend owner account exists')
  if (admins.docs.length > 1 && !configuredEmail) {
    fail('owner_account_ambiguous', 409, 'Multiple admin accounts; VROIC_OWNER_EMAIL is required')
  }
  return admins.docs[0] as { id: number; email: string }
}

export async function handleOwnerAccess(req: PayloadRequest): Promise<Response> {
  try {
    if (!req.text) fail('owner_body_required', 400)
    const raw = await req.text()
    if (new TextEncoder().encode(raw).length > MAX_OWNER_BODY_BYTES) {
      return Response.json({ error: 'owner_body_too_large' }, { status: 413 })
    }
    const params = new URLSearchParams(raw)
    const payloadParam = params.get('payload')
    const signature = params.get('signature')
    if (!payloadParam) fail('owner_payload_required', 400)
    verifyOwnerAccessSignature(operationSecret(), payloadParam, signature)
    const grant = parseOwnerGrant(payloadParam, configuredApplicationId())

    const requestOrigin = new URL(req.url ?? `https://${req.headers.get('host') ?? 'invalid.invalid'}`).origin
    if (!requestOrigin.startsWith('https://')) fail('owner_https_required', 400)
    if (grant.audience !== requestOrigin) fail('owner_audience_mismatch', 403)
    const originHeader = req.headers.get('origin')
    if (!originHeader || originHeader !== grant.issuerOrigin) fail('owner_origin_mismatch', 403)

    const consumed = await consumeOwnerNonce(req.payload, {
      nonce: grant.nonce,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    })
    if (!consumed) fail('owner_nonce_replayed', 409)

    const owner = await findOwnerAccount(req.payload)
    await linkPrincipal(req.payload, { principalId: grant.principalId, userId: owner.id, role: 'OWNER' })

    const secret = process.env.PAYLOAD_SECRET
    if (!secret) fail('payload_secret_unconfigured', 503)
    const token = jwt.sign({ id: owner.id, collection: 'users', email: owner.email }, secret, {
      expiresIn: '7d',
    })
    const cookie = [
      `${COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Max-Age=604800',
    ].join('; ')

    return new Response(null, {
      status: 303,
      headers: {
        Location: OWNER_PAGE,
        'Set-Cookie': cookie,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Referrer-Policy': 'no-referrer',
      },
    })
  } catch (error) {
    void escapeHtml
    return errorResponse(error)
  }
}
