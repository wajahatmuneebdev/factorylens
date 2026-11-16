# Google Cloud production infrastructure

This Terraform root provisions the Google-managed FactoryLens execution path:
two Cloud Run services, one Cloud Tasks queue, one Cloud Scheduler job, runtime
secrets, a Docker Artifact Registry repository, dedicated runtime and delivery
service accounts, least-privilege IAM, GitHub workload identity federation, and
a project-scoped billing budget. Neon and R2 remain governed by
[`DATA_SERVICES.md`](../../DATA_SERVICES.md).

## Security and capacity contract

- `factorylens-web` allows unauthenticated network invocation because it serves
  the application and sign-in routes. FactoryLens sessions and owner-scoped
  queries still protect private operations in the application.
- `factorylens-worker` uses internal-only ingress. Only the
  `factorylens-tasks` identity has `roles/run.invoker`, and the worker verifies
  that identity and the configured OIDC audience again in application code.
- The public web service's maintenance route verifies the distinct
  `factorylens-maintenance` identity and audience. Browser sessions are not
  accepted on the route.
- Web and worker revisions have different runtime identities, secrets,
  resources, concurrency, timeouts, and scaling limits. The conservative
  defaults preserve the documented maximum of three web instances and one
  single-request worker instance.
- The web identity can enqueue only on the processing queue and act as only the
  task caller identity. Runtime identities can access only their own Secret
  Manager entries. Terraform creates no service-account key.
- The GitHub deployer can write only to the FactoryLens Artifact Registry
  repository, update Cloud Run services, and act as only the two runtime
  identities. Its workload identity provider accepts tokens only from the
  configured repository, `main` branch, and checked `deploy.yml` workflow.
- Artifact Registry rejects mutable tags and enables Google container scanning.
  The deployment also blocks on HIGH or CRITICAL findings from its pinned image
  scanner before any migration or Cloud Run update.
- The queue's one-task concurrency, three attempts, 10–300 second backoff, and
  30-minute deadline match the API and worker environment contract. The worker
  timeout cannot be configured below the task deadline.
- The billing budget alerts at 50%, 80%, and 100% actual spend and 100%
  forecasted spend. It complements, but does not automatically shut down, the
  conservative Cloud Run and queue caps.

Cloud Tasks and Scheduler use the default `run.app` URLs so Google recognizes
their requests as internal ingress. Stable custom audiences avoid coupling
application token validation to generated service hostnames.

## Apply

Prerequisites are Terraform 1.9 or newer, Application Default Credentials with
permission to manage the listed resources and billing budget, a billing-enabled
Google Cloud project, and the completed data service procedure. Configure a
protected remote Terraform backend before using this root from automation;
backend creation is intentionally outside the application stack.

Copy the non-secret example and set its placeholders:

```sh
cd infrastructure/google-cloud
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
```

The first full apply needs immutable image references, while the Artifact
Registry repository does not exist until Terraform creates it. Bootstrap only
that repository, then build and push the initial images with the same checked
build script used by automation:

```sh
terraform apply -target=google_artifact_registry_repository.images

cd ../..
project_id=factorylens-production
region=us-central1
repository="${region}-docker.pkg.dev/$project_id/factorylens"
image_version="bootstrap-$(git rev-parse HEAD)"

gcloud auth configure-docker "${region}-docker.pkg.dev"
IMAGE_VERSION="$image_version" npm run build:images
docker tag "factorylens-web:$image_version" "$repository/web:$image_version"
docker tag "factorylens-worker:$image_version" "$repository/worker:$image_version"
docker push "$repository/web:$image_version"
docker push "$repository/worker:$image_version"
```

Resolve both uploaded tags to digests with `gcloud artifacts docker images
describe`, put those `repository/image@sha256:...` values in `web_image` and
`worker_image`, and return to `infrastructure/google-cloud`. This bootstrap uses
the operator's short-lived Application Default Credentials, not a
service-account key. All later application image delivery uses the protected
GitHub workflow.

Secret payloads are deliberately excluded from Terraform variables and state.
Bootstrap the Secret Manager containers first:

```sh
terraform apply -target='google_secret_manager_secret.runtime'
```

