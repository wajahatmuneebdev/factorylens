# FactoryLens

FactoryLens helps people inspect recorded factory video. A user can upload or
record a video, let FactoryLens analyze it, and investigate the results through
synchronized visual annotations, a timeline, filters, summaries, and exports.

The product is intentionally focused on video inspection rather than being a
general-purpose computer-vision platform.

## User flow

1. Sign in with Google.
2. Upload or record a video, or select a prepared sample.
3. Follow upload and processing progress.
4. Open the completed inspection.
5. Play the video with synchronized visual annotations.
6. Filter results and inspect timeline events and summaries.
7. Export structured results as JSON or CSV.

## Project status

Product planning, the first inspection contract, and architecture are complete.
The repository now has a runnable service workspace, versioned application
contracts, a PostgreSQL schema and migration, a responsive application shell,
compatible local storage adapters, and an in-process development task
dispatcher. A production Cloud Tasks adapter now provides durable,
rate-controlled, OIDC-authenticated worker dispatch. The Python worker also has
a validated internal task endpoint, atomic PostgreSQL job leases, a
provider-neutral Workflow boundary, deterministic fixture inference for the
prepared sample, and a production Roboflow Workflow adapter for Cloud or a
compatible self-hosted Inference endpoint. Its bounded media-validation stage
now inspects source bytes with ffprobe, passes compatible media through, and
uses bounded FFmpeg normalization only for incompatible input. The worker can
also build deterministic gzip prediction artifacts and atomically commit their
small summaries under the current job lease. Its task endpoint now runs the
full media, Workflow, and artifact pipeline inside the durable delivery,
publishes lease-protected progress and heartbeats, observes cancellation, and
applies bounded retries without repeating completed work. Google sign-in,
FactoryLens sessions, and owner-scoped inspection access boundaries are
connected, as are inspection creation, history, detail, verified upload
completion, durable job creation, and post-commit task dispatch. Direct upload
authorization and private artifact access are connected. The
committed prediction artifact is now available as its versioned JSON export,
and owner-scoped CSV export streams stable per-prediction columns. The
result-investigation interface is not connected yet. Owner-scoped cancellation
and retry commands are also connected. A bounded, service-authenticated
maintenance endpoint now reconciles pending dispatch, stale leases, abandoned
uploads, and expired terminal inspection data.

## Development

The JavaScript workspace uses npm. Use Node.js 24 (the version is recorded in
`.nvmrc`), Python 3.12 or newer, and [uv](https://docs.astral.sh/uv/).

Install both workspaces from a clean checkout:

```sh
npm ci
uv sync --project apps/worker --locked
```

Start every local service together with `npm run dev`, or start one at a
time with `npm run dev:web`, `npm run dev:api`, or `npm run dev:worker`.

| Component     | Default address                | Current behavior                 |
| ------------- | ------------------------------ | -------------------------------- |
| React app     | `http://127.0.0.1:5173`        | Renders the application shell    |
| Express API   | `http://127.0.0.1:3000/health` | Returns a JSON health response   |
| Python worker | `http://127.0.0.1:8000/health` | Health and internal task leasing |

The API and worker require PostgreSQL and private R2 bucket credentials scoped
to that bucket. The API also requires Google OIDC credentials, its public
application origin, and a high-entropy auth cookie secret. The credential-free
`.env.example` files document the required names, optional host and port
overrides, the worker's fixture Workflow endpoint, and the opt-in Roboflow
adapter settings. Export those variables in the shell before starting a
service; Vite also reads `apps/web/.env` when present. The standard test suite
uses fixture inference. Set `RUN_ROBOFLOW_INTEGRATION=1` with the documented
worker Workflow settings and run
`uv run --project apps/worker pytest -m roboflow_integration` to exercise the
selected deployed Workflow. Run
`npm run configure:r2 --workspace @factorylens/api` with the API environment to
restrict browser access to the configured application origin. The test database
variable described below is required only for its opt-in integration test. Set
`TASK_DISPATCHER=cloud-tasks` in production and run
`npm run configure:tasks --workspace @factorylens/api` with deployment
credentials to apply the configured rate, concurrency, and retry limits to an
already-provisioned queue.

Worker progress uses stable stage names: `validating_media` begins at 5%,
`running_workflow` begins at 30% and advances to 90%, `writing_artifact` begins
at 95%, and the atomic result commit records `completed` at 100%. Heartbeats
renew the current lease without advancing progress. A cancellation or lost
lease stops later stage commits; transient provider or storage failures enter
bounded `retry_wait`, while terminal media failures and exhausted attempts are
acknowledged after their safe failure is persisted.

The root commands apply consistently across the npm and uv workspaces:

| Command                | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `npm run build`        | Build the TypeScript packages and applications     |
| `npm run typecheck`    | Type-check TypeScript and Python                   |
| `npm run lint`         | Lint TypeScript, Markdown, and Python              |
| `npm run format`       | Format TypeScript, JSON, and Python                |
| `npm run format:check` | Check formatting without changing files            |
| `npm test`             | Run the standard TypeScript and Python tests       |
| `npm run check`        | Run the standard clean-checkout verification suite |

The PostgreSQL migration integration test is separate because it requires an
empty disposable database. Set `TEST_DATABASE_URL` and run
`npm run test:integration --workspace @factorylens/api` for database schema or
migration changes.

## Documentation

Technical decisions and implementation boundaries are documented in
[ARCHITECTURE.md](./ARCHITECTURE.md).

The first recorded-video scenario, Workflow boundary, prediction schema, event
rules, sample media, and initial policy candidates are documented in
[INSPECTION_CONTRACT.md](./INSPECTION_CONTRACT.md).
