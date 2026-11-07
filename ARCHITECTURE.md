# FactoryLens Architecture

## 1. Status and decision boundary

This document is the approved architecture for the first production-quality FactoryLens implementation. It describes what will be built; it does not claim that the components already exist.

An architectural component belongs in the system only when it does at least one of the following:

1. Enables the core inspection experience.
2. Prevents a realistic security, reliability, or data-loss failure.
3. Creates a clean scaling boundary that the current workload already needs.

Everything else remains out until evidence changes the decision.

## 2. Product and quality requirements

FactoryLens must allow an authenticated user to:

- Upload a video, record in the browser, or choose a prepared sample.
- Start a configured Roboflow Workflow without holding the HTTP API request open.
- Observe durable progress and useful failures.
- Review synchronized predictions over video.
- Filter and navigate results without rerunning inference.
- View only inspections and artifacts that they own.
- Revisit history and export structured results.

The implementation must also be:

- Polished and responsive on desktop and tablet-sized layouts.
- Secure by default, with no Roboflow or cloud credentials in browser code.
- Recoverable after API or worker restarts.
- Idempotent under duplicate task delivery.
- Deployable at low usage within free allowances where available.
- Able to scale through configuration and additional instances before requiring a new architecture.

## 3. System architecture

```text
                         Google OpenID Connect
                                  |
                                  v
Browser  ───────────────> React + Node.js API
                            one Cloud Run service
                                  |
                  +---------------+----------------+
                  |               |                |
                  v               v                v
          Neon PostgreSQL   Cloudflare R2    Google Cloud Tasks
          users + sessions  private videos    durable job queue
          inspections/jobs  prediction files       |
                                                   v
                                         Python worker
                                         Cloud Run service
                                                   |
                                      +------------+-----------+
                                      |                        |
                                      v                        v
                                  FFmpeg/ffprobe       Roboflow Workflow
                                                           Cloud or
                                                        local endpoint
```

The application has two deployable code services:

1. A combined React and Node.js Cloud Run service.
2. A separate Python processing Cloud Run service.

Neon, R2, Cloud Tasks, Google OIDC, Secret Manager, and one Cloud Scheduler job are managed dependencies, not additional application services.

## 4. Component responsibilities

### 4.1 React application

The browser owns presentation and browser-native interaction:

- Render sign-in, dashboard, new inspection, inspection detail, history, and account views.
- Record supported browser media through `MediaRecorder`.
- Upload video directly to R2 using API-issued short-lived authorization.
- Poll only queued or running inspections with TanStack Query.
- Download a completed, compressed prediction artifact.
- Synchronize predictions with HTML video using `requestVideoFrameCallback()` when available and a safe fallback otherwise.
- Draw boxes, labels, masks, and markers on Canvas.
- Apply class and confidence filters locally.
- Seek video when the user selects a timeline event.
- Produce user-requested JSON and CSV exports from authorized result data.

The browser does not run inference and never receives database, R2, Roboflow, or Google service-account credentials.

### 4.2 Combined Node.js web and API service

One Cloud Run container serves the compiled Vite application and the `/api` and `/auth` routes from the same origin.

The Node service owns:

- Google OpenID Connect initiation and callback validation.
- FactoryLens users, opaque sessions, sign-out, and authorization.
- Input validation and application policy.
- Inspection creation and ownership checks.
- Short-lived R2 upload and download authorization.
- Upload completion verification.
- Durable job creation and Cloud Tasks dispatch.
- Status, history, cancellation, result, and export APIs.
- Per-user quotas and configured media limits.
- Structured application logs and correlation identifiers.

It does not proxy video bytes, inspect frames, run FFmpeg, or execute Roboflow Workflows.

Serving React and the API together is intentional: it provides same-origin cookies and API calls, eliminates application CORS, and keeps the first deployment small. Static assets can later be cached by a CDN or split to static hosting without changing API contracts.

### 4.3 Google OpenID Connect

Google proves the user's identity; it does not own FactoryLens authorization or application sessions.

The Node service uses Authorization Code flow with PKCE, `state`, and `nonce`. On callback it validates the issuer, audience, expiry, nonce, and returned authorization state. The stable Google `sub` claim identifies the account; email is profile data and must not be used as the external identity key.

After successful authentication, Node upserts the FactoryLens user and creates its own opaque session. The raw session token exists only in an `HttpOnly`, `Secure`, `SameSite` cookie; PostgreSQL stores only a hash and expiry.

