# FactoryLens operations

FactoryLens uses structured service logs and the metrics already provided by
Cloud Run, Cloud Tasks, PostgreSQL maintenance queries, and Cloudflare R2. It
does not deploy a telemetry backend.

## Correlation contract

Every Node request receives a generated `requestId`, returned as
`X-Request-ID`. When an inspection creates or resets a job, its durable job UUID
becomes `correlationId`. The strict task body carries `correlationId`, `jobId`,
and `dispatchGeneration`; Cloud Tasks supplies `taskId` and delivery attempt
headers; the worker adds `inspectionId` and the durable database attempt after
it acquires the lease.

Searchable lifecycle events are:

- Node: `request_completed`, `job_ready_for_dispatch`, `task_dispatched`,
  `task_redispatched`, and `operational_snapshot`.
- Worker: `task_received`, `task_started`, `job_processing_failed`,
  `task_completed`, `task_duplicate_acknowledged`, and
  `job_heartbeat_failed`.

Only generated identifiers, safe error codes, counts, states, and timings are
logged. Request bodies, authorization headers, cookies, credentials, session
tokens, signed URLs, object keys, filenames, and prediction data are excluded.
Both logging implementations apply recursive key-based redaction as a final
guard. Unexpected exceptions log their type, not their message.

## Managed operational views

The checked-in Cloud Monitoring dashboard exposes:

- API and worker error counts, p95 latency, and Cloud Run instance use;
- Cloud Tasks queue depth and attempts grouped by outcome;
- oldest queued PostgreSQL job age and stale lease count from the scheduled
  maintenance snapshot.

Cloudflare remains the source for R2 storage growth. In the Cloudflare
dashboard, open **R2 > factorylens-private > Metrics** and graph `payloadSize`
and `objectCount` over 30 days. Investigate sustained growth after the configured
terminal-retention window. Keeping this view in R2 avoids copying a Cloudflare
credential into Google Cloud solely for monitoring.

The maintenance endpoint emits one `operational_snapshot` per scheduled run.
Its failed-job count covers the previous hour; queue age includes
`pending_dispatch`, `queued`, and `retry_wait`; stale leases are running jobs
whose lease expiry is in the past.

## Install the monitoring definitions

Run these commands with a Google Cloud identity allowed to manage Logging and
Monitoring. They intentionally are not part of application startup.

```sh
gcloud logging metrics update factorylens_oldest_queued_job_age_seconds \
  --config-from-file=operations/cloud-monitoring/log-metric-oldest-queued-job.json
gcloud logging metrics update factorylens_stale_lease_count \
  --config-from-file=operations/cloud-monitoring/log-metric-stale-leases.json
gcloud logging metrics update factorylens_task_retry_count \
  --config-from-file=operations/cloud-monitoring/log-metric-task-retries.json
gcloud monitoring dashboards create \
  --config-from-file=operations/cloud-monitoring/dashboard.json
for policy in operations/cloud-monitoring/alert-*.json; do
  gcloud monitoring policies create --policy-from-file="$policy"
done
```

Attach the production notification channel to the created policies before
relying on paging. The checked-in thresholds require repeated symptoms:

| Symptom              | Opens an incident when                               |
| -------------------- | ---------------------------------------------------- |
| API or worker errors | More than five 5xx responses occur in five minutes   |
| Task retries         | At least two retried deliveries occur in ten minutes |
| Oldest queued job    | Age stays above ten minutes for ten minutes          |
| Stale leases         | More than one stays stale for ten minutes            |

Thus one expected task retry or one lease recovered by maintenance does not
page. Review thresholds after production workload measurements; do not weaken
the application attempt limits to silence an alert.

## Trace a local failure end to end

Set the same high-entropy `LOCAL_WORKER_TASK_TOKEN` in both service environments,
use `TASK_DISPATCHER=local` for Node and `WORKER_AUTH_MODE=local` for the worker,
then capture the combined JSON stream:

```sh
npm run dev 2>&1 | tee /tmp/factorylens-local.jsonl
```

Local authentication is accepted only while the worker binds a loopback host;
production continues to require Google OIDC. Trigger an inspection whose
fixture or storage setup produces the failure being diagnosed, then:

1. Copy `X-Request-ID` from the initiating API response.
2. Find its request and dispatch events:

   ```sh
   rg '"requestId":"REQUEST_UUID"' /tmp/factorylens-local.jsonl
   ```

3. Copy `correlationId` from `task_dispatched` and follow it through the worker:

   ```sh
   rg '"correlationId":"JOB_UUID"' /tmp/factorylens-local.jsonl
   ```

