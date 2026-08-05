import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import path from 'path';
import { allowedOrigins, env, isProduction } from './config/env';
import { httpLogStream } from './config/logger';
import { apiLimiter } from './middlewares';
import { errorHandler } from './middlewares/error.middleware';
import { notFound } from './middlewares/notFound.middleware';
import routes from './routes';

export function createApp(): Application {
  const app = express();

  // Behind a proxy (Railway/Render) so rate-limit & secure cookies work.
  app.set('trust proxy', 1);

  // Configure helmet to allow Vercel Analytics scripts
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://vercel.live',
            'https://*.vercel-insights.com',
          ],
          connectSrc: ["'self'", 'https://*.vercel-insights.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
        },
      },
    })
  );
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow non-browser clients (no origin) and whitelisted origins.
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin not allowed by CORS: ${origin}`));
      },
      credentials: true,
    })
  );
  app.use(compression());
  app.use(cookieParser());

  // Capture the raw body for webhooks (Meta + Razorpay) so their signatures can
  // be verified against the exact bytes received.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: Request, _res, buf) => {
        if (
          req.originalUrl.includes('/webhooks/meta') ||
          req.originalUrl.includes('/webhooks/razorpay')
        ) {
          (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        }
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));

  if (!isProduction) {
    app.use(morgan('dev', { stream: httpLogStream }));
  } else {
    app.use(morgan('combined', { stream: httpLogStream }));
  }

  // Serve static files from public directory
  app.use(express.static(path.join(__dirname, '../public')));

  // Status dashboard with Vercel Analytics
  app.get('/status', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  // Liveness probe at the root.
  app.get('/', (_req: Request, res: Response) => {
    res.json({ success: true, message: 'SocialDM API', data: { version: '1.0.0' } });
  });

  app.use(env.API_PREFIX, apiLimiter, routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
