import type { CookieOptions, Response } from "express";
import type { Config } from "../config.js";

export const REFRESH_COOKIE_NAME = "refresh_token";
// The browser sends the cookie only to the auth endpoints, never with /documents
// or any other request, which shrinks both exposure and CSRF surface.
export const REFRESH_COOKIE_PATH = "/api/v1/auth";

type CookieSettings = Pick<Config["auth"], "refreshTokenTtlSeconds" | "secureCookies">;

// - httpOnly: JavaScript cannot read it, so an XSS bug cannot steal it.
// - secure:   HTTPS only (production).
// - sameSite strict: never sent on cross-site requests, which is the CSRF defence for
//   /auth/refresh. Revisit (and add a CSRF token) if the web app is ever served from a
//   different registrable domain than the API.
// - path:     limited to the auth endpoints.
function baseOptions(settings: Pick<CookieSettings, "secureCookies">): CookieOptions {
  return {
    httpOnly: true,
    secure: settings.secureCookies,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(res: Response, token: string, settings: CookieSettings): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...baseOptions(settings),
    maxAge: settings.refreshTokenTtlSeconds * 1000, // Express takes milliseconds
  });
}

// Clearing must repeat the same path/flags, or the browser treats it as a different cookie.
export function clearRefreshCookie(
  res: Response,
  settings: Pick<CookieSettings, "secureCookies">,
): void {
  res.clearCookie(REFRESH_COOKIE_NAME, baseOptions(settings));
}