### 4.4 Neon PostgreSQL

PostgreSQL is the durable source of truth for:

- Users and sessions.
- Inspection ownership and lifecycle.
- Upload metadata and object keys.
- Processing jobs, attempts, leases, heartbeats, and cancellation.
- Dispatch reconciliation state.
- Small inspection summaries and safe error information.

PostgreSQL does not store video blobs or one row for every prediction in every frame. Those belong in R2 artifacts.

The application uses Neon connection pooling. Every query involving user-owned data includes the owner identifier; knowledge of an inspection UUID is never sufficient authorization.

### 4.5 Cloudflare R2

R2 stores private, immutable or versioned objects:

- Original uploaded or recorded video.
- A normalized video only when conversion is necessary.
- A poster frame or thumbnail.
- One compressed, versioned prediction document per successful processing run.

Object keys use generated identifiers, not user-provided filenames. The browser uploads directly to R2 so video traffic does not consume Node memory, bandwidth, or Cloud Run request time. Bucket CORS is restricted to the FactoryLens web origin and required methods.

### 4.6 Google Cloud Tasks

Cloud Tasks provides durable, one-to-one delivery from a committed job to the Python worker. It is a queue, not the source of business truth; PostgreSQL remains authoritative.

Each task contains only a job identifier and dispatch generation. It does not contain credentials, video bytes, or the full inspection record. Cloud Tasks calls the private worker endpoint with a Google-signed OIDC identity and configured retry, rate, concurrency, and deadline settings.

Cloud Tasks is preferred here over Pub/Sub because each inspection requires one worker execution rather than event fan-out. A broker such as Kafka or RabbitMQ would add an operational system without solving an additional initial requirement.

### 4.7 Python worker

The worker is a separate Cloud Run service because media and computer-vision processing have a different runtime, dependency set, duration, memory profile, and scaling policy from the Node API.

For an accepted job, the worker:

1. Authenticates the Cloud Tasks request.
2. Acquires an atomic, time-limited PostgreSQL lease.
3. Downloads the source object from R2.
4. Inspects the real media with `ffprobe`.
5. Rejects unsupported or unsafe input with a stable terminal error.
6. Uses FFmpeg only if normalization is required.
7. Runs the configured Roboflow Workflow through an adapter.
8. Records stage progress and renews its heartbeat and lease.
9. Converts Workflow output into the FactoryLens prediction schema.
10. Writes the compressed artifact to R2.
11. Commits the relational summary and terminal state idempotently.

The worker API key and R2 write credential remain server-side. Temporary files are bounded and removed after the request.

### 4.8 Roboflow Workflow endpoint

The worker depends on a narrow `WorkflowRunner` interface. Configuration selects either:

- Roboflow Cloud for the deployed application, or
- A compatible self-hosted/local Inference HTTP endpoint for development or a later private deployment.

FactoryLens uses published packages and documented APIs. It does not import code from sibling repositories through relative paths.

### 4.9 Supporting managed features

Google Secret Manager stores production secrets such as the Google client secret, R2 credentials, database connection string, and Roboflow credential. Cloud Run service identities receive only the secrets they require.

One Cloud Scheduler invocation calls a protected maintenance endpoint. That endpoint performs bounded batches of:

- Re-dispatching committed jobs that have no confirmed Cloud Task.
- Recovering stale job leases.
- Applying retention and abandoned-upload cleanup.

This is reconciliation, not a third application service or a general workflow engine.

## 5. End-to-end flows

### 5.1 Sign-in

```text
Browser       Node API       Google OIDC       PostgreSQL
   |              |               |                 |
   | GET /auth/google             |                 |
   |------------->| create state, nonce, PKCE       |
   |<-------------| redirect to Google              |
   | authorization request ------>|                 |
   |<------ callback redirect with authorization code
   | GET callback with code       |                 |
   |------------->| exchange code |                 |
   |              |-------------->|                 |
   |              |<--------------| validated tokens|
   |              |-------------------------------->| upsert user/session
   |<------------- secure session cookie            |
```

The login transaction binds the callback to the initiating browser and stores no Google access token unless a future Google API integration actually requires one.

### 5.2 Create and upload an inspection

