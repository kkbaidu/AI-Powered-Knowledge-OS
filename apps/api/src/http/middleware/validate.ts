import type { Request, Response, NextFunction } from "express";
import { z, type ZodType } from "zod";
import { ValidationError } from "../../types/errors.js";

export interface RequestSchemas {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

// Parsed (and coerced/defaulted) values, available to handlers as res.locals.validated.
export type Validated<S extends RequestSchemas> = {
  [K in keyof S]: S[K] extends ZodType ? z.output<S[K]> : never;
};

const LOCATIONS = ["body", "params", "query"] as const;

// Validates body, params and query against Zod schemas. On failure it throws a
// ValidationError listing every problem (not just the first), so the client can fix
// the whole request in one round trip. Handlers read parsed data from
// res.locals.validated: never from req.body, which is unvalidated input.
// (req.query is a read-only getter in Express 5, so we cannot overwrite it.)
export function validate<S extends RequestSchemas>(schemas: S) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const issues: { location: string; path: string; message: string }[] = [];
    const validated: Record<string, unknown> = {};

    for (const location of LOCATIONS) {
      const schema = schemas[location];
      if (!schema) continue;

      const result = schema.safeParse(req[location]);
      if (result.success) {
        validated[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join("."), message: issue.message });
        }
      }
    }

    if (issues.length > 0) {
      next(new ValidationError("Request validation failed", issues));
      return;
    }

    res.locals.validated = validated;
    next();
  };
}
