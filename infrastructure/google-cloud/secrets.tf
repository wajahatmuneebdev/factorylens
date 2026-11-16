resource "google_secret_manager_secret" "runtime" {
  for_each = local.runtime_secrets

  project   = var.project_id
  secret_id = "factorylens-${each.key}"
  labels    = merge(local.labels, { service = each.value })

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_iam_member" "web" {
  for_each = toset(values(local.web_secret_environment))

  project   = var.project_id
  secret_id = google_secret_manager_secret.runtime[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.web.member
}

resource "google_secret_manager_secret_iam_member" "worker" {
  for_each = toset(values(local.worker_secret_environment))

  project   = var.project_id
  secret_id = google_secret_manager_secret.runtime[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.worker.member
}
