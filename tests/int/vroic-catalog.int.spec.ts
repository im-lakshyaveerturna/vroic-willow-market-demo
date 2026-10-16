import { describe, expect, it } from 'vitest'
import contractJson from '@/vroic/storefront-commerce-contract.json'
import { CONTRACT_OPERATIONS, handlerFor, IMPLEMENTED_OPERATIONS, unavailableReason } from '@/vroic/operations'

const RETAINED_CONTRACT_SHA = '10bc4a5f64af79fcff4fcc6cbf21455b8708618e980c2af39daeb6d3c705cf84'

describe('full retained contract catalog with source-owned availability', () => {
  it('exposes the complete retained contract (51 resources / 449 actions) under the unchanged pin', () => {
    expect(CONTRACT_OPERATIONS.length).toBe(51)
    let actions = 0
    for (const op of CONTRACT_OPERATIONS) actions += Object.keys((op as { actionEffects?: Record<string, string> }).actionEffects || {}).length
    expect(actions).toBe(449)
    expect((contractJson as { contractSha256?: string }).contractSha256).toBe(RETAINED_CONTRACT_SHA)
  })

  it('declares exactly the absent actions unavailable and the handled actions available', () => {
    let declaredUnavailable = 0
    let available = 0
    for (const op of CONTRACT_OPERATIONS) {
      const shape = op as { name: string; actionEffects?: Record<string, string>; actionAvailability?: Record<string, unknown> }
      const effects = shape.actionEffects || {}
      const availability = shape.actionAvailability || {}
      for (const action of Object.keys(effects)) {
        const reason = unavailableReason(shape.name, action)
        if (reason) {
          declaredUnavailable++
          expect(reason).toBe('provider_operation_unavailable')
          expect(availability[action]).toEqual({ available: false, reason: 'provider_operation_unavailable' })
        } else {
          available++
          expect(availability[action]).toBeUndefined()
          expect(typeof handlerFor(shape.name, action)).toBe('function')
        }
      }
    }
    expect(available).toBe(57)
    expect(declaredUnavailable).toBe(392)
    expect(available + declaredUnavailable).toBe(449)
  })

  it('keeps IMPLEMENTED_OPERATIONS as the honest available subset', () => {
    const names = IMPLEMENTED_OPERATIONS.map((op) => op.name)
    expect(names.length).toBe(18)
    expect(new Set(names).size).toBe(18)
  })

  it('denies an absent action before any backend work', () => {
    let absent: { name: string; action: string; reason?: string } | null = null
    for (const op of CONTRACT_OPERATIONS) {
      const shape = op as { name: string; actionEffects?: Record<string, string> }
      for (const action of Object.keys(shape.actionEffects || {})) {
        const reason = unavailableReason(shape.name, action)
        if (reason) { absent = { name: shape.name, action, reason }; break }
      }
      if (absent) break
    }
    expect(absent).not.toBeNull()
    expect(absent?.reason).toBe('provider_operation_unavailable')
  })
})
