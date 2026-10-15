/**
 * Structured errors for the Vroic generated-app operations protocol.
 * These are translated into non-2xx JSON responses by the endpoint.
 */
export class OperationError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status = 400, message?: string) {
    super(message || code)
    this.name = 'OperationError'
    this.code = code
    this.status = status
  }
}

export function fail(code: string, status = 400, message?: string): never {
  throw new OperationError(code, status, message)
}
