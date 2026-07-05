import type { IncomingMessage, ServerResponse } from 'http';
import { createApp } from '../src/app';
import { ensureDatabaseConnection } from '../src/config/database';
import { logger } from '../src/config/logger';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

// Built once per lambda instance and reused across warm invocations.
// (An Express app is a plain (req, res) handler at runtime.)
const app = createApp() as unknown as NodeHandler;

/**
 * Vercel serverless entry point. All routes are rewritten here (see vercel.json);
 * Express then routes on the original request URL.
 *
 * NOTE: set NODEJS_HELPERS=0 in the Vercel project env so the raw request stream
 * reaches Express untouched — otherwise Vercel pre-parses the body, which breaks
 * express.json() and the Meta webhook raw-body signature verification.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await ensureDatabaseConnection();
  } catch (error) {
    logger.error('Request aborted: MongoDB unreachable', { error });
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, message: 'Service temporarily unavailable' }));
    return;
  }
  app(req, res);
}
