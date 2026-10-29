import type { NextFunction, Request, Response } from "express";
import type { Config } from "../../config.js";
import type { Database } from "../../db/client.js";
import { verifyAccessToken } from "../../auth/accessTokens.js";
import { findSessionForAuth } from "../../auth/sessions.repository.js";
import { AuthError, InternalError, PermissionError } from "../../types/errors.js";

// Who is calling. Stored on res.locals.auth, next to res.locals.validated.
export interface AuthContext {
  userId: string;
  sessionId: string;
}

// Handlers read the caller through this, never from the request. It throws a 500 (a bug,
// not a client error) if a route forgot to mount requireAuth, rather than treating the
// caller as anonymous.
export function getAuth(res: Response): AuthContext {
  const auth = res.locals.auth as AuthContext | undefined;
  if (!auth) throw new InternalError(new Error("getAuth called on a route without requireAuth"));
  return auth;
}

export interface RequireAuthOptions {
  // false (default): trust the signed token alone. No database read, so it is as cheap
  //   as it can be, but a revoked or suspended user keeps access until the token
  //   expires (at most ACCESS_TOKEN_TTL).
  // true: also check that the token's session is still live and the user still active.
  //   One indexed read per request buys instant revocation. Use it on routes where
  //   15 minutes of stale access is not acceptable (account changes, "log out
  //   everywhere", billing, admin actions).
  checkSession?: boolean;
}

export interface RequireAuthDeps {
  auth: Pick<Config["auth"], "accessTokenSecret">;
  db: Database;
}

const BEARER = /^Bearer\s+(\S+)\s*$/i;

// RFC 6750: a 401 from a bearer-protected resource names the scheme it expects, and says
// invalid_token when a token was present but unusable.
function challenge(res: Response, invalidToken: boolean): void {
  res.set(
    "WWW-Authenticate",
    invalidToken ? 'Bearer realm="atlas", error="invalid_token"' : 'Bearer realm="atlas"',
  );
}

// The token is read from the Authorization header only: never the query string (URLs end
// up in logs, history and Referer headers) and never the cookie (browsers attach cookies
// automatically, which would reopen CSRF).
export function requireAuth(deps: RequireAuthDeps, options: RequireAuthOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const match = BEARER.exec(req.headers.authorization ?? "");
    if (!match) {
      challenge(res, false);
      throw new AuthError("Authentication required", "AUTH_REQUIRED");
    }

    let claims;
    try {
      claims = await verifyAccessToken(match[1]!, deps.auth);
    } catch (err) {
      challenge(res, true);
      throw err; // AuthError with ACCESS_TOKEN_EXPIRED or INVALID_ACCESS_TOKEN
    }

    if (options.checkSession) {
      const session = await findSessionForAuth(deps.db, claims.sessionId);
      // A session that does not exist, belongs to someone else, is revoked or has expired
      // is the same answer to the client: this token is no longer good.
      if (
        !session ||
        session.userId !== claims.userId ||
        session.revoked ||
        session.expiresAt <= new Date()
      ) {
        challenge(res, true);
        throw new AuthError("Session is no longer valid", "SESSION_REVOKED");
      }
      if (session.userStatus !== "active") {
        throw new PermissionError("This account is not active", "ACCOUNT_SUSPENDED");
      }
    }

    res.locals.auth = { userId: claims.userId, sessionId: claims.sessionId } satisfies AuthContext;
    next();
  };
}
