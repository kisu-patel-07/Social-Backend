import { AuthUser } from '../auth.types';

/**
 * Augment Express' Request so controllers/middlewares get a typed `req.user`
 * after the authentication middleware runs.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}

export {};