1. The authenticated browser calls `POST /api/inspections` with source metadata.
2. Node checks ownership, quota, allowed media limits, and current active-job policy.
3. PostgreSQL creates an inspection in `awaiting_upload` state.
4. Node returns a short-lived, object-specific R2 upload authorization.
5. The browser uploads directly to R2 and reports progress locally.
6. The browser calls `POST /api/inspections/:id/upload-complete`.
7. Node verifies the object exists and its size is within the declared limit.
8. A transaction moves the inspection to `queued` and creates a job in `pending_dispatch`.
9. After commit, Node creates the Cloud Task and records `task_enqueued_at`.

The API never trusts a client assertion that an object exists without verifying it.

### 5.3 Reliable task dispatch

Database commit and Cloud Tasks creation cannot share one distributed transaction. FactoryLens closes that failure gap without a generic event platform:

1. Commit the job first with a deterministic job ID, dispatch generation, and `task_enqueued_at = null`.
2. Create a Cloud Task with a deterministic name derived from the job and generation.
3. Mark the job dispatched after successful creation.
4. If the response is uncertain, treating `ALREADY_EXISTS` as success is safe.
5. The maintenance endpoint finds old `pending_dispatch` rows and repeats the same idempotent operation.

The job row therefore acts as the minimal dispatch record; a generic outbox table is unnecessary until the application has multiple event consumers.

### 5.4 Process a job

```text
Cloud Tasks       Python worker       PostgreSQL       R2       Roboflow
     |                  |                  |             |           |
     | OIDC request     |                  |             |           |
     |----------------->| acquire lease    |             |           |
     |                  |----------------->|             |           |
     |                  | download source  |             |           |
     |                  |------------------------------->|           |
     |                  | ffprobe / optional FFmpeg      |           |
     |                  | run Workflow ----------------------------->|
     |                  |<----------------------------- predictions  |
     |                  | write artifact ---------------->|           |
     |                  | complete atomically ---------->|           |
     |<-----------------| 2xx                            |           |
```

Processing behavior is classified explicitly:

- Invalid or unsupported media is terminal: save a safe error and return success to stop queue retries.
- A transient network or provider error is retryable: save retry state and return a retryable failure while attempts remain.
- On the configured final attempt, persist a terminal failure and acknowledge the task.
- A duplicate delivery for a completed job returns success without reprocessing.
- A delivery while another valid lease exists is retried later.
- Cancellation is checked before expensive stages and periodically during long work.

### 5.5 Progress and cancellation

The browser polls active inspections through TanStack Query. Polling stops on a terminal state and slows when the page is in the background. No persistent connection is required.

`POST /api/inspections/:id/cancel` sets a durable cancellation flag. Cancellation is cooperative: the worker observes it at stage boundaries, records `cancelled`, and removes temporary output. Completed artifacts are not silently deleted by cancellation.

### 5.6 Investigation playback

1. Node loads the inspection with `WHERE id = ? AND owner_user_id = ?`.
2. Node returns summary data and short-lived R2 access for the video and prediction artifact.
3. The browser downloads the compressed prediction document once.
4. The active video timestamp selects the nearest prediction frame.
5. Canvas draws the current, locally filtered predictions.
6. Timeline selection seeks the video to the selected event.

This flow performs no inference and makes no per-frame API request.

## 6. State model

### 6.1 Inspection states

```text
awaiting_upload
      |
      v
    queued -------> cancelled
      |
      v
  processing -----> cancelled
    |     |
    |     +--------> failed
    v
 completed
```

An abandoned `awaiting_upload` inspection expires through maintenance cleanup. Terminal states are `completed`, `failed`, and `cancelled`.

### 6.2 Job states

```text
pending_dispatch -> queued -> running -> completed
                       |         |
                       |         +-> retry_wait -> queued
                       |         +-> failed
                       +------------> cancelled
```

State transitions are conditional database updates, not unconditional overwrites. A stale worker cannot complete a job after losing its lease.

## 7. Persistence model

The initial schema has four primary tables.

### `users`

- `id`
- `google_subject` — unique stable Google identity
- `email`, `display_name`, `avatar_url` — profile data
- `created_at`, `updated_at`, `last_login_at`

Only Google login is supported initially, so a generic provider-identity table would be premature. It can be introduced through a migration if a second identity provider becomes real.

### `sessions`

- `id`
- `user_id`
- `token_hash`
- `expires_at`, `last_seen_at`, `revoked_at`
- `created_at`

