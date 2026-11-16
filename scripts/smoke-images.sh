#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_revision=$(git -C "$repository_root" rev-parse HEAD)
image_version=${IMAGE_VERSION:-smoke-$source_revision}
run_id=$$
network_name="factorylens-smoke-$run_id"
storage_volume="factorylens-smoke-storage-$run_id"
postgres_name="factorylens-smoke-postgres-$run_id"
web_name="factorylens-smoke-web-$run_id"
worker_name="factorylens-smoke-worker-$run_id"
web_image="factorylens-web:$image_version"
worker_image="factorylens-worker:$image_version"
inspection_id=22222222-2222-4222-8222-222222222222
job_id=018f4f72-3d3a-7c1c-b10b-f2a7c849e831
task_token=smoke-worker-token-with-at-least-32-characters

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker logs "$web_name" 2>/dev/null || true
    docker logs "$worker_name" 2>/dev/null || true
    docker logs "$postgres_name" 2>/dev/null || true
  fi
  docker rm --force "$web_name" "$worker_name" "$postgres_name" >/dev/null 2>&1 || true
  docker volume rm "$storage_volume" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM

IMAGE_VERSION=$image_version "$repository_root/scripts/build-images.sh"

docker image inspect "$web_image" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}} {{.Config.User}}' |
  grep -Fx "$source_revision node" >/dev/null
docker image inspect "$worker_image" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}} {{.Config.User}}' |
  grep -Fx "$source_revision factorylens" >/dev/null
docker run --rm --entrypoint ffmpeg "$worker_image" -version >/dev/null
docker run --rm --entrypoint ffprobe "$worker_image" -version >/dev/null

docker network create "$network_name" >/dev/null
docker volume create "$storage_volume" >/dev/null
docker run --detach \
  --name "$postgres_name" \
  --network "$network_name" \
  --env POSTGRES_DB=factorylens \
  --env POSTGRES_PASSWORD=factorylens \
  --env POSTGRES_USER=factorylens \
  postgres:18.1-bookworm@sha256:cc9f4143a8d2fa8cf3749d0cb4d26ecf2d53a77a2ac807e9ebd67ae22426221a >/dev/null

attempt=0
until docker exec "$postgres_name" pg_isready --username factorylens --dbname factorylens >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "PostgreSQL did not become ready" >&2
    exit 1
  fi
  sleep 1
done

docker exec --interactive "$postgres_name" \
  psql --username factorylens --dbname factorylens --set ON_ERROR_STOP=1 \
  < "$repository_root/apps/api/drizzle/0000_tranquil_siren.sql" >/dev/null
docker exec --interactive "$postgres_name" \
  psql --username factorylens --dbname factorylens --set ON_ERROR_STOP=1 \
  < "$repository_root/apps/api/drizzle/0001_complex_the_hood.sql" >/dev/null
docker exec --interactive "$postgres_name" \
  psql --username factorylens --dbname factorylens --set ON_ERROR_STOP=1 >/dev/null <<SQL
insert into users (id, google_subject, email, display_name)
values ('11111111-1111-4111-8111-111111111111', 'smoke-user', 'smoke@example.com', 'Smoke User');
insert into inspections (
  id, owner_user_id, title, status, source_type, workflow_key,
  source_object_key, declared_file_name, declared_content_type,
  declared_size_bytes, queued_at
) values (
  '$inspection_id', '11111111-1111-4111-8111-111111111111',
  'Container smoke fixture', 'queued', 'sample', 'factory-safety-v1',
  'inspections/$inspection_id/source', 'fixture.mp4', 'video/mp4', 1, now()
);
insert into jobs (
  id, inspection_id, status, stage, max_attempts, dispatch_generation,
  task_enqueued_at
) values (
  '$job_id', '$inspection_id', 'queued', 'queued', 3, 1, now()
);
SQL

docker run --rm --user 0 \
  --mount "source=$storage_volume,target=/storage" \
  --entrypoint sh "$worker_image" -c \
  "mkdir -p /storage/inspections/$inspection_id && ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i color=c=navy:s=1840x1080:r=5:d=2 -c:v libx264 -pix_fmt yuv420p -f mp4 /storage/inspections/$inspection_id/source && chmod -R a+rwX /storage"