Add one current version to every secret shown by
`terraform output runtime_secret_ids`. Use `gcloud secrets versions add
SECRET_ID --data-file=-` so values do not appear in command arguments or shell
history. The required payload mapping is:

| Secret suffix                   | Payload                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `web-auth-cookie-secret`        | High-entropy FactoryLens cookie secret, at least 32 characters |
| `web-database-url`              | Neon pooled runtime URL                                        |
| `web-google-oidc-client-secret` | Google OAuth client secret                                     |
| `web-r2-access-key-id`          | Bucket-scoped R2 runtime access key ID                         |
| `web-r2-secret-access-key`      | Bucket-scoped R2 runtime secret access key                     |
| `worker-database-url`           | Neon pooled runtime URL                                        |
| `worker-r2-access-key-id`       | Bucket-scoped R2 runtime access key ID                         |
| `worker-r2-secret-access-key`   | Bucket-scoped R2 runtime secret access key                     |
| `worker-roboflow-api-key`       | Production Roboflow credential                                 |

Web and worker have separate Secret Manager resources even where the initial
payload is shared. Rotate each service independently and keep the migration-only
database URL outside both runtime services.

After all secret versions exist, create and review the complete plan, then
apply it:

```sh
terraform plan -out=factorylens.tfplan
terraform apply factorylens.tfplan
```

Do not commit the plan, local state, `terraform.tfvars`, credentials, or secret
payloads. Record resource names and the apply operator/date in the private
deployment change record.

## GitHub Actions delivery

The `Validation` workflow runs on every pull request and `main` push. One job
runs formatting, linting, TypeScript and Python checks, unit and contract tests,
the PostgreSQL migration integration test, deterministic Playwright tests, and
Terraform formatting and validation. The production workflow is triggered only
after that workflow succeeds for `main`.

After the first Terraform apply, create a protected GitHub environment named
`production`. Require reviewers and prevent administrators from bypassing its
protection. Configure these environment values:

| Kind     | Name                             | Value                                      |
| -------- | -------------------------------- | ------------------------------------------ |
| Variable | `GCP_PROJECT_ID`                 | Terraform `project_id`                     |
| Variable | `GCP_REGION`                     | Terraform `region`                         |
| Variable | `GCP_WORKLOAD_IDENTITY_PROVIDER` | `github_workload_identity_provider` output |
| Variable | `GCP_DEPLOY_SERVICE_ACCOUNT`     | `github_deployer_service_account` output   |
| Secret   | `MIGRATION_DATABASE_URL`         | Direct, non-pooler Neon production URL     |

Protect `main` with the `Application, contracts, browser, and infrastructure`
check and require reviewed pull requests. GitHub stores no Google
service-account key: the workflow exchanges its short-lived GitHub OIDC token
only when its repository, ref, and workflow claims match the Terraform
provider condition. Keep the migration URL only in the protected environment;
the workflow passes it to the single migration command and neither runtime
service receives it.

For each validated revision, the deployment workflow:

1. builds the web and worker images once with the full commit SHA;
2. pushes immutable tags, resolves their digests, and scans both digests;
3. runs the reviewed migrations through the direct Neon endpoint;
4. creates separate no-traffic web and worker candidate revisions without
   changing their Terraform-owned runtime configuration;
5. requires both startup/readiness probes, the web `/health` response, and the
   worker's private-ingress boundary before assigning production traffic; and
6. verifies the promoted web health endpoint and writes the images and result
   to the GitHub Actions job summary.

A validation, scan, migration, or candidate smoke failure prevents promotion.
The workflow deliberately does not perform automatic rollback, create preview
environments, or deploy to another cloud.

## Post-apply checks

1. Confirm `web_url/health` is publicly reachable and an unauthenticated private
   API call returns `401`.
2. Confirm a public request to `worker_url/internal/tasks/process` is rejected.
3. Run the Scheduler job once and verify one authenticated maintenance snapshot
   in Cloud Logging.
4. Create a prepared-sample inspection and verify the queue dispatches exactly
   one authenticated worker request with the configured deadline.
5. Confirm the budget lists the project and reviewed notification recipients.

Terraform owns the production queue configuration. Do not run the application's
`configure:tasks` helper against this queue because it would create unmanaged
configuration drift.
