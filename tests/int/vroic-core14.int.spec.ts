import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fromPublicId, toPublicId } from '@/vroic/ids'
import { actionEffect, handlerFor, IMPLEMENTED_OPERATIONS, operationMeta } from '@/vroic/operations'
import { parseOwnerGrant, verifyOwnerAccessSignature } from '@/vroic/protocol'

describe('owned UUID mapping for integer Payload ids', () => {
  it('round-trips integer ids through a UUID-shaped public id', () => {
    for (const id of [1, 2, 42, 999999, 1000000]) {
      const publicId = toPublicId(id)
      expect(publicId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
      expect(fromPublicId(publicId)).toBe(id)
    }
  })

  it('rejects non-owned and malformed identifiers', () => {
    expect(() => fromPublicId('not-a-uuid')).toThrowError(/invalid_record_id/)
    expect(() => fromPublicId('11111111-1111-1111-1111-111111111111')).toThrowError(/invalid_record_id/)
  })
})

describe('Core-14 operation registry', () => {
  const required: Record<string, string[]> = {
    store_operations: ['candidates', 'contact_context', 'supplier_contact', 'correlate_supplier_whatsapp', 'production_candidates', 'production_complete'],
    contact_cases: ['record_reply', 'resolve'],
    purchases: ['get', 'order', 'receive', 'reorder_policy_get', 'reorder_candidates', 'reorder_saved'],
    returns: ['get', 'receive_confirmed'],
    orders: ['get'],
    workflow_cases: ['open', 'get', 'list', 'update'],
    staff_access: ['current', 'list'],
    support: ['get', 'reply'],
    shipping_dispatch: ['provider_selection', 'configuration'],
  }

  it('advertises every required action and resolves a real handler', () => {
    for (const [operation, actions] of Object.entries(required)) {
      const meta = operationMeta(operation)
      expect(meta, `missing operation ${operation}`).toBeTruthy()
      for (const action of actions) {
        expect(meta!.actions.some((entry) => entry.action === action), `missing ${operation}.${action}`).toBe(true)
        expect(typeof handlerFor(operation, action), `no handler ${operation}.${action}`).toBe('function')
      }
    }
  })

  it('classifies read and write actions under the canonical contract', () => {
    expect(actionEffect('workflow_cases', 'update')).toBe('write')
    expect(actionEffect('workflow_cases', 'get')).toBe('read')
    expect(actionEffect('staff_access', 'current')).toBe('read')
    expect(actionEffect('purchases', 'receive')).toBe('write')
    expect(actionEffect('store_operations', 'production_complete')).toBe('write')
    expect(actionEffect('store_operations', 'production_candidates')).toBe('read')
    expect(actionEffect('shipping_dispatch', 'configuration')).toBe('read')
  })

  it('rejects unsupported operations and actions', () => {
    expect(() => actionEffect('does_not_exist', 'list')).toThrowError(/Unsupported action/)
    expect(() => actionEffect('products', 'does_not_exist')).toThrowError(/Unsupported action/)
    expect(() => handlerFor('products', 'does_not_exist')).toThrowError(/Unsupported action/)
  })

  it('advertises only implemented operations', () => {
    const names = IMPLEMENTED_OPERATIONS.map((op) => op.name)
    expect(new Set(names).size).toBe(names.length)
    for (const operation of Object.keys(required)) expect(names).toContain(operation)
  })
})

describe('owner-access grant', () => {
  const applicationId = 'app_test_owner'
  const validGrant = {
    version: '1',
    applicationId,
    principalId: 'principal-1',
    nonce: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    issuedAt: Date.now() - 5,
    expiresAt: Date.now() + 30000,
    audience: 'https://vroic-willow-market-demo.vercel.app',
    issuerOrigin: 'https://vroic-willow-market-demo.vercel.app',
  }

  it('accepts a well-formed, live grant', () => {
    const grant = parseOwnerGrant(JSON.stringify(validGrant), applicationId)
    expect(grant.principalId).toBe('principal-1')
  })

  it('rejects an expired grant', () => {
    const expired = { ...validGrant, issuedAt: Date.now() - 120000, expiresAt: Date.now() - 60000 }
    expect(() => parseOwnerGrant(JSON.stringify(expired), applicationId)).toThrowError(/owner_grant_expired/)
  })

  it('rejects a grant for another application', () => {
    expect(() => parseOwnerGrant(JSON.stringify(validGrant), 'app_other')).toThrowError(/owner_application_mismatch/)
  })

  it('verifies the owner signature and rejects a bad one', () => {
    const secret = 'test-owner-secret-000000000000'
    const payload = JSON.stringify(validGrant)
    const good = createHmac('sha256', secret).update(`generated-app-owner-access-v1\n${payload}`).digest('base64url')
    expect(() => verifyOwnerAccessSignature(secret, payload, good)).not.toThrow()
    expect(() => verifyOwnerAccessSignature(secret, payload, 'bad')).toThrowError(/owner_signature_invalid/)
  })
})
