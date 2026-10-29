import { Router } from "express";
import type { Config } from "../../config.js";
import type { Database } from "../../db/client.js";
import { loginBody, registerBody } from "../../auth/auth.schemas.js";
import { loginUser, registerUser } from "../../auth/auth.service.js";
import { setRefreshCookie } from "../../auth/cookies.js";
import { validate, type Validated } from "../middleware/validate.js";

export interface AuthRouterDeps {
  db: Database;
  auth: Config["auth"];
}

export function authRouter({ db, auth }: AuthRouterDeps): Router {
  const router = Router();

  // Responses here carry tokens or credentials: no browser, proxy or CDN may cache them.
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // Express 5 forwards a rejected promise from an async handler to the error handler,
  // so no try/catch or wrapper is needed here (see ADR-003).
  router.post("/register", validate({ body: registerBody }), async (_req, res) => {
    const { body } = res.locals.validated as Validated<{ body: typeof registerBody }>;
    const user = await registerUser(db, body);
    res.status(201).json({ success: true, data: { user } });
  });

  router.post("/login", validate({ body: loginBody }), async (req, res) => {
    const { body } = res.locals.validated as Validated<{ body: typeof loginBody }>;
    const result = await loginUser(
      db,
      body,
      { userAgent: req.get("user-agent"), ipAddress: req.ip },
      auth,
    );

    // Refresh token: cookie only. Access token: body, held in memory by the client.
    setRefreshCookie(res, result.refreshToken, auth);
    res.status(200).json({
      success: true,
      data: { user: result.user, accessToken: result.accessToken, expiresIn: result.expiresIn },
    });
  });

  return router;
}
