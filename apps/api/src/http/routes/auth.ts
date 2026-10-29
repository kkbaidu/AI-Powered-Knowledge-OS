import { Router } from "express";
import type { Database } from "../../db/client.js";
import { registerBody } from "../../auth/auth.schemas.js";
import { registerUser } from "../../auth/auth.service.js";
import { validate, type Validated } from "../middleware/validate.js";

export interface AuthRouterDeps {
  db: Database;
}

export function authRouter({ db }: AuthRouterDeps): Router {
  const router = Router();

  // Express 5 forwards a rejected promise from an async handler to the error handler,
  // so no try/catch or wrapper is needed here (see ADR-003).
  router.post("/register", validate({ body: registerBody }), async (_req, res) => {
    const { body } = res.locals.validated as Validated<{ body: typeof registerBody }>;
    const user = await registerUser(db, body);
    res.status(201).json({ success: true, data: { user } });
  });

  return router;
}