docker run --detach \
  --name "$web_name" \
  --network "$network_name" \
  --env APP_ORIGIN=https://factorylens.example \
  --env AUTH_COOKIE_SECRET=smoke-cookie-secret-with-at-least-32-characters \
  --env CLOUD_TASKS_LOCATION=us-central1 \
  --env CLOUD_TASKS_PROJECT_ID=factorylens-smoke \
  --env CLOUD_TASKS_QUEUE=factorylens-smoke \
  --env CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL=factorylens-tasks@example.iam.gserviceaccount.com \
  --env CLOUD_TASKS_TARGET_URL=https://factorylens-worker.example/internal/tasks/process \
  --env DATABASE_URL=postgresql://factorylens:factorylens@$postgres_name:5432/factorylens \
  --env GOOGLE_OIDC_CLIENT_ID=smoke-client \
  --env GOOGLE_OIDC_CLIENT_SECRET=smoke-secret \
  --env MAINTENANCE_OIDC_AUDIENCE=https://factorylens.example/internal/maintenance/reconcile \
  --env MAINTENANCE_SERVICE_ACCOUNT_EMAIL=factorylens-maintenance@example.iam.gserviceaccount.com \
  --env R2_ACCESS_KEY_ID=smoke-access-key \
  --env R2_ACCOUNT_ID=00000000000000000000000000000000 \
  --env R2_BUCKET=factorylens-smoke \
  --env R2_SECRET_ACCESS_KEY=smoke-secret-key \
  "$web_image" >/dev/null

docker run --detach \
  --name "$worker_name" \
  --network "$network_name" \
  --mount "source=$storage_volume,target=/storage" \
  --env DATABASE_URL=postgresql://factorylens:factorylens@$postgres_name:5432/factorylens \
  --env LOCAL_STORAGE_ROOT=/storage \
  --env LOCAL_WORKER_TASK_TOKEN=$task_token \
  --env WORKER_AUTH_MODE=local \
  --env WORKER_HOST=127.0.0.1 \
  --env WORKER_STORAGE_BACKEND=filesystem \
  --env WORKFLOW_ENDPOINT=fixture://assembly-line-no-hard-hat \
  "$worker_image" >/dev/null

attempt=0
until docker exec "$web_name" node -e \
  "fetch('http://127.0.0.1:8080/health').then(async r=>{if(!r.ok)process.exit(1);const b=await r.json();if(b.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 45 ]; then
    echo "Web image did not become healthy" >&2
    exit 1
  fi
  sleep 1
done
docker exec "$web_name" node -e \
  "fetch('http://127.0.0.1:8080/').then(async r=>{const b=await r.text();if(!r.ok||!b.includes('id=\"root\"'))process.exit(1)}).catch(()=>process.exit(1))"

attempt=0
until docker exec "$worker_name" python -c \
  "import json,urllib.request; body=json.load(urllib.request.urlopen('http://127.0.0.1:8080/health')); assert body == {'service':'worker','status':'ok'}"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Worker image did not become healthy" >&2
    exit 1
  fi
  sleep 1
done

docker exec "$worker_name" python -c \
  "import json,urllib.request; body=json.dumps({'correlationId':'$job_id','jobId':'$job_id','dispatchGeneration':1}).encode(); request=urllib.request.Request('http://127.0.0.1:8080/internal/tasks/process',data=body,headers={'Authorization':'Bearer $task_token','Content-Type':'application/json'},method='POST'); response=urllib.request.urlopen(request,timeout=60); assert response.status == 204"

job_result=$(docker exec "$postgres_name" psql --username factorylens --dbname factorylens --tuples-only --no-align --command "select status || '|' || coalesce(error_code, '') || '|' || coalesce(error_message, '') from jobs where id = '$job_id'")
if [ "$job_result" != "completed||" ]; then
  echo "Worker fixture job did not complete: $job_result" >&2
  exit 1
fi
docker run --rm \
  --mount "source=$storage_volume,target=/storage,readonly" \
  --entrypoint test "$worker_image" \
  -s "/storage/inspections/$inspection_id/generations/1/prediction"

docker stop --time 10 "$web_name" "$worker_name" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$web_name")" = 0
test "$(docker inspect --format '{{.State.ExitCode}}' "$worker_name")" = 0

echo "Container smoke test passed for $web_image and $worker_image"
