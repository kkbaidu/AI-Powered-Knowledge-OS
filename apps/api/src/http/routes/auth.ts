import { Router } from "express";
import type { Config } from "../../config.js";
import type { Database } from "../../db/client.js";
import { loginBody, registerBody } from "../../auth/auth.schemas.js";
import { loginUser, logoutSession, refreshSession, registerUser } from "../../auth/auth.service.js";
import { clearRefreshCookie, readCookie, REFRESH_COOKIE_NAME, setRefreshCookie } from "../../auth/cookies.js";
import { AppError, AuthError } from "../../types/errors.js";
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

  // No body: the refresh token travels in the cookie. SameSite=Strict keeps other sites
  // from triggering this call with the user's cookie (see cookies.ts).
  router.post("/refresh", async (req, res) => {
    const token = readCookie(req, REFRESH_COOKIE_NAME);
    if (!token) {
      throw new AuthError("Refresh token missing", "REFRESH_TOKEN_MISSING");
    }

    try {
      const result = await refreshSession(db, token, auth);
      setRefreshCookie(res, result.refreshToken, auth);
      res.status(200).json({
        success: true,
        data: { user: result.user, accessToken: result.accessToken, expiresIn: result.expiresIn },
      });
    } catch (err) {
      // A 401/403 means this cookie is dead (or the session was just revoked): tell the
      // browser to drop it. A 5xx is OUR fault (say, the DB blipped), and must not log
      // the user out, so the cookie is kept and the client can retry.
      if (err instanceof AppError && (err.statusCode === 401 || err.statusCode === 403)) {
        clearRefreshCookie(res, auth);
      }
      throw err;
    }
  });

  // Always 204, with or without a valid cookie: logging out is idempotent, and the answer
  // must not reveal whether the token was real. The cookie is cleared either way.
  router.post("/logout", async (req, res) => {
    const sessionId = await logoutSession(db, readCookie(req, REFRESH_COOKIE_NAME));
    if (sessionId) req.log.info({ sessionId }, "Session logged out");
    clearRefreshCookie(res, auth);
    res.status(204).end();
  });

  return router;
}
