# Atlas — Architecture Diagrams (MVP Scope)

Scope: Phase 0–3 (foundation, auth, knowledge ingestion, RAG chat). Update these as you build — they should reflect what the code actually does, not the aspirational doc.

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

## 2. Data Model — ER Diagram (MVP tables)

```mermaid
erDiagram
    USER ||--o{ SESSION : has
    USER ||--o{ ORGANIZATION_MEMBER : has
    ORGANIZATION ||--o{ ORGANIZATION_MEMBER : has
    ORGANIZATION ||--o{ WORKSPACE : owns
    ORGANIZATION ||--o{ ROLE : defines
    ROLE ||--o{ ROLE_PERMISSION : has
    PERMISSION ||--o{ ROLE_PERMISSION : grants
    ROLE ||--o{ ORGANIZATION_MEMBER : assigned_to
    WORKSPACE ||--o{ WORKSPACE_MEMBER : has
    WORKSPACE ||--o{ DOCUMENT : contains
    DOCUMENT ||--o{ DOCUMENT_VERSION : has
    DOCUMENT_VERSION ||--o{ CHUNK : split_into
    CHUNK ||--o| EMBEDDING : has
    WORKSPACE ||--o{ CONVERSATION : has
    CONVERSATION ||--o{ MESSAGE : contains
    MESSAGE ||--o{ CITATION : cites
    CITATION }o--|| CHUNK : references

    USER {
        uuid id PK
        string email
        string password_hash
        string status
        timestamp created_at
    }
    SESSION {
        uuid id PK
        uuid user_id FK
        string refresh_token_hash
        string previous_token_hash
        string device_info
        timestamp expires_at
        boolean revoked
    }
    ORGANIZATION {
        uuid id PK
        string name
        string slug
        uuid owner_id FK
    }
    ORGANIZATION_MEMBER {
        uuid id PK
        uuid organization_id FK
        uuid user_id FK
        uuid role_id FK
        string status
    }
    ROLE {
        uuid id PK
        uuid organization_id FK
        string name
    }
    PERMISSION {
        uuid id PK
        string name
    }
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
    A->>DB: hash token, look up session
    alt token matches current hash
        DB-->>A: session valid
        A->>DB: rotate: store new hash, keep previous hash
        A-->>C: new access_token + new refresh_token
    else token matches a PREVIOUS (already-rotated) hash
        DB-->>A: reuse detected
        A->>DB: revoke entire session
        A-->>C: 401 — force re-login
    end
```

---

## 4. Request Lifecycle — Middleware Chain

```mermaid
flowchart LR
    Req[Incoming Request] --> ReqId[Request ID]
    ReqId --> Log[Structured Logger]
    Log --> RateLimit[Rate Limiter]
    RateLimit --> AuthMW[Auth Middleware<br/>verify JWT]
    AuthMW --> OrgMW[Org Membership Check]
    OrgMW --> WsMW[Workspace Permission Check]
    WsMW --> Validate[Zod Validation]
    Validate --> Controller[Route Handler]
    Controller --> Service[Service Layer]
    Service --> Repo[Data Access Layer]
    Repo --> DB[(Postgres)]
    Controller --> ErrorHandler[Centralized Error Handler]
    ErrorHandler --> Res[Response]
```

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