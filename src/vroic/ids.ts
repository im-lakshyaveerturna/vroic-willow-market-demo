/**
 * The imported backend uses integer primary keys (Payload + Postgres), while the
 * shared commerce contract addresses records with UUID-shaped identifiers.
 *
 * `toPublicId`/`fromPublicId` provide a stable, reversible mapping between the
 * backend integer primary key (or slug-derived key) and a UUID-shaped public id.
 * The mapping is deterministic, collision-free per collection, and never hides
 * or rewrites the underlying record.
 */
import { fail } from './errors'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const PREFIX = '00000000-0000-4000-8000-'
const MAX = 0xffffffffffff

export function toPublicId(id: number | string): string {
  const n = typeof id === 'number' ? id : Number.parseInt(String(id), 10)
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX) fail('invalid_record_id', 500)
  return PREFIX + n.toString(16).padStart(12, '0')
}

export function fromPublicId(value: unknown): number {
  if (typeof value !== 'string' || !UUID_RE.test(value) || !value.startsWith(PREFIX)) {
    fail('invalid_record_id', 400)
  }
  const n = Number.parseInt(value.slice(PREFIX.length), 16)
  if (!Number.isSafeInteger(n) || n < 0) fail('invalid_record_id', 400)
  return n
}

export const isPublicId = (value: unknown): value is string =>
  typeof value === 'string' && UUID_RE.test(value)
