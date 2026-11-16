resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "factorylens-deployer"
  display_name = "FactoryLens GitHub deployer"
  description  = "Keyless identity used only by the protected production deployment workflow."
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "factorylens-github"
  display_name              = "FactoryLens GitHub Actions"
  description               = "Accepts identities only from the reviewed FactoryLens main-branch deployment workflow."

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "factorylens-production"
  display_name                       = "FactoryLens production workflow"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    "attribute.workflow"   = "assertion.job_workflow_ref"
  }

  attribute_condition = join(" && ", [
    "assertion.repository == '${var.github_repository}'",
    "assertion.ref == 'refs/heads/${var.github_deployment_branch}'",
    "assertion.job_workflow_ref == '${var.github_repository}/.github/workflows/deploy.yml@refs/heads/${var.github_deployment_branch}'",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_deployer" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

resource "google_project_iam_member" "deployer_cloud_run" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = google_service_account.deployer.member
}

resource "google_service_account_iam_member" "deployer_can_use_web_identity" {
  service_account_id = google_service_account.web.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}

resource "google_service_account_iam_member" "deployer_can_use_worker_identity" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}