Session tokens are high entropy. Raw tokens are never stored in the database or logs.

### `inspections`

- `id`, `owner_user_id`, `title`
- `status`, `source_type`, `workflow_key`
- `source_object_key`, `normalized_object_key`, `prediction_object_key`
- Declared and inspected media metadata
- Prediction schema version and Workflow fingerprint
- Small aggregate counts and summary values
- Safe error code and user-facing message
- `created_at`, `queued_at`, `started_at`, `completed_at`, `updated_at`

Indexes begin with the actual query paths: owner plus creation time for history, owner plus status for active work, and status plus update time for maintenance.

### `jobs`

- `id`, `inspection_id`
- `status`, `stage`, `progress_percent`
- `attempt_count`, `max_attempts`
- `dispatch_generation`, `task_name`, `task_enqueued_at`
- `lease_token`, `lease_expires_at`, `heartbeat_at`
- `cancel_requested_at`
- Safe structured error code and message
- `created_at`, `available_at`, `started_at`, `finished_at`, `updated_at`

The lease token participates in progress and completion updates. This prevents an expired attempt from overwriting a newer attempt.

## 8. Artifact contract

The prediction artifact is a versioned compressed JSON document for the bounded initial video size:

```json
{
  "schemaVersion": 1,
  "inspectionId": "...",
  "source": {
    "width": 1920,
    "height": 1080,
    "durationMs": 42000,
    "timeBase": "milliseconds"
  },
  "workflow": {
    "key": "factory-safety-v1",
    "fingerprint": "..."
  },
  "classes": ["person", "helmet"],
  "frames": [
    {
      "timestampMs": 120,
      "predictions": []
    }
  ],
  "events": []
}
```

The exact prediction fields depend on the selected Workflow and must be finalized as a contract before worker and Canvas implementation. A single compressed document is the simplest correct choice for bounded clips. Chunking should be added only if browser memory and transfer measurements show the need.

## 9. API boundary

The initial API surface should remain resource-oriented and small:

```text
GET    /auth/google
GET    /auth/google/callback
POST   /auth/logout
GET    /api/me

POST   /api/inspections
POST   /api/inspections/:id/upload-complete
GET    /api/inspections
GET    /api/inspections/:id
POST   /api/inspections/:id/cancel
POST   /api/inspections/:id/retry
GET    /api/inspections/:id/artifacts
GET    /api/inspections/:id/export.csv

POST   /internal/tasks/process
POST   /internal/maintenance/reconcile
```

The two `/internal` endpoints do not use browser sessions. They require Google service identity and reject ordinary public callers.

Contracts are validated at every untrusted boundary. The React application and Node service share TypeScript schemas where useful; the Python worker has explicit compatible models and contract tests rather than importing TypeScript at runtime.

## 10. Security model

- All browser application routes use HTTPS.
- API and React share an origin; application API CORS is disabled.
- OIDC uses code flow, PKCE, state, and nonce validation.
- Session cookies are `HttpOnly`, `Secure`, and appropriately `SameSite`.
- State-changing endpoints validate origin and use CSRF protection where the cookie policy alone is insufficient.
- Authorization checks use the current user ID on every owned-resource query.
- Worker and maintenance endpoints require Google-signed service identity.
- R2 objects are private and accessed through short-lived, object-scoped authorization.
- R2 CORS permits only the application origin and necessary upload/download methods.
- User filenames are display metadata, never trusted paths or object keys.
- MIME type and extension are hints; `ffprobe` inspects the actual media.
- Upload bytes, duration, resolution, and concurrent active work are bounded.
- FFmpeg arguments are constructed as an argument array, never an interpolated shell command.
- Credentials, cookies, signed URLs, tokens, and raw private predictions are excluded from logs.
- Each service receives only its required secrets and cloud permissions.
- Account and upload endpoints are rate limited.

“Authenticated API” does not mean “network invisible.” The browser-facing Cloud Run service is reachable on the internet, and its authorization layer protects private operations.

## 11. Reliability and idempotency

The following invariants are required:

