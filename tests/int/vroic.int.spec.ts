import { describe, expect, it } from 'vitest'
import {
  OPERATIONS_PATH,
  OPERATION_PROTOCOL,
  expectedOperationSignature,
  operationCanonicalString,
  parseOperationEnvelope,
  sha256Hex,
  verifyOperationRequest,
} from '@/vroic/protocol'

const secret = 'test-secret-value-000000000000'
const applicationId = 'app_test_123'

function buildHeaders(body: string, overrides: Partial<Record<string, string>> = {}) {
  const timestamp = String(Date.now())
  const idempotencyKey = overrides['x-vroic-idempotency-key'] ?? 'idem-1'
  const actorId = overrides['x-vroic-actor-id'] ?? 'principal-1'
  const appId = overrides['x-vroic-application-id'] ?? applicationId
  const canonical = operationCanonicalString({
    applicationId: appId,
    actorId,
    timestamp,
    idempotencyKey,
    bodySha256: sha256Hex(body),
  })
  const signature = overrides['x-vroic-signature'] ?? expectedOperationSignature(secret, canonical)
  return {
    protocol: overrides['x-vroic-protocol'] ?? OPERATION_PROTOCOL,
    applicationId: appId,
    actorId,
    actorRole: overrides['x-vroic-actor-role'] ?? null,
    timestamp: overrides['x-vroic-timestamp'] ?? timestamp,
    idempotencyKey,
    signature,
  }
}

describe('verifyOperationRequest', () => {
  const body = JSON.stringify({ version: '1', operation: 'products', arguments: { action: 'list' }, idempotencyKey: 'idem-1' })

  it('accepts a correctly signed request', () => {
    const result = verifyOperationRequest({ secret, applicationId, rawBody: body, headers: buildHeaders(body) })
    expect(result.actorId).toBe('principal-1')
    expect(result.idempotencyKey).toBe('idem-1')
  })

  it('rejects a wrong application id', () => {
    expect(() =>
      verifyOperationRequest({
        secret,
        applicationId,
        rawBody: body,
        headers: buildHeaders(body, { 'x-vroic-application-id': 'app_other' }),
      }),
    ).toThrowError(/application_mismatch/)
  })

  it('rejects a tampered body', () => {
    expect(() =>
      verifyOperationRequest({ secret, applicationId, rawBody: body + ' ', headers: buildHeaders(body) }),
    ).toThrowError(/signature_invalid/)
  })

  it('rejects a wrong protocol header', () => {
    expect(() =>
      verifyOperationRequest({
        secret,
        applicationId,
        rawBody: body,
        headers: buildHeaders(body, { 'x-vroic-protocol': 'nope' }),
      }),
    ).toThrowError(/invalid_protocol/)
  })

  it('rejects a stale timestamp', () => {
    const stale = String(Date.now() - 10 * 60 * 1000)
    expect(() =>
      verifyOperationRequest({
        secret,
        applicationId,
        rawBody: body,
        headers: buildHeaders(body, { 'x-vroic-timestamp': stale }),
      }),
    ).toThrowError(/stale_request/)
  })

  it('rejects a missing secret', () => {
    expect(() =>
      verifyOperationRequest({ secret: undefined, applicationId, rawBody: body, headers: buildHeaders(body) }),
    ).toThrowError(/operation_secret_unconfigured/)
  })

  it('canonical string covers the protocol path', () => {
    expect(operationCanonicalString({ applicationId, actorId: 'a', timestamp: '1', idempotencyKey: 'k', bodySha256: 'h' })).toContain(
      `\n${OPERATIONS_PATH}\n`,
    )
  })
})

describe('parseOperationEnvelope', () => {
  it('accepts a well formed envelope', () => {
    const env = parseOperationEnvelope(JSON.stringify({ version: '1', operation: 'orders', arguments: { action: 'list' }, idempotencyKey: 'k1' }), 'k1')
    expect(env.operation).toBe('orders')
  })

  it('rejects a header/body idempotency mismatch', () => {
    expect(() =>
      parseOperationEnvelope(JSON.stringify({ version: '1', operation: 'orders', arguments: { action: 'list' }, idempotencyKey: 'k2' }), 'k1'),
    ).toThrowError(/idempotency_key_mismatch/)
  })

  it('rejects a wrong version', () => {
    expect(() =>
      parseOperationEnvelope(JSON.stringify({ version: '2', operation: 'orders', arguments: { action: 'list' }, idempotencyKey: 'k1' }), 'k1'),
    ).toThrowError(/invalid_version/)
  })
})
