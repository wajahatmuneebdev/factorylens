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

| Symptom | Opens an incident when |
| --- | --- |
| API or worker errors | More than five 5xx responses occur in five minutes |
| Task retries | At least two retried deliveries occur in ten minutes |
| Oldest queued job | Age stays above ten minutes for ten minutes |
| Stale leases | More than one stays stale for ten minutes |

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
