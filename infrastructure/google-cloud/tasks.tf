resource "google_cloud_tasks_queue" "processing" {
  project  = var.project_id
  name     = "factorylens-processing"
  location = var.region

  rate_limits {
    max_dispatches_per_second = var.task_max_dispatches_per_second
    max_concurrent_dispatches = var.task_max_concurrent_dispatches
  }

  retry_config {
    max_attempts       = var.max_processing_attempts
    max_retry_duration = "0s"
    min_backoff        = "10s"
    max_backoff        = "300s"
    max_doublings      = 3
  }

  stackdriver_logging_config {
    sampling_ratio = 1
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_tasks_queue_iam_member" "web_enqueuer" {
  project  = var.project_id
  location = google_cloud_tasks_queue.processing.location
  name     = google_cloud_tasks_queue.processing.name
  role     = "roles/cloudtasks.enqueuer"
  member   = google_service_account.web.member
}
