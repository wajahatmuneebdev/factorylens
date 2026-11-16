# Google Cloud production infrastructure

This Terraform root provisions the Google-managed FactoryLens execution path:
two Cloud Run services, one Cloud Tasks queue, one Cloud Scheduler job, runtime
secrets, four dedicated service accounts, least-privilege IAM, and a
project-scoped billing budget. Neon and R2 remain governed by
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
Google Cloud project, immutable web and worker images, and the completed data
service procedure. Configure a protected remote Terraform backend before using
this root from automation; backend creation is intentionally outside the
application stack.

Copy the non-secret example and set its placeholders:

```sh
cd infrastructure/google-cloud
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
```

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
