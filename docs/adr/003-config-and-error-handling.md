# ADR-003: Validated config and centralized error handling

Status: Accepted · Date: 2026-10-20

## Context
The API needs two foundations before any feature work: configuration that cannot be
silently wrong, and one consistent way for failures to reach the client and the logs.

## Decisions

**Config is parsed with Zod at startup and fails fast.** `parseConfig(env)` is pure and
unit-tested; `loadConfig()` calls it once at boot, prints every problem, and exits 1.
A missing or malformed variable stops the process immediately instead of failing
mysteriously on the first request that needs it. The result is deeply frozen, and
ESLint forbids reading `process.env` outside `config.ts`, so there is one gate.

**One error type, one handler.** Code throws `AppError` subclasses (`AuthError` 401,
`PermissionError` 403, `ValidationError` 422, `NotFoundError` 404, `BusinessRuleError` 409,
`AiProviderError` 502, `InternalError` 500). A single `errorHandler` middleware turns
anything thrown into `{ success: false, error: { code, message, details? } }`.
- The doc's categories are the default `code`; a specific code (`DOCUMENT_NOT_FOUND`) can
  be passed so clients can branch on it, as in the doc's example.
- `isOperational` separates expected failures (shown to the client) from bugs and
  infrastructure faults (generic message, full detail only in logs). Unknown errors
  never leak their message, stack, or secrets in the response.
- Logging level follows blame: 4xx = `warn`, 5xx or non-operational = `error`, and the
  original `cause` is logged so the real stack is not lost.
- Body-parser errors are normalized: broken JSON is `422 MALFORMED_JSON` (it was a 500),
  oversize bodies are `413 PAYLOAD_TOO_LARGE`.
- Unmatched routes pass through the same pipeline (`ROUTE_NOT_FOUND`), so the 404 body
  cannot drift from the standard shape.

**No `asyncHandler` wrapper.** Express 5 forwards rejected promises from async handlers
to the error handler natively. A test proves it. The wrapper was only needed on Express 4.

## Alternatives considered
- try/catch in every route: repetitive, and one forgotten catch becomes a hung request or
  a leaked stack trace.
- Returning error objects (Result type) everywhere: explicit, but heavy for an HTTP layer
  that already has exceptions and a natural catch point.
- `ValidationError` as 400 vs 422: 422 chosen (syntactically valid request, semantically
  invalid). 400 is used by many APIs; what matters is consistency and documenting it.

## Interview notes
- *Why fail fast on config?* Cheapest place to find a bug is at boot, not in production under load.
- *Why a centralized handler?* One place decides status, shape, log level and redaction.
- *Operational vs programmer errors?* Operational: expected runtime failures (not found,
  bad input). Programmer: bugs. Handle the first, log and hide the second.
- *What does a request ID add?* It lets you tie a client-visible failure to the exact log
  lines; it is set in `X-Request-Id` on every response, including errors.
