import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

/**
 * Mirrors the legacy service's error surface: errors land as a plain
 * `{ error: ... }` JSON body, not an HTML stack trace. Known HTTP
 * exceptions pass their intended payload through; anything else is
 * logged server-side and answered with a generic message so internal
 * details (hostnames, URLs, library errors) never reach clients.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // String responses are wrapped in the legacy `{ error }` shape;
      // object responses already carry their own shape.
      const payload =
        typeof body === 'string'
          ? { error: body }
          : (body as Record<string, unknown>);
      response.status(status).json(payload);
      return;
    }

    this.logger.error(
      exception instanceof Error
        ? (exception.stack ?? exception.message)
        : String(exception),
    );
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: 'Internal server error' });
  }
}