The expected chain is `task_dispatched` → `task_received` → `task_started` →
`job_processing_failed` → `task_completed`. The last two events show the safe
error code, retry classification, durable job attempt, delivery attempt, and
worker outcome. A missing event identifies the boundary to inspect: dispatch,
delivery/authentication, lease acquisition, or processing.

In Cloud Logging, use the same filter without downloading logs:

```text
jsonPayload.correlationId="JOB_UUID"
```

## Recover the processing queue

Cloud Tasks may redeliver a task, and the worker lease makes that safe. Do not
manually mark database rows completed or create replacement tasks by hand.
Set `PROJECT_ID` and `REGION` in the operator's local shell before running the
commands below; do not store production values in this repository.

1. If repeated deliveries are causing damage, pause dispatch while leaving the
   durable queue intact:

   ```sh
   gcloud tasks queues pause factorylens-processing \
     --location "$REGION" --project "$PROJECT_ID"
   ```

2. Trace one correlation ID and fix the worker, credentials, provider, or
   storage problem. A normal retry remains bounded by the durable three-attempt
   limit.
3. Deploy the reviewed fix, then run maintenance once. Maintenance redispatches
   committed jobs whose task was never enqueued and recovers expired leases:

   ```sh
   gcloud scheduler jobs run factorylens-maintenance \
     --location "$REGION" --project "$PROJECT_ID"
   ```

4. Confirm `operational_snapshot` reports no unexpected stale lease, resume the
   queue, and watch its oldest-task age and retry count:

   ```sh
   gcloud tasks queues resume factorylens-processing \
     --location "$REGION" --project "$PROJECT_ID"
   ```

Terminal media failures require a user retry after the input is corrected.
Provider and storage failures enter the existing bounded retry path; operators
must not raise attempts to conceal a persistent failure.

## Roll back a Cloud Run release

Database migrations are forward-only in the deployment workflow. Before
routing traffic to an older revision, confirm that its code remains compatible
with the current schema. A schema rollback requires a separate reviewed change.

1. List Ready revisions and identify the last known-good web and worker pair:

   ```sh
   gcloud run revisions list --service factorylens-web \
     --region "$REGION" --project "$PROJECT_ID"
   gcloud run revisions list --service factorylens-worker \
     --region "$REGION" --project "$PROJECT_ID"
   ```

2. Route each service to its matching known-good revision:

   ```sh
   gcloud run services update-traffic factorylens-worker \
     --region "$REGION" --project "$PROJECT_ID" \
     --to-revisions WORKER_REVISION=100
   gcloud run services update-traffic factorylens-web \
     --region "$REGION" --project "$PROJECT_ID" \
     --to-revisions WEB_REVISION=100
   ```

3. Verify public web health, private worker ingress, Google sign-in, one
   prepared-sample inspection, and one owner-scoped result read. Keep or pause
   the processing queue according to the worker result.
4. Revert the faulty change in Git, run the normal validation workflow, and
   deploy that new immutable revision. Do not leave production on an unnamed
   manual state.

## Verify a public release

From a fresh clone, activate Node 24 and run:

```sh
npm ci
uv sync --project apps/worker --locked
npx playwright install chromium
npm run check
npm run test:e2e
npm run test:containers
```

Before calling a deployment ready, record the commit and image digests and
complete this production smoke checklist:

- The protected deployment workflow, migration, image scans, candidate checks,
  and promotion all succeeded for the same commit.
- Public `/health` succeeds; an unauthenticated private API call returns `401`;
  the worker task endpoint is not publicly invokable.
- Google sign-in and sign-out succeed at the canonical origin, and the displayed
  account name and email come from the authenticated user.
- The prepared sample completes with fixture Workflow provenance and consumes no
  live Roboflow request. An uploaded or recorded video completes with the pinned
  Roboflow Workflow provenance.
- Playback, annotations, filters, timeline, JSON export, and CSV export work for
  the inspection owner; a different account cannot access that inspection.
- Cancellation, eligible user retry, maintenance, queue recovery, and the
  30-day terminal-retention policy behave as documented.
- No credential, signed URL, session token, private media, prediction payload,
  or unsupported scale claim appears in the repository, logs, or release notes.

The public deployment accepts arbitrary valid media only after Google sign-in
and within the documented limits. Source videos and results are private to the
account and retained for up to 30 days; abandoned uploads expire after 24
hours. The prepared sample is redistributable under its recorded CC BY 4.0
attribution. Until the deployed capacity gate in `PROCESSING_ENVELOPE.md`
passes, describe FactoryLens as an evaluation release rather than a
production-scale service.
