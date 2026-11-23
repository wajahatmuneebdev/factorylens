# Production data services

This procedure creates and verifies the single Neon database and private
Cloudflare R2 bucket approved for FactoryLens. Provisioning is staged: prepare
the database and private bucket before Google Cloud, then configure browser
CORS and run the storage smoke check only after the reviewed application origin
serves the deployed Cloud Run service. Run commands from the repository root;
do not commit connection strings or credentials.

## Capacity and retention contract

Use these initial production limits together:

| Consumer             | Maximum instances | Connections per instance | Maximum clients |
| -------------------- | ----------------: | -----------------------: | --------------: |
| `factorylens-web`    |                 3 |    `DATABASE_POOL_MAX=5` |       15 pooled |
| `factorylens-worker` |                 1 | one connection at a time |        1 pooled |
| migration command    |      one operator |                        1 |        1 direct |

The 17-client upper bound leaves headroom for Neon administration and must be
recalculated before either Cloud Run maximum or `DATABASE_POOL_MAX` is raised.
The Cloud Tasks queue remains limited to one concurrent dispatch, matching the
single worker maximum.

The controlled Neon and Roboflow capacity run in
[`PROCESSING_ENVELOPE.md`](./PROCESSING_ENVELOPE.md) is the go-live gate for
this budget. A local media benchmark does not prove managed-service capacity.

Application maintenance deletes abandoned uploads after 24 hours and terminal
inspection rows and objects after 30 days. Configure
`MAINTENANCE_ABANDONED_UPLOAD_HOURS=24` and `MAINTENANCE_RETENTION_DAYS=30`.
R2 object-age expiration must remain disabled: object age is not terminal-state
age and could otherwise delete an active inspection too early. The checked R2
lifecycle rule only aborts incomplete multipart uploads after one day; the
maintenance transaction owns the approved terminal-retention policy.

## Neon

1. In the Neon production organization, create one project named
   `factorylens-production`, one production branch, and one database named
   `factorylens`. Select the region nearest the Cloud Run services. Replicas and
   additional branches are outside this deployment.
2. From Neon **Connection Details**, copy both connection strings for the same
   role and database:

   - `DATABASE_URL`: the pooled hostname containing `-pooler`; provide this to
     both services with `sslmode=require`.
   - `MIGRATION_DATABASE_URL`: the direct hostname without `-pooler`; expose it
     only to the migration job or operator, also with `sslmode=require`.

3. Keep the pooled URL ready for the web and worker Secret Manager entries, and
   keep the direct URL only for the protected GitHub production environment as
   `MIGRATION_DATABASE_URL`. Do not add the direct URL to either runtime.
4. Let the first protected deployment apply the reviewed migrations before it
   promotes a Cloud Run revision. After that deployment logs
   `database_migrations_applied`, inspect the Neon tables view for `users`,
   `sessions`, `inspections`, `jobs`, and the `drizzle` migration journal.

## Cloudflare R2

1. Before Google Cloud provisioning, create one Standard-class bucket named
   `factorylens-private` with the Eastern North America location hint and the
   default jurisdiction. Leave the public `r2.dev` URL disabled and do not
   attach a custom domain.
2. Create an **Object Read & Write** account token restricted to
   `factorylens-private` for the web/API and worker runtimes. Record the account
   ID, access key ID, and secret access key securely. The two services receive
   the runtime values later through separate Secret Manager entries as
   `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`; both also receive
   `R2_ACCOUNT_ID` and `R2_BUCKET=factorylens-private` as non-secret settings.
   Do not configure CORS yet.
3. After the full Terraform apply, export the reviewed `application_origin` as
   `APP_ORIGIN` and confirm `curl --fail --silent --show-error
   "$APP_ORIGIN/health"` succeeds. Use that deterministic URL as the canonical
   browser, R2 CORS, and Google OAuth origin. Terraform's `web_url` output can
   be Cloud Run's alternate stable service URL and does not need to be textually
   identical.
4. Create a temporary **Admin Read & Write** R2 token. Export its S3 credentials
   as `R2_CONFIGURATION_ACCESS_KEY_ID` and
   `R2_CONFIGURATION_SECRET_ACCESS_KEY`; also export `R2_ACCOUNT_ID`,
   `R2_BUCKET=factorylens-private`, and the confirmed HTTPS `APP_ORIGIN`. Run:

   ```sh
   npm run configure:r2 --workspace @factorylens/api
   ```

   This replaces bucket CORS with the checked GET/PUT policy for only
   `APP_ORIGIN` and installs the non-destructive lifecycle rule. Revoke the
   configuration token after the command succeeds.

5. With only the bucket-scoped runtime credentials exported, run:

   ```sh
   npm run smoke:r2 --workspace @factorylens/api
   ```

   The check writes a uniquely named disposable object, verifies anonymous
   access is denied, reads it through a short-lived signed URL, deletes it in a
   `finally` block, and confirms removal. It logs no credential, signed URL, or
   object key.

6. With the same bucket-scoped runtime credentials and local curl,
   FFmpeg/ffprobe, seed the shared prepared sample:

   ```sh
   npm run seed:sample --workspace @factorylens/api
   ```

   The command downloads the reviewed Wikimedia Commons source, verifies its
   published SHA-1, creates the two-second 1840×1080 VP9 derivative required by
   the inspection contract, validates its ten frames, and uploads it to the
   private sample key. The source is credited to Automotive garage under
   [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); its canonical
   record is [Assembly line.webm on Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Assembly_line.webm).
   Re-running the command safely replaces only that shared sample object.

## Deployment record

Record the Neon project and branch IDs, R2 bucket name, service maximums, and
the date and operator for the migration, R2 configuration, smoke, and sample
seed commands in the private deployment change record. Record secret resource
names, not secret values. Re-run the R2 configuration and smoke commands after
creating a new production environment or changing its application origin.
Reviewed database migrations continue to run through the protected deployment
workflow.
