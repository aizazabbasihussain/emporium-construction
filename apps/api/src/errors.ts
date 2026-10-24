import { isDomainError, type ErrorKind } from '@emporium/domain';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export const statusByKind: Record<ErrorKind, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rule_violation: 422,
};

export interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

function send(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): FastifyReply {
  const body: ErrorBody = {
    error: {
      code,
      message,
      requestId: reply.request.id,
      ...(details === undefined ? {} : { details }),
    },
  };
  return reply.status(status).send(body);
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply) =>
    send(reply, 404, 'not_found', `Route ${request.method} ${request.url} not found`),
  );

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (isDomainError(error)) {
      return send(reply, statusByKind[error.kind], error.code, error.message, error.details);
    }
    if (error instanceof ZodError) {
      return send(reply, 400, 'validation_failed', 'Request validation failed', error.issues);
    }
    const status = 'statusCode' in error ? error.statusCode : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      return send(reply, status, 'request_error', error.message);
    }
    request.log.error({ err: error }, 'unhandled error');
    return send(reply, 500, 'internal_error', 'Internal server error');
  });
}