- Every queued inspection has exactly one durable job row.
- A job may be delivered more than once but its expensive work is committed at most once per successful generation.
- Only the holder of the current lease token may report progress or complete a running job.
- Artifact keys include the inspection and processing generation, so retries do not corrupt previously committed output.
- Completion updates the inspection and job in one database transaction after the artifact exists.
- If completion commits but the HTTP response is lost, the next task delivery observes `completed` and acknowledges without repeating work.
- If artifact upload succeeds but database completion fails, retry writes the same generated artifact key or safely replaces the uncommitted generation.
- Task dispatch is recoverable from its committed database record.
- Retries use bounded exponential backoff and a small configured maximum attempt count.
- User-facing failures use stable codes and sanitized messages; detailed diagnostics remain in structured server logs.

Initial configurable safety defaults should be conservative and benchmarked before deployment. A reasonable starting envelope is a five-minute, 1080p, 250 MiB input with no more than three processing attempts. These are product controls, not architectural constants.

Cloud Tasks HTTP execution has a bounded deadline. If real processing measurements cannot reliably fit inside it, the next design is chunked work or Cloud Run Jobs—not silently increasing user limits beyond the execution model.

## 12. Scaling behavior

This design scales without changing business logic, but no architecture provides unlimited automatic capacity.

| Pressure | Existing response |
| --- | --- |
| More page/API traffic | Stateless Node Cloud Run instances scale horizontally |
| More static-asset traffic | Cache through normal HTTP headers; add Cloud CDN without changing React or API contracts |
| Large upload bandwidth | Browser transfers directly to R2 rather than through Node |
| Processing bursts | Cloud Tasks buffers work and controls dispatch rate/concurrency |
| More processing demand | Python Cloud Run instances scale separately from Node |
| Database connection pressure | Neon pooled connection endpoint and conservative per-instance pools |
| Roboflow quota pressure | Cloud Tasks rate limits and application quotas protect the downstream service |
| Large result artifacts | R2 carries bytes; PostgreSQL stores only summaries and references |

Important capacity ceilings remain:

- Neon connection and compute limits.
- Cloud Run project quotas and configured maximum instances.
- Cloud Tasks rate and concurrency settings.
- Roboflow request, credit, and model limits.
- R2 storage and operation allowances.

Scaling these limits is configuration and capacity planning. A different queue, database, or microservice layout is not justified until measurements show a specific bottleneck.

## 13. Deployment shape

### 13.1 Production

- `factorylens-web`: one Cloud Run service containing the Vite static build and Node API.
- `factorylens-worker`: one separately configured Cloud Run service accepting authenticated Cloud Tasks requests.
- Neon pooled PostgreSQL.
- One private Cloudflare R2 bucket with lifecycle rules and restricted CORS.
- One Google Cloud Tasks queue with bounded retries, rate, and concurrency.
- Google Secret Manager.
- One Cloud Scheduler reconciliation invocation.

The web/API and worker use separate service identities, secrets, CPU/memory settings, concurrency, autoscaling limits, and deployment artifacts.

Deployment should use infrastructure as code where it improves repeatability. GitHub Actions should authenticate to Google through workload identity federation rather than a stored long-lived service-account key.

### 13.2 Local development

Local development should not require paid cloud calls for normal UI and contract work:

- Vite development server for React.
- Local Node API.
- PostgreSQL in Docker.
- Filesystem implementation of the object-storage interface.
- In-process implementation of the task-dispatch interface.
- Local Python worker invoked through the same job contract.
- Fixture `WorkflowRunner` for deterministic results.
- Optional real Roboflow Cloud or local Inference adapter for integration testing.
- Development-only auth adapter or seeded session; production builds must reject it.

Cloud Tasks has no role in unit tests. Adapter contract tests ensure local and production implementations honor the same application behavior.

## 14. Observability and operations

Initial observability uses the platform capabilities already present:

- Structured JSON logs from Node and Python.
- A request correlation ID propagated as job and inspection context.
- Cloud Run request, error, latency, instance, CPU, and memory metrics.
- Cloud Tasks queue depth and retry metrics.
- Database job age, stale lease, and failure counts exposed through bounded maintenance queries.
- Stable application error codes visible in the UI.

No self-hosted telemetry stack is needed initially. OpenTelemetry and a dedicated backend become reasonable only when cross-service diagnosis cannot be answered from correlated logs and managed metrics.

Operational alerts should focus on symptoms:

- Oldest queued job age.
- Repeated task failures.
- Stale running jobs.
- Elevated API or worker error rate.
- Database or Roboflow quota exhaustion.
- Storage growth beyond the retention policy.

## 15. Testing strategy

