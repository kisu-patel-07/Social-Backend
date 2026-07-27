import { NextFunction, Request, Response } from 'express';
import { AnyZodObject, ZodError } from 'zod';
import { ValidationError } from '../utils/AppError';

/**
 * Validate `req.body`, `req.query`, and `req.params` against a Zod schema.
 * On success, the parsed (and coerced) values replace the originals so
 * downstream handlers receive typed, sanitized input.
 */
export function validate(schema: AnyZodObject) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });

      if (parsed.body !== undefined) req.body = parsed.body;
      // req.query / req.params getters are read-only in Express 5; assign defensively.
      if (parsed.query !== undefined) {
        Object.defineProperty(req, 'query', { value: parsed.query, configurable: true });
      }
      if (parsed.params !== undefined) req.params = parsed.params;

      next();
    } catch (err) {
      if (err instanceof ZodError) {
        // Key errors by the real field name ("keywords", "email"), not by the
        // wrapper segment ("body") that flatten() would collapse them into —
        // the client shows these next to the offending input.
        const fieldErrors: Record<string, string[]> = {};
        for (const issue of err.issues) {
          const field = issue.path.slice(1).join('.') || String(issue.path[0] ?? 'request');
          (fieldErrors[field] ??= []).push(issue.message);
        }
        next(new ValidationError('Validation failed', fieldErrors));
        return;
      }
      next(err);
    }
  };
}
