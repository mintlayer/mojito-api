import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from 'helmet';
import compression from 'compression';
import express from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  // Body parsing is wired manually: /transaction needs raw text (legacy
  // broadcast contract), everything else JSON — with the exact same
  // parser precedence as the legacy service (json global, text for the
  // transaction route, so JSON content-type clients keep their quirk).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.use(express.json({ limit: '2mb' }));
  app.use('/transaction', express.text({ type: '*/*', limit: '1mb' }));

  // Trust exactly one ingress hop (Traefik): req.ip then reflects the
  // X-Forwarded-For value set by the ingress, while direct clients can
  // no longer spoof it to evade per-IP rate limiting.
  app.set('trust proxy', 1);

  // Security middleware
  app.use(
    helmet({
      // Pure JSON/API + Swagger UI; the default CSP would break /api/docs.
      contentSecurityPolicy: false,
    }),
  );
  app.use(compression());

  // Legacy error surface: `{ error: message }`, never HTML.
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Lenient validation: strip unknown fields but never reject legacy
  // clients that send extra properties.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      validationError: { target: false, value: false },
    }),
  );

  // Browsers, extension pages and the mobile app are all cross-origin.
  app.enableCors();

  // WebSocket adapter for the /ws blockHeight gateway (ws, not socket.io).
  app.useWebSocketAdapter(new WsAdapter(app));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Mojito API')
    .setDescription(
      `Mojito API gateway: Mintlayer batch/aggregation service for the Mojito wallets and the Mintini mobile app, plus a hardened IPFS content cache.

      ## Endpoints
      - /batch_data — batch upstream fetch (extension)
      - /dex_tokens, /chain_tip, /price — market + chain data
      - /account, /tokens, /utxos, /activity, /transaction — Mintini backend
      - /ws — blockHeight broadcast
      - /ipfs/:cid — IPFS metadata/icon cache`,
    )
    .setVersion('1.0.0')
    .addTag('Batch')
    .addTag('Mintini')
    .addTag('IPFS')
    .addServer('http://localhost:3000', 'Development server')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log(`🚀 Application is running on: http://localhost:${port}`);
  console.log(`📚 API Documentation: http://localhost:${port}/api/docs`);
}

bootstrap().catch((err) => {
  console.error('Error starting application:', err);
  process.exit(1);
});
