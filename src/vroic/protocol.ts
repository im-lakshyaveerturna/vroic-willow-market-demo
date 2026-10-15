/**
 * Signature and envelope verification for the shared generated-app operation
 * protocol (version 1) and the owner-access grant protocol.
 *
 * Signing material never leaves the server: VROIC_APP_OPERATION_SECRET is read
 * from the server environment and is never returned to a browser.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { fail } from './errors'

export const OPERATIONS_PATH = '/api/vroic/operations'
export const OWNER_ACCESS_PATH = '/api/vroic/owner-access'
export const OPERATION_PROTOCOL = 'generated-app-operation-v1'
export const OWNER_ACCESS_CONTEXT = 'generated-app-owner-access-v1'
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
export const MAX_OWNER_GRANT_LIFETIME_MS = 60 * 1000
export const MAX_OWNER_BODY_BYTES = 8192

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function operationSecret(): string | undefined {
  const value = process.env.VROIC_APP_OPERATION_SECRET
  return value && value.length >= 16 ? value : undefined
}

export function configuredApplicationId(): string | undefined {
  return process.env.VROIC_APP_ID || undefined
}

export interface OperationHeaders {
  protocol: string | null
  applicationId: string | null
  actorId: string | null
  actorRole: string | null
  timestamp: string | null
  idempotencyKey: string | null
  signature: string | null
}

export function operationCanonicalString(input: {
  applicationId: string
  actorId: string
  timestamp: string
  idempotencyKey: string
  bodySha256: string
}): string {
  return [
    'POST',
    OPERATIONS_PATH,
    input.applicationId,
    input.actorId,
    input.timestamp,
    input.idempotencyKey,
    input.bodySha256,
  ].join('\n')
}

export function expectedOperationSignature(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('base64url')
}

export interface VerifiedOperation {
  actorId: string
  timestamp: number
  idempotencyKey: string
}

/**
 * Verifies protocol header, application identity, freshness and HMAC signature
 * over the exact raw body bytes. Throws OperationError on any failure.
 */
export function verifyOperationRequest(input: {
  secret: string | undefined
  applicationId: string | undefined
  headers: OperationHeaders
  rawBody: string
  now?: number
}): VerifiedOperation {
  const { headers } = input
  if (headers.protocol !== OPERATION_PROTOCOL) fail('invalid_protocol', 415)
  if (!input.secret) fail('operation_secret_unconfigured', 503)
  if (!input.applicationId) fail('application_id_unconfigured', 503)
  if (!headers.applicationId || headers.applicationId !== input.applicationId) {
    fail('application_mismatch', 403)
  }
  if (!headers.actorId) fail('actor_required', 401)
  if (!headers.timestamp || !/^\d+$/.test(headers.timestamp)) fail('timestamp_required', 401)
  const now = input.now ?? Date.now()
  const ts = Number(headers.timestamp)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) fail('stale_request', 401)
  if (!headers.idempotencyKey) fail('idempotency_key_required', 400)
  if (!headers.signature) fail('signature_required', 401)

  const canonical = operationCanonicalString({
    applicationId: headers.applicationId,
    actorId: headers.actorId,
    timestamp: headers.timestamp,
    idempotencyKey: headers.idempotencyKey,
    bodySha256: sha256Hex(input.rawBody),
  })
  const expected = expectedOperationSignature(input.secret, canonical)
  if (!constantTimeEqual(expected, headers.signature)) fail('signature_invalid', 401)

  return { actorId: headers.actorId, timestamp: ts, idempotencyKey: headers.idempotencyKey }
}

export interface OperationEnvelope {
  version: string
  operation: string
  arguments: Record<string, unknown>
  idempotencyKey: string
}

export function parseOperationEnvelope(rawBody: string, headerIdempotencyKey: string): OperationEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    fail('invalid_json', 400)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid_envelope', 400)
  const env = parsed as Record<string, unknown>
  if (env.version !== '1') fail('invalid_version', 400)
  if (typeof env.operation !== 'string' || env.operation.length === 0) fail('invalid_operation', 400)
  if (!env.arguments || typeof env.arguments !== 'object' || Array.isArray(env.arguments)) {
    fail('invalid_arguments', 400)
  }
  if (typeof env.idempotencyKey !== 'string' || env.idempotencyKey.length === 0) {
    fail('invalid_idempotency_key', 400)
  }
  if (env.idempotencyKey !== headerIdempotencyKey) fail('idempotency_key_mismatch', 400)
  return {
    version: '1',
    operation: env.operation,
    arguments: env.arguments as Record<string, unknown>,
    idempotencyKey: env.idempotencyKey,
  }
}

export interface OwnerGrant {
  version: string
  applicationId: string
  principalId: string
  nonce: string
  issuedAt: number
  expiresAt: number
  audience: string
  issuerOrigin: string
}

export function verifyOwnerAccessSignature(
  secret: string | undefined,
  payload: string,
  signature: string | null,
): void {
  if (!secret) fail('operation_secret_unconfigured', 503)
  if (!signature) fail('owner_signature_required', 401)
  const expected = createHmac('sha256', secret)
    .update(`${OWNER_ACCESS_CONTEXT}\n${payload}`)
    .digest('base64url')
  if (!constantTimeEqual(expected, signature)) fail('owner_signature_invalid', 401)
}

export function parseOwnerGrant(payload: string, applicationId: string | undefined): OwnerGrant {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    fail('owner_payload_invalid_json', 400)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('owner_payload_invalid', 400)
  const g = parsed as Record<string, unknown>
  const keys = Object.keys(g).sort()
  const expectedKeys = ['applicationId', 'audience', 'expiresAt', 'issuedAt', 'issuerOrigin', 'nonce', 'principalId', 'version']
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) fail('owner_payload_shape_invalid', 400)
  if (g.version !== '1') fail('owner_version_invalid', 400)
  if (!applicationId || g.applicationId !== applicationId) fail('owner_application_mismatch', 403)
  if (typeof g.principalId !== 'string' || g.principalId.length === 0) fail('owner_principal_invalid', 400)
  if (typeof g.nonce !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(g.nonce)) fail('owner_nonce_invalid', 400)
  if (typeof g.audience !== 'string' || !g.audience.startsWith('https://')) fail('owner_audience_invalid', 400)
  if (typeof g.issuerOrigin !== 'string' || !g.issuerOrigin.startsWith('https://')) fail('owner_origin_invalid', 400)
  const issuedAt = Number(g.issuedAt)
  const expiresAt = Number(g.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) fail('owner_time_invalid', 400)
  const now = Date.now()
  if (!(issuedAt <= now && now < expiresAt)) fail('owner_grant_expired', 401)
  if (expiresAt - issuedAt > MAX_OWNER_GRANT_LIFETIME_MS || expiresAt <= issuedAt) {
    fail('owner_grant_lifetime_invalid', 400)
  }
  return {
    version: '1',
    applicationId: g.applicationId as string,
    principalId: g.principalId as string,
    nonce: g.nonce as string,
    issuedAt,
    expiresAt,
    audience: g.audience as string,
    issuerOrigin: g.issuerOrigin as string,
  }
}
