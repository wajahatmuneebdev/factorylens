locals {
  web_environment = {
    APP_ORIGIN                             = var.application_origin
    CLOUD_TASKS_DISPATCH_DEADLINE_SECONDS  = tostring(var.task_dispatch_deadline_seconds)
    CLOUD_TASKS_LOCATION                   = var.region
    CLOUD_TASKS_MAX_ATTEMPTS               = tostring(var.max_processing_attempts)
    CLOUD_TASKS_MAX_BACKOFF_SECONDS        = "300"
    CLOUD_TASKS_MAX_CONCURRENT_DISPATCHES  = tostring(var.task_max_concurrent_dispatches)
    CLOUD_TASKS_MAX_DISPATCHES_PER_SECOND  = tostring(var.task_max_dispatches_per_second)
    CLOUD_TASKS_MAX_DOUBLINGS              = "3"
    CLOUD_TASKS_MAX_RETRY_DURATION_SECONDS = "0"
    CLOUD_TASKS_MIN_BACKOFF_SECONDS        = "10"
    CLOUD_TASKS_OIDC_AUDIENCE              = local.task_oidc_audience
    CLOUD_TASKS_PROJECT_ID                 = var.project_id
    CLOUD_TASKS_QUEUE                      = google_cloud_tasks_queue.processing.name
    CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL      = google_service_account.tasks.email
    CLOUD_TASKS_TARGET_URL                 = "${google_cloud_run_v2_service.worker.uri}/internal/tasks/process"
    DATABASE_POOL_MAX                      = "5"
    GOOGLE_OIDC_CLIENT_ID                  = var.google_oidc_client_id
    MAINTENANCE_ABANDONED_UPLOAD_HOURS     = "24"
    MAINTENANCE_BATCH_SIZE                 = "50"
    MAINTENANCE_DISPATCH_GRACE_SECONDS     = "300"
    MAINTENANCE_MAX_DURATION_SECONDS       = "50"
    MAINTENANCE_OIDC_AUDIENCE              = local.maintenance_oidc_audience
    MAINTENANCE_RETENTION_DAYS             = "30"
    MAINTENANCE_SERVICE_ACCOUNT_EMAIL      = google_service_account.scheduler.email
    MAX_ACTIVE_INSPECTIONS_PER_USER        = "3"
    MAX_PROCESSING_ATTEMPTS                = tostring(var.max_processing_attempts)
    MAX_UPLOAD_BYTES                       = "262144000"
    R2_ACCOUNT_ID                          = var.r2_account_id
    R2_BUCKET                              = var.r2_bucket
    TASK_DISPATCHER                        = "cloud-tasks"
  }

  worker_environment = {
    CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL = google_service_account.tasks.email
    MAX_MEDIA_DURATION_MS             = "300000"
    MAX_MEDIA_HEIGHT                  = "1080"
    MAX_MEDIA_WIDTH                   = "1920"
    MAX_UPLOAD_BYTES                  = "262144000"
    R2_ACCOUNT_ID                     = var.r2_account_id
    R2_BUCKET                         = var.r2_bucket
    WORKER_AUTH_MODE                  = "google"
    WORKER_OIDC_AUDIENCE              = local.task_oidc_audience
    WORKER_STORAGE_BACKEND            = "r2"
    WORKFLOW_CREDENTIAL_SOURCE        = "roboflow-api-key"
    WORKFLOW_ENDPOINT                 = var.workflow_endpoint
    WORKFLOW_FINGERPRINT              = lower(var.workflow_fingerprint)
    WORKFLOW_REQUEST_TIMEOUT_SECONDS  = "30"
    WORKFLOW_USE_CACHE                = "true"
    WORKFLOW_WORKSPACE                = var.workflow_workspace
  }
}

resource "google_cloud_run_v2_service" "worker" {
  project             = var.project_id
  name                = "factorylens-worker"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  custom_audiences    = [local.task_oidc_audience]
  deletion_protection = var.deletion_protection
  labels              = merge(local.labels, { service = "worker" })

  template {
    service_account                  = google_service_account.worker.email
    timeout                          = "${var.worker_timeout_seconds}s"
    max_instance_request_concurrency = var.worker_concurrency

    scaling {
      min_instance_count = var.worker_min_instances
      max_instance_count = var.worker_max_instances
    }

    containers {
      image = var.worker_image

      ports {
        name           = "http1"
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.worker_cpu
          memory = var.worker_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = local.worker_environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.worker_secret_environment
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.runtime[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 12

        http_get {
          path = "/health"
          port = 8080
        }
      }

      liveness_probe {
        timeout_seconds   = 3
        period_seconds    = 30
        failure_threshold = 3

        http_get {
          path = "/health"
          port = 8080
        }
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_iam_member.worker,
  ]
}

resource "google_cloud_run_v2_service" "web" {
  project             = var.project_id
  name                = "factorylens-web"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  custom_audiences    = [local.maintenance_oidc_audience]
  deletion_protection = var.deletion_protection
  labels              = merge(local.labels, { service = "web" })

  template {
    service_account                  = google_service_account.web.email
    timeout                          = "${var.web_timeout_seconds}s"
    max_instance_request_concurrency = var.web_concurrency

    scaling {
      min_instance_count = var.web_min_instances
      max_instance_count = var.web_max_instances
    }

    containers {
      image = var.web_image

      ports {
        name           = "http1"
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.web_cpu
          memory = var.web_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = local.web_environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.web_secret_environment
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.runtime[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 12

        http_get {
          path = "/health"
          port = 8080
        }
      }

      liveness_probe {
        timeout_seconds   = 3
        period_seconds    = 30
        failure_threshold = 3

        http_get {
          path = "/health"
          port = 8080
        }
      }
    }
  }

  depends_on = [
    google_cloud_tasks_queue_iam_member.web_enqueuer,
    google_secret_manager_secret_iam_member.web,
    google_service_account_iam_member.web_can_attach_tasks_identity,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = google_cloud_run_v2_service.web.location
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "worker_tasks_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_service.worker.location
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  member   = google_service_account.tasks.member
}

resource "google_cloud_run_v2_service_iam_member" "web_scheduler_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_service.web.location
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = google_service_account.scheduler.member
}
