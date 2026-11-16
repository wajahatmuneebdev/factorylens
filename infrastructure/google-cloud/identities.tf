resource "google_service_account" "web" {
  project      = var.project_id
  account_id   = "factorylens-web"
  display_name = "FactoryLens web runtime"
  description  = "Runtime identity for the combined FactoryLens web and API service."
}

resource "google_service_account" "worker" {
  project      = var.project_id
  account_id   = "factorylens-worker"
  display_name = "FactoryLens worker runtime"
  description  = "Runtime identity for media processing; it has no Google API data access."
}

resource "google_service_account" "tasks" {
  project      = var.project_id
  account_id   = "factorylens-tasks"
  display_name = "FactoryLens Cloud Tasks caller"
  description  = "OIDC identity used only for Cloud Tasks calls to the private worker."
}

resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "factorylens-maintenance"
  display_name = "FactoryLens maintenance caller"
  description  = "OIDC identity used only for Cloud Scheduler maintenance calls."
}

resource "google_service_account_iam_member" "web_can_attach_tasks_identity" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.web.member
}

resource "google_service_account_iam_member" "cloud_tasks_can_attach_tasks_identity" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_project_service_identity.cloud_tasks.member
}