- Vitest for TypeScript domain rules, validation, authorization, and dispatch behavior.
- React Testing Library for important view and interaction states.
- API integration tests against PostgreSQL for ownership, sessions, state transitions, dispatch recovery, leases, retries, and idempotency.
- pytest for media validation, FFmpeg planning, prediction conversion, error classification, and worker lease behavior.
- Storage and task adapter contract tests.
- Playwright for the critical path from sign-in through upload, completion, and synchronized investigation.
- Fixture videos and predictions for deterministic UI and worker tests.
- A small opt-in real Roboflow integration suite, excluded from ordinary local and pull-request runs.

The highest testing priority is authorization and failure recovery, not shallow coverage totals.

## 16. Intentionally excluded

The initial architecture does not include:

- WorkOS, Auth0, Clerk, or another identity platform.
- Password authentication.
- Resend or any email/notification service.
- Redis or Valkey.
- Pub/Sub, RabbitMQ, Kafka, or NATS.
- Temporal, Argo Workflows, or a general workflow orchestrator.
- WebSockets or Server-Sent Events.
- Kubernetes or a service mesh.
- A custom API gateway.
- Organizations, roles, billing, subscriptions, or enterprise SSO.
- Multi-region active-active infrastructure.
- A generic Workflow editor.
- A device fleet-management system.
- A dedicated analytics database.
- Self-hosted Grafana, Loki, Tempo, or Prometheus infrastructure.

### Optional later: edge runner

A thin edge runner becomes justified only when FactoryLens must continuously reach a webcam or RTSP camera on a private factory network. Its first form should capture a bounded clip, upload it directly to R2, and send a device credential and heartbeat to Node. It should reuse the existing cloud processing flow rather than introducing local inference, remote-upgrade infrastructure, or fleet orchestration.

## 17. Upgrade triggers

Future technology changes must respond to evidence:

| Add or change | Evidence required |
| --- | --- |
| Redis | Measured database contention from sessions, quotas, or hot ephemeral reads |
| SSE or WebSockets | Polling creates demonstrated load or cannot meet a real latency requirement |
| Chunked prediction artifacts | Completed artifacts exceed acceptable browser memory or load time |
| Cloud Run Jobs or chunked processing | Bounded jobs cannot reliably finish within the task HTTP deadline |
| Dedicated static hosting/CDN | Static traffic becomes material or global asset latency is measured |
| Additional identity provider | A real user requirement beyond Google sign-in |
| Organization/RBAC model | Multiple users must share and govern the same inspections |
| Dedicated event bus | Multiple independent consumers need the same domain events |
| Local edge inference | Privacy, connectivity, bandwidth, or latency requires processing at the camera |
| Kubernetes | Workload or networking requirements cannot be met economically by managed services |
| Telemetry backend | Correlated logs and managed metrics cannot diagnose recurring production failures |

## 18. Implementation order

The architecture should be implemented in vertical slices rather than building every infrastructure layer first:

1. Finalize the inspection scenario, Workflow output, prediction schema, and safety limits.
2. Scaffold the repository, shared contracts, local PostgreSQL, and fixture adapters.
3. Implement Google sign-in, sessions, ownership, and the application shell.
4. Implement inspection creation, local direct-upload equivalent, job creation, and history.
5. Implement the Python worker with fixture inference, media validation, progress, retry classification, and artifact generation.
6. Implement the investigation player, Canvas overlays, filters, timeline, summaries, and exports.
7. Add production R2 and Cloud Tasks adapters plus dispatch reconciliation.
8. Deploy the two Cloud Run services with Neon, secrets, limits, logs, and alerts.
9. Run real Roboflow integration tests and benchmark the configured media envelope.
10. Polish responsive states, accessibility, sample data, documentation, and the public demonstration.

This order produces demonstrable end-to-end behavior early while preserving the same production contracts.

## 19. Decisions still required before scaffolding

The system architecture is settled. These product-level inputs remain:

- The concrete factory-inspection scenario and Roboflow Workflow.
- Exact prediction fields and event definitions.
- Supported browser recording formats.
- Final benchmarked upload, duration, resolution, and concurrency limits.
- Visual design tokens, typography, and responsive layouts.
- Retention duration for videos and prediction artifacts.
- Whether the public portfolio deployment permits arbitrary uploads or only invited accounts.

These choices refine contracts and policy; they do not require changing the approved component architecture.
