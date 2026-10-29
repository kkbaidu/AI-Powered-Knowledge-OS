# Atlas — Architecture Diagrams (MVP Scope)

Scope: Phase 0–3 (foundation, auth, knowledge ingestion, RAG chat). Update these as you build — they should reflect what the code actually does, not the aspirational doc.

**Status legend:** diagrams 2 and 4 are split into **Implemented** (matches the code on `main`) and **Planned** (not built yet). Last verified against code: 2026-10-28.

---

## 1. System Overview

```mermaid
flowchart TB
    Client[Browser / Next.js]

    subgraph API["Express API"]
        MW[Middleware chain]
        Auth[Auth module]
        Docs[Documents module]
        AI[AI / RAG module]
    end

    Queue[(Redis + BullMQ)]
    Worker[Background Worker]
    PG[(PostgreSQL + pgvector)]
    S3[(S3-compatible storage)]
    Gemini[Gemini API]

    Client -->|HTTPS REST| MW
    MW --> Auth
    MW --> Docs
    MW --> AI

    Auth --> PG
    Docs --> PG
    Docs --> S3
    Docs -->|enqueue job| Queue
    Queue --> Worker
    Worker --> PG
    Worker --> S3
    Worker -->|embeddings| Gemini

    AI --> PG
    AI -->|generate| Gemini
```

---

## 2. Data Model — ER Diagram

### 2a. Implemented: identity domain (migrations `0000`–`0001`)

Source of truth: `apps/api/src/db/schema/identity.ts`. Table names are plural (`user` is a reserved word in Postgres). Relationship labels show the foreign key's `ON DELETE` behavior.

```mermaid
erDiagram
    users ||--o{ sessions : "owns (CASCADE)"
    users ||--o{ organizations : "owns (RESTRICT)"
    users ||--o{ organization_members : "joins as (CASCADE)"
    organizations ||--o{ organization_members : "has (CASCADE)"
    organizations ||--o{ roles : "defines (CASCADE)"
    roles ||--o{ organization_members : "assigned to (RESTRICT)"
    roles ||--o{ role_permissions : "grants (CASCADE)"
    permissions ||--o{ role_permissions : "granted via (CASCADE)"

    users {
        uuid id PK "gen_random_uuid()"
        text email UK "unique on lower(email)"
        text password_hash "nullable, OAuth users have none"
        text display_name
        user_status status "pending_verification | active | suspended"
        timestamptz created_at
        timestamptz updated_at
    }
    sessions {
        uuid id PK
        uuid user_id FK
        text refresh_token_hash UK "SHA-256, never the raw token"
        text previous_token_hash "reuse detection after rotation"
        text device_info
        inet ip_address
        boolean revoked
        timestamptz expires_at
        timestamptz last_used_at
        timestamptz created_at
        timestamptz updated_at
    }
    organizations {
        uuid id PK
        text name
        text slug UK
        uuid owner_id FK
        timestamptz created_at
        timestamptz updated_at
    }
    organization_members {
        uuid id PK
        uuid organization_id FK
        uuid user_id FK
        uuid role_id FK
        member_status status "active | suspended"
        timestamptz joined_at
        timestamptz created_at
        timestamptz updated_at
    }
    roles {
        uuid id PK
        uuid organization_id FK
        text name "unique per organization"
        boolean is_default "copied from defaults at org creation"
        timestamptz created_at
        timestamptz updated_at
    }
    permissions {
        uuid id PK
        text name UK "resource.action, e.g. document.read"
        text description
    }
    role_permissions {
        uuid role_id PK, FK
        uuid permission_id PK, FK
    }
```

Constraints and indexes not visible in the diagram:

| Table | Constraint / index | Why |
|---|---|---|
| `users` | unique index on `lower(email)` | `A@x.com` and `a@x.com` are one account; lookups must use `lower(email) = $1` |
| `sessions` | unique `refresh_token_hash`; indexes on `previous_token_hash`, `user_id`, `expires_at` | refresh lookup, reuse detection, "revoke all my sessions", expired-session cleanup |
| `organization_members` | unique `(organization_id, user_id)`; indexes on `user_id`, `role_id` | one membership per org; "which orgs is this user in" |
| `roles` | unique `(organization_id, name)` | role names are unique within an organization |
| `role_permissions` | composite PK `(role_id, permission_id)`; index on `permission_id` | no duplicate grants; "which roles have permission X" |

`ON DELETE` summary: **CASCADE** where a child has no meaning without its parent (sessions, memberships, roles, join rows). **RESTRICT** where deletion must be a conscious act (a user who owns an organization; a role that members still hold).

### 2b. Planned: knowledge and chat domain (Phase 2–3, not built)

```mermaid
erDiagram
    organizations ||--o{ WORKSPACE : owns
    WORKSPACE ||--o{ WORKSPACE_MEMBER : has
    WORKSPACE ||--o{ DOCUMENT : contains
    DOCUMENT ||--o{ DOCUMENT_VERSION : has
    DOCUMENT_VERSION ||--o{ CHUNK : split_into
    CHUNK ||--o| EMBEDDING : has
    WORKSPACE ||--o{ CONVERSATION : has
    CONVERSATION ||--o{ MESSAGE : contains
    MESSAGE ||--o{ CITATION : cites
    CITATION }o--|| CHUNK : references

    WORKSPACE {
        uuid id PK
        uuid organization_id FK
        string name
        string visibility
    }
    DOCUMENT {
        uuid id PK
        uuid workspace_id FK
        string title
        string status
        uuid owner_id FK
    }
    DOCUMENT_VERSION {
        uuid id PK
        uuid document_id FK
        int version_number
        string file_key
    }
    CHUNK {
        uuid id PK
        uuid document_version_id FK
        text content
        int position
        int token_count
    }
    EMBEDDING {
        uuid id PK
        uuid chunk_id FK
        vector vector
        string model
    }
    CONVERSATION {
        uuid id PK
        uuid workspace_id FK
        uuid user_id FK
    }
    MESSAGE {
        uuid id PK
        uuid conversation_id FK
        string role
        text content
    }
    CITATION {
        uuid id PK
        uuid message_id FK
        uuid chunk_id FK
        float confidence_score
    }
```

The `vector` extension is already enabled (migration `0000_enable_pgvector`), so `EMBEDDING.vector` needs no extra setup.

---

## 3. Auth Flow — Login, Refresh, Rotation, Reuse Detection

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant DB as Postgres (session table)

    C->>A: POST /auth/login (email, password)
    A->>DB: verify password hash
    A->>DB: create session row (refresh_token_hash)
    A-->>C: access_token (JWT, 15m) + refresh_token (cookie, 30d)

    Note over C,A: Normal request
    C->>A: GET /documents (Bearer access_token)
    A-->>C: 200 OK (verified via JWT signature, no DB hit)

    Note over C,A: Access token expires
    C->>A: GET /documents (expired token)
    A-->>C: 401 Unauthorized

    C->>A: POST /auth/refresh (cookie: refresh_token)
    A->>DB: hash token, atomic UPDATE ... WHERE refresh_token_hash = hash<br/>AND NOT revoked AND not expired (rotate in one statement)
    alt a row was updated (token was the current one)
        DB-->>A: session with new hash, old hash moved to previous_token_hash
        A-->>C: new access_token + new refresh_token (cookie re-issued)
    else no row updated
        A->>DB: find session by previous_token_hash
        alt not found, or session revoked or expired
            A-->>C: 401 INVALID_REFRESH_TOKEN (cookie cleared)
        else rotated less than the grace period ago (two tabs, retry)
            A-->>C: 401 REFRESH_TOKEN_ROTATED (session kept, retry with the new cookie)
        else rotated longer ago: reuse, assume theft
            A->>DB: revoke entire session
            A-->>C: 401 REFRESH_TOKEN_REUSED (cookie cleared, force re-login)
        end
    end

    Note over C,A: Logout
    C->>A: POST /auth/logout (cookie: refresh_token)
    A->>DB: revoke the session whose current or previous hash matches
    A-->>C: 204 (cookie cleared, even if the token was unknown)
    Note over C,A: The access token already issued stays valid until it expires (stateless)
```

---

## 4. Request Lifecycle — Middleware Chain

### 4a. Implemented (`apps/api/src/app.ts`)

Order matters: the request ID exists before logging, logging wraps everything after it, and the error handler is last so it catches anything thrown or passed to `next(err)` above it.

```mermaid
flowchart LR
    Req[Incoming Request] --> ReqId["requestId<br/>accept safe X-Request-Id or generate UUID<br/>set X-Request-Id header"]
    ReqId --> Log["httpLogger (pino-http)<br/>binds reqId to req.log<br/>redacts secrets, no headers/bodies"]
    Log --> Json["express.json<br/>1 MB limit"]
    Json --> Router{"Route match<br/>/api/v1/*"}
    Router -->|"GET /health/live"| Live["Liveness<br/>no dependency checks"]
    Router -->|"GET /health/ready, /health"| Ready["Readiness<br/>Postgres + Redis, 2s timeout each<br/>503 once shutting down"]
    Router -->|no match| NF["notFound<br/>creates NotFoundError"]

    Json -.->|"malformed or oversize body"| EH
    Live --> Res[Response]
    Ready --> Res
    NF --> EH["errorHandler<br/>AppError to standard shape<br/>unknown errors to generic 500"]
    EH --> Res

    classDef built fill:#e6f4ea,stroke:#2e7d32,color:#111;
    class ReqId,Log,Json,Router,Live,Ready,NF,EH built;
