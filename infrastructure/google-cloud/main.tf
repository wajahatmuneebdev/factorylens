locals {
  labels = {
    application = "factorylens"
    environment = "production"
    managed-by  = "terraform"
  }

  enabled_services = toset([
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "cloudtasks.googleapis.com",
    "containerscanning.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "sts.googleapis.com",
  ])

  web_secret_environment = {
    AUTH_COOKIE_SECRET        = "web-auth-cookie-secret"
    DATABASE_URL              = "web-database-url"
    GOOGLE_OIDC_CLIENT_SECRET = "web-google-oidc-client-secret"
    R2_ACCESS_KEY_ID          = "web-r2-access-key-id"
    R2_SECRET_ACCESS_KEY      = "web-r2-secret-access-key"
  }

  worker_secret_environment = {
    DATABASE_URL         = "worker-database-url"
    R2_ACCESS_KEY_ID     = "worker-r2-access-key-id"
    R2_SECRET_ACCESS_KEY = "worker-r2-secret-access-key"
    ROBOFLOW_API_KEY     = "worker-roboflow-api-key"
  }

  runtime_secrets = merge(
    { for environment_name, secret_id in local.web_secret_environment : secret_id => "web" },
    { for environment_name, secret_id in local.worker_secret_environment : secret_id => "worker" },
  )

  task_oidc_audience        = "https://factorylens-worker.internal"
  maintenance_oidc_audience = "https://factorylens-maintenance.internal"
}

data "google_project" "current" {
  project_id = var.project_id

  depends_on = [google_project_service.required]
}

resource "google_project_service" "required" {
  for_each = local.enabled_services

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_project_service_identity" "cloud_tasks" {
  provider = google-beta

  project = var.project_id
  service = "cloudtasks.googleapis.com"

  depends_on = [google_project_service.required]
}

resource "google_project_service_identity" "cloud_scheduler" {
  provider = google-beta

  project = var.project_id
  service = "cloudscheduler.googleapis.com"

  depends_on = [google_project_service.required]
}

resource "google_project_iam_member" "cloud_tasks_service_agent" {
  project = var.project_id
  role    = "roles/cloudtasks.serviceAgent"
  member  = google_project_service_identity.cloud_tasks.member
}

resource "google_project_iam_member" "cloud_scheduler_service_agent" {
  project = var.project_id
  role    = "roles/cloudscheduler.serviceAgent"
  member  = google_project_service_identity.cloud_scheduler.member
}
