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
The repository includes the initial React, Node API, shared TypeScript contract,
and Python worker scaffolding. Product features have not been implemented yet.

## Development

The JavaScript workspace uses npm. Use Node.js 24 (the version is recorded in
`.nvmrc`), Python 3.12 or newer, and [uv](https://docs.astral.sh/uv/).

Install both workspaces from a clean checkout:

```sh
npm ci
uv sync --project apps/worker --locked
```

Start every placeholder service together with `npm run dev`, or start one at a
time with `npm run dev:web`, `npm run dev:api`, or `npm run dev:worker`.

| Component | Default address | Health behavior |
| --- | --- | --- |
| React app | `http://127.0.0.1:5173` | Renders `Health: ok` |
| Express API | `http://127.0.0.1:3000/health` | Returns a JSON health response |
| Python worker | `http://127.0.0.1:8000/health` | Returns a JSON health response |

No environment variable is required for the placeholder services. The
credential-free `.env.example` file in each application documents the optional
host and port overrides. Export those variables in the shell before starting a
service; Vite also reads `apps/web/.env` when present.

The root commands apply consistently across the npm and uv workspaces:

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the TypeScript packages and applications |
| `npm run typecheck` | Type-check TypeScript and Python |
| `npm run lint` | Lint TypeScript, Markdown, and Python |
| `npm run format` | Format TypeScript, JSON, and Python |
| `npm run format:check` | Check formatting without changing files |
| `npm test` | Run the TypeScript and Python placeholder tests |
| `npm run check` | Run every clean-checkout verification command |

## Documentation

Technical decisions and implementation boundaries are documented in
[ARCHITECTURE.md](./ARCHITECTURE.md).

The first recorded-video scenario, Workflow boundary, prediction schema, event
rules, sample media, and initial policy candidates are documented in
[INSPECTION_CONTRACT.md](./INSPECTION_CONTRACT.md).
