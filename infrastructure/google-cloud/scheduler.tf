resource "google_cloud_scheduler_job" "maintenance" {
  project          = var.project_id
  region           = var.region
  name             = "factorylens-maintenance"
  description      = "Run bounded FactoryLens dispatch, lease, upload, and retention reconciliation."
  schedule         = var.maintenance_schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "60s"

  retry_config {
    retry_count          = 1
    min_backoff_duration = "10s"
    max_backoff_duration = "30s"
    max_doublings        = 1
  }

  http_target {
    uri         = "${google_cloud_run_v2_service.web.uri}/internal/maintenance/reconcile"
    http_method = "POST"
    body        = base64encode("{}")

    headers = {
      "Content-Type" = "application/json"
    }

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.maintenance_oidc_audience
    }
  }

  depends_on = [
    google_cloud_run_v2_service_iam_member.web_scheduler_invoker,
    google_project_iam_member.cloud_scheduler_service_agent,
  ]
}
