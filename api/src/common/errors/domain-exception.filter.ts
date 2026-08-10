import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { DomainError } from './domain.errors';

/**
 * Maps domain errors to HTTP without leaking internals.
 *
 * A refusal names the requirement it enforces (`rule`), so an operator or auditor
 * can trace "why did this fail" straight to a numbered clause. Unexpected errors
 * are logged in full and answered with a correlation id only — a stack trace in a
 * response body is how database structure and file paths escape.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof DomainError) {
      res.status(exception.httpStatus).json({
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.rule ? { rule: exception.rule } : {}),
          ...(exception.details ? { details: exception.details } : {}),
        },
        path: req.url,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      res.status(exception.getStatus()).json({
        error: typeof body === 'string' ? { message: body } : body,
        path: req.url,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const correlationId = Math.random().toString(36).slice(2, 10);
    this.log.error(
      `[${correlationId}] ${req.method} ${req.url} — ${(exception as Error)?.message}`,
      (exception as Error)?.stack,
    );
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', correlationId },
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
