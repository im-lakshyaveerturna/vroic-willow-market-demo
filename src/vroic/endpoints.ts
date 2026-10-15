/**
 * Payload endpoints implementing the shared generated-app operation protocol.
 * Mounted under the application's existing REST base (/api).
 */
import type { Endpoint, PayloadRequest } from 'payload'
import { OperationError, fail } from './errors'
import {
  IMPLEMENTED_OPERATIONS,
  actionEffect,
  handlerFor,
  operationMeta,
} from './operations'
import {
  configuredApplicationId,
  operationSecret,
  parseOperationEnvelope,
  sha256Hex,
  verifyOperationRequest,
} from './protocol'
import { abandonWriteReceipt, claimWriteReceipt, completeWriteReceipt, getPrincipalLink } from './store'
import { handleOwnerAccess } from './ownerAccess'

function errorResponse(error: unknown): Response {
  if (error instanceof OperationError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  }
  console.error('[vroic-operations]', error)
  return Response.json(
    { error: { code: 'internal_error', message: 'Unexpected error' } },
    { status: 500 },
  )
}

function readHeader(req: PayloadRequest, name: string): string | null {
  return req.headers.get(name)
}

export const vroicDiscoveryEndpoint: Endpoint = {
  path: '/vroic/operations',
  method: 'get',
  handler: async () =>
    Response.json({
      applicationId: configuredApplicationId() ?? null,
      operations: IMPLEMENTED_OPERATIONS,
    }),
}

export const vroicOperationsEndpoint: Endpoint = {
  path: '/vroic/operations',
  method: 'post',
  handler: async (req) => {
    try {
      if (!req.text) fail('body_required', 400)
      const rawBody = await req.text()
      const verified = verifyOperationRequest({
        secret: operationSecret(),
        applicationId: configuredApplicationId(),
        rawBody,
        headers: {
          protocol: readHeader(req, 'x-vroic-protocol'),
          applicationId: readHeader(req, 'x-vroic-application-id'),
          actorId: readHeader(req, 'x-vroic-actor-id'),
          actorRole: readHeader(req, 'x-vroic-actor-role'),
          timestamp: readHeader(req, 'x-vroic-timestamp'),
          idempotencyKey: readHeader(req, 'x-vroic-idempotency-key'),
          signature: readHeader(req, 'x-vroic-signature'),
        },
      })

      const envelope = parseOperationEnvelope(rawBody, verified.idempotencyKey)
      const meta = operationMeta(envelope.operation)
      if (!meta) fail('unsupported_operation', 404, `Unsupported operation ${envelope.operation}`)

      const action = typeof envelope.arguments.action === 'string' ? envelope.arguments.action : undefined
      if (!action) fail('invalid_arguments', 400, 'action is required')
      const effect = actionEffect(envelope.operation, action)

      const link = await getPrincipalLink(req.payload, verified.actorId)
      if (!link) fail('actor_not_linked', 403)
      if (!meta.roles.includes(link.role)) fail('actor_forbidden', 403)

      const handler = handlerFor(envelope.operation, action)
      const ctx = {
        payload: req.payload,
        req,
        actor: { principalId: verified.actorId, role: link.role, userId: link.userId },
        args: envelope.arguments,
      }

      if (effect === 'write') {
        const claim = await claimWriteReceipt(req.payload, {
          operation: envelope.operation,
          action,
          actorId: verified.actorId,
          idempotencyKey: envelope.idempotencyKey,
          requestSha256: sha256Hex(rawBody),
        })
        if (claim.kind === 'cached') return Response.json(claim.result)
        try {
          const result = await handler(ctx)
          const body = { result }
          await completeWriteReceipt(req.payload, {
            operation: envelope.operation,
            idempotencyKey: envelope.idempotencyKey,
            result: body,
          })
          return Response.json(body)
        } catch (error) {
          await abandonWriteReceipt(req.payload, {
            operation: envelope.operation,
            idempotencyKey: envelope.idempotencyKey,
          })
          throw error
        }
      }

      const result = await handler(ctx)
      return Response.json({ result })
    } catch (error) {
      return errorResponse(error)
    }
  },
}

export const vroicOwnerAccessEndpoint: Endpoint = {
  path: '/vroic/owner-access',
  method: 'post',
  handler: handleOwnerAccess,
}

export const vroicEndpoints: Endpoint[] = [
  vroicDiscoveryEndpoint,
  vroicOperationsEndpoint,
  vroicOwnerAccessEndpoint,
]
