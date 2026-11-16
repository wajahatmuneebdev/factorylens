output "web_url" {
  description = "Default Cloud Run URL for the public web/API service."
  value       = google_cloud_run_v2_service.web.uri
}

output "worker_url" {
  description = "Default internal Cloud Run URL used by Cloud Tasks."
  value       = google_cloud_run_v2_service.worker.uri
}

output "service_accounts" {
  description = "Dedicated runtime and caller identities."
  value = {
    web         = google_service_account.web.email
    worker      = google_service_account.worker.email
    tasks       = google_service_account.tasks.email
    maintenance = google_service_account.scheduler.email
  }
}

output "runtime_secret_ids" {
  description = "Secret Manager containers that require an initial version before full apply."
  value       = { for key, secret in google_secret_manager_secret.runtime : key => secret.secret_id }
}

output "task_queue" {
  description = "Cloud Tasks processing queue resource name."
  value       = google_cloud_tasks_queue.processing.id
}

output "budget_name" {
  description = "Project-scoped billing budget resource name."
  value       = google_billing_budget.production.name
}
