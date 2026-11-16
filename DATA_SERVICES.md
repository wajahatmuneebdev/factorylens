# Production data services

This procedure creates and verifies the single Neon database and private
Cloudflare R2 bucket approved for FactoryLens. Run it from the repository root;
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

3. Apply the reviewed migrations through the direct endpoint:

   ```sh
   npm run db:migrate --workspace @factorylens/api
   ```

4. Confirm the command logs `database_migrations_applied`, then inspect the
   Neon tables view for `users`, `sessions`, `inspections`, `jobs`, and the
   `drizzle` migration journal. Remove `MIGRATION_DATABASE_URL` from the runtime
   service environment; application startup never uses it.

## Cloudflare R2

1. Create one bucket named `factorylens-private` in the production account.
   Leave the public `r2.dev` URL disabled and do not attach a custom domain.
2. Create two R2 API tokens:

   - a temporary **Admin Read & Write** token for bucket configuration;
   - an **Object Read & Write** token restricted to `factorylens-private` for
     the web/API and worker runtimes.

   Store only the runtime access key ID and secret in the two services as
   `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Set `R2_ACCOUNT_ID` and
   `R2_BUCKET=factorylens-private` alongside them.

3. Temporarily export the configuration token as
   `R2_CONFIGURATION_ACCESS_KEY_ID` and
   `R2_CONFIGURATION_SECRET_ACCESS_KEY`, export the HTTPS `APP_ORIGIN`, and run:

   ```sh
   npm run configure:r2 --workspace @factorylens/api
   ```

   This replaces bucket CORS with the checked GET/PUT policy for only
   `APP_ORIGIN` and installs the non-destructive lifecycle rule. Revoke the
   configuration token after the command succeeds.

4. With only the bucket-scoped runtime credentials exported, run:

   ```sh
   npm run smoke:r2 --workspace @factorylens/api
   ```

   The check writes a uniquely named disposable object, verifies anonymous
   access is denied, reads it through a short-lived signed URL, deletes it in a
   `finally` block, and confirms removal. It logs no credential, signed URL, or
   object key.

## Deployment record

Record the Neon project and branch IDs, R2 bucket name, service maximums, and
the date and operator for the migration, R2 configuration, and smoke commands
in the private deployment change record. Record secret resource names, not
secret values. Re-run the migration and both R2 commands after creating a new
production environment or changing its application origin.