```

Per-route middleware (not in the global chain): `validate({ body, params, query })` runs Zod, collects every issue into one `ValidationError`, and exposes parsed values as `res.locals.validated`. It is built and tested but not yet attached to a route (first use: Day 3 auth endpoints).

Every error response, from any stage, has the same shape:

```json
{ "success": false, "error": { "code": "DOCUMENT_NOT_FOUND", "message": "Document does not exist", "details": [] } }
```

`details` appears only for validation errors. Status codes: 401 `AUTH_ERROR`, 403 `PERMISSION_ERROR`, 404 `RESOURCE_NOT_FOUND` / `ROUTE_NOT_FOUND`, 409 `BUSINESS_RULE_ERROR`, 413 `PAYLOAD_TOO_LARGE`, 429 `RATE_LIMITED` (with `Retry-After`), 422 `VALIDATION_ERROR` / `MALFORMED_JSON`, 500 `INTERNAL_ERROR`, 502 `AI_PROVIDER_ERROR`.

### 4b. Full chain: rate limiting and auth built, RBAC planned

```mermaid
flowchart LR
    Req[Incoming Request] --> ReqId[Request ID]
    ReqId --> Log[Structured Logger]
    Log --> RateLimit["Rate Limiter<br/>(Redis sliding window)"]
    RateLimit --> AuthMW["Auth Middleware<br/>Bearer JWT, optional session check"]
    AuthMW --> OrgMW["Org Membership Check<br/>(planned)"]
    OrgMW --> WsMW["Workspace Permission Check<br/>(planned)"]
    WsMW --> Validate[Zod Validation]
    Validate --> Controller[Route Handler]
    Controller --> Service["Service Layer<br/>(planned)"]
    Service --> Repo["Data Access Layer<br/>(Drizzle)"]
    Repo --> DB[(Postgres)]
    Controller --> ErrorHandler[Centralized Error Handler]
    ErrorHandler --> Res[Response]

    classDef built fill:#e6f4ea,stroke:#2e7d32,color:#111;
    classDef planned fill:#fff8e1,stroke:#f9a825,stroke-dasharray: 4 3,color:#111;
    class ReqId,Log,Validate,ErrorHandler,Repo,DB,RateLimit,AuthMW built;
    class OrgMW,WsMW,Service,Controller planned;
```

Today these are mounted per route, not globally. `/auth/register` and `/auth/login` run validation first (the per-account limit is keyed on the normalised email) and the rate limiter second, before any password hashing. Protected routes mount `requireAuth`, optionally with `checkSession` for instant revocation. A single global order comes when more modules exist.

---

## 5. Document Ingestion Pipeline

```mermaid
flowchart TD
    Upload[User requests upload] --> SignedUrl[API issues signed S3 URL]
    SignedUrl --> DirectUpload[Browser uploads directly to S3]
    DirectUpload --> DBRecord[API creates Document row<br/>status = UPLOADING]
    DBRecord --> Enqueue[Enqueue DocumentUploaded job]
    Enqueue --> Worker[BullMQ Worker picks up job]

    Worker --> Extract[Extract text<br/>status = PROCESSING]
    Extract --> Clean[Clean / normalize text]
    Clean --> Chunk[Semantic chunking]
    Chunk --> Embed[Generate embeddings via Gemini]
    Embed --> Store[Store chunks + vectors in Postgres]
    Store --> Index[Update search index]
    Index --> Ready[status = READY]
    Ready --> Notify[Notify user via WebSocket/poll]

    Extract -.failure.-> Retry{Retry count < 3?}
    Retry -->|yes| Extract
    Retry -->|no| Failed[status = FAILED]
```

---

## 6. RAG Retrieval & Chat Flow

```mermaid
flowchart TD
    Q[User question] --> PermCheck[Check workspace permission]
    PermCheck --> Embed[Embed query]
    Embed --> Hybrid[Hybrid Search]

    subgraph Hybrid["Hybrid Search"]
        Vec[pgvector similarity search]
        Kw[Postgres full-text search]
        Vec --> Merge[Weighted merge + rank]
        Kw --> Merge
    end

    Merge --> PermFilter[Filter results by permission]
    PermFilter --> TopN[Top-N chunks]
    TopN --> Context[Assemble context:<br/>system + history + chunks + question]
    Context --> LLM[Call Gemini]
    LLM --> Stream[Stream tokens to client]
    LLM --> Citations[Attach citations to chunks used]
    Citations --> Save[Save message + citations]
```

---

## How to keep these useful

- Store this file at `docs/architecture/diagrams.md` in the repo.
- Update a diagram **in the same PR** that changes the behavior it depicts — treat it like a test that can go stale.
- When you reach the Agents and Workflow slices, add new diagrams rather than overloading these.
- GitHub renders Mermaid natively in `.md` files, so this works as-is in your repo without any extra tooling.