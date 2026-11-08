import { ApiGatewayModule } from '@gateway/api-gateway.module';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { ZodValidationPipe } from 'nestjs-zod';

const parseOrigins = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

async function bootstrap() {
  const app =
    await NestFactory.create<NestExpressApplication>(ApiGatewayModule);
  const configService = app.get(ConfigService);

  // Rate limiting keys on req.ip, which is only the real client when this matches
  // the number of proxies in front of the gateway (nginx = 1; nginx behind a
  // tunnel/CDN = 2). A wrong value either collapses all users into one bucket or
  // lets clients spoof X-Forwarded-For. Verify against the nginx access log.
  const trustProxyHopsRaw = configService
    .get<string>('TRUST_PROXY_HOPS')
    ?.trim();
  const trustProxyHops = trustProxyHopsRaw ? Number(trustProxyHopsRaw) : NaN;
  app.set(
    'trust proxy',
    Number.isInteger(trustProxyHops) && trustProxyHops >= 0
      ? trustProxyHops
      : 1,
  );

  app.use(cookieParser());

  const allowedOrigins = new Set([
    ...parseOrigins(configService.get<string>('FRONTEND_URL')),
    ...parseOrigins(configService.get<string>('CALL_OPS_DASHBOARD_ORIGINS')),
    ...parseOrigins(configService.get<string>('BACKEND_URL')),
    ...(process.env.NODE_ENV === 'production'
      ? []
      : ['http://localhost:5173', 'http://localhost:3000']),
  ]);

  app.enableCors({
    credentials: true,
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS origin not allowed: ${origin}`));
    },
  });

  const config = new DocumentBuilder()
    .setTitle('Microservices API Gateway')
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  app.useGlobalPipes(new ZodValidationPipe());

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');

  console.log(`Gateway is running on: http://localhost:${port}/api`);
}
void bootstrap();
