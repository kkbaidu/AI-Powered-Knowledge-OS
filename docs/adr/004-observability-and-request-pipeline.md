# ADR-004: Request IDs, structured logging, validation, and health probes

Status: Accepted · Date: 2026-10-28

## Context
Before features exist, every request needs to be traceable, every log line safe, every
input validated at the edge, and the platform needs to know whether an instance is alive
and whether it should receive traffic.

## Decisions

**Request IDs.** `requestId` runs first. It reuses an incoming `X-Request-Id` only if it
matches `^[A-Za-z0-9._-]{8,128}$`; otherwise it generates a UUID. The ID goes on the
request and on the `X-Request-Id` response header (errors included). Reusing a gateway's ID
lets one ID span services; the charset check stops log injection and oversized values.

**Structured logging with redaction.**
- pino JSON logs. `pino-http` writes one access line per request and binds `reqId` to
  `req.log` (`quietReqLogger`), so every line a handler logs carries the request ID.
- The default `pino-http` serializer dumps all headers (including `Authorization` and
  `Cookie`). We serialize only `method`, `url` (the full original URL) and `statusCode`.
- `redact` censors `password`, `token`, `refreshToken`, `apiKey`, `authorization`,
  `cookie`, etc. at the top level and one level deep, as defense in depth for objects
  logged by application code. Request bodies are never logged.
- Level follows outcome: 5xx = error, 4xx = warn, else info. Successful health probes
  are silent (orchestrators poll constantly).
- Logger is silent under test; tests that assert on logs build their own logger.
- Gotcha found by running the real server: inside a mounted router Express rewrites
  `req.url` to the mount-relative path, so matching on it failed. Use `originalUrl`.

**Validation.** `validate({ body, params, query })` runs Zod on each location, collects
every issue (not just the first) into one `ValidationError` with
`details: [{ location, path, message }]`, and exposes parsed/coerced data as
`res.locals.validated`. Handlers must not read `req.body` directly. `req.query` is a
read-only getter in Express 5, so parsed values cannot be written back to it.

**Health.**
- `/health/live` (liveness): process is up. No dependency checks. A failure restarts the
  container, so checking Postgres here would restart every healthy instance during a DB outage.
- `/health/ready` (readiness): pings Postgres and Redis, each with a 2s timeout so a hung
  dependency cannot hang the probe. A failure removes the instance from rotation without
  restarting it. After SIGTERM it returns 503 `shutting_down` so the load balancer
  drains traffic before the process exits.
- `/health` remains as an alias of readiness for compatibility.

**Small hardening.** `x-powered-by` disabled; JSON body limit 1 MB (oversize becomes 413).

## Alternatives considered
- Trusting any inbound `X-Request-Id`: simpler, but unsafe in logs and headers.
- Mutating `req.body` in place from the validator: convenient, but lets unvalidated and
  validated shapes blur, and does not work for `req.query` in Express 5.
- One `/health` endpoint: conflates "restart me" with "stop sending me traffic".

## Interview notes
- *Liveness vs readiness?* Liveness answers "restart me?"; readiness answers "route to me?".
  Mixing them causes cascading restarts during a dependency outage.
- *Why request IDs?* One ID ties a client-visible failure to every log line it produced,
  across services.
- *Why validate at the edge?* Never trust client data; reject early with one consistent shape.
- *What would you add at scale?* OpenTelemetry trace context (W3C `traceparent`) instead of
  a home-made ID, metrics (RED), and log shipping.
