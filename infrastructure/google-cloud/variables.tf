variable "project_id" {
  description = "Google Cloud project that owns the production resources."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid Google Cloud project ID."
  }
}

variable "region" {
  description = "Region shared by Cloud Run, Cloud Tasks, and Cloud Scheduler."
  type        = string
  default     = "us-central1"
}

variable "github_repository" {
  description = "GitHub owner/repository allowed to deploy through workload identity federation."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must use the owner/repository format."
  }
}

variable "github_deployment_branch" {
  description = "Only this GitHub branch may exchange an identity for the production deployer."
  type        = string
  default     = "main"

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.github_deployment_branch))
    error_message = "github_deployment_branch must be a valid non-empty branch name."
  }
}

variable "billing_account_id" {
  description = "Billing account ID used for the project-scoped budget."
  type        = string

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", upper(var.billing_account_id)))
    error_message = "billing_account_id must use the 000000-000000-000000 format."
  }
}

variable "monthly_budget_usd" {
  description = "Initial monthly budget in whole US dollars. Alerts fire at 50%, 80%, and 100%."
  type        = number
  default     = 100

  validation {
    condition     = var.monthly_budget_usd >= 1 && floor(var.monthly_budget_usd) == var.monthly_budget_usd
    error_message = "monthly_budget_usd must be a positive whole-dollar amount."
  }
}

variable "budget_notification_channels" {
  description = "Optional Cloud Monitoring notification channel resource names for budget updates."
  type        = list(string)
  default     = []
}

variable "web_image" {
  description = "Immutable Artifact Registry image reference for the combined web/API service."
  type        = string
}

variable "worker_image" {
  description = "Immutable Artifact Registry image reference for the worker service."
  type        = string
}

variable "application_origin" {
  description = "Public HTTPS origin used by the browser, Google OIDC callback, and R2 CORS policy."
  type        = string

  validation {
    condition = can(regex(
      "^https://[^/?#]+$",
      var.application_origin,
    ))
    error_message = "application_origin must be an HTTPS origin without a path, query, or fragment."
  }
}

variable "google_oidc_client_id" {
  description = "Public Google OAuth client ID for FactoryLens sign-in."
  type        = string
}

variable "r2_account_id" {
  description = "Cloudflare account ID containing the private FactoryLens R2 bucket."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{32}$", var.r2_account_id))
    error_message = "r2_account_id must contain 32 hexadecimal characters."
  }
}

variable "r2_bucket" {
  description = "Private R2 bucket configured by DATA_SERVICES.md."
  type        = string
  default     = "factorylens-private"
}

variable "workflow_endpoint" {
  description = "Production Roboflow Cloud or compatible Inference HTTPS endpoint."
  type        = string

  validation {
    condition     = can(regex("^https://", var.workflow_endpoint))
    error_message = "workflow_endpoint must use HTTPS in production."
  }
}

variable "workflow_workspace" {
  description = "Roboflow workspace containing the deployed Workflow."
  type        = string
}

variable "workflow_fingerprint" {
  description = "Expected sha256 fingerprint of the exported versioned Workflow."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-fA-F]{64}$", var.workflow_fingerprint))
    error_message = "workflow_fingerprint must be a sha256 fingerprint."
  }
}

variable "web_cpu" {
  description = "CPU limit for each web service instance."
  type        = string
  default     = "1"
}

variable "web_memory" {
  description = "Memory limit for each web service instance."
  type        = string
  default     = "512Mi"
}

variable "web_concurrency" {
  description = "Maximum concurrent requests handled by one web instance."
  type        = number
  default     = 80

  validation {
    condition     = var.web_concurrency >= 1 && var.web_concurrency <= 1000
    error_message = "web_concurrency must be between 1 and 1000."
  }
}

variable "web_timeout_seconds" {
  description = "Web request timeout in seconds."
  type        = number
  default     = 60

  validation {
    condition     = var.web_timeout_seconds >= 1 && var.web_timeout_seconds <= 3600
    error_message = "web_timeout_seconds must be between 1 and 3600."
  }
}

variable "web_min_instances" {
  description = "Minimum number of warm web instances."
  type        = number
  default     = 0
}

variable "web_max_instances" {
  description = "Maximum web instances; changing this requires recalculating the Neon pool budget."
  type        = number
  default     = 3

  validation {
    condition     = var.web_max_instances >= 1
    error_message = "web_max_instances must be at least 1."
  }
}

variable "worker_cpu" {
  description = "CPU limit for each worker service instance."
  type        = string
  default     = "2"
}

variable "worker_memory" {
  description = "Memory limit for each worker service instance."
  type        = string
  default     = "4Gi"
}

variable "worker_concurrency" {
  description = "Maximum concurrent processing requests per worker instance."
  type        = number
  default     = 1

  validation {
    condition     = var.worker_concurrency == 1
    error_message = "FactoryLens currently requires worker_concurrency=1."
  }
}

variable "worker_timeout_seconds" {
  description = "Worker request timeout in seconds."
  type        = number
  default     = 1800

  validation {
    condition     = var.worker_timeout_seconds >= 15 && var.worker_timeout_seconds <= 3600
    error_message = "worker_timeout_seconds must be between 15 and 3600."
  }
}

variable "worker_min_instances" {
  description = "Minimum number of warm worker instances."
  type        = number
  default     = 0
}

variable "worker_max_instances" {
  description = "Maximum worker instances; changing this requires recalculating Neon and queue limits."
  type        = number
  default     = 1

  validation {
    condition     = var.worker_max_instances >= 1
    error_message = "worker_max_instances must be at least 1."
  }
}

variable "task_dispatch_deadline_seconds" {
  description = "Per-task HTTP dispatch deadline used by the API."
  type        = number
  default     = 1800

  validation {
    condition     = var.task_dispatch_deadline_seconds >= 15 && var.task_dispatch_deadline_seconds <= 1800
    error_message = "Cloud Tasks HTTP deadlines must be between 15 and 1800 seconds."
  }
}

variable "task_max_dispatches_per_second" {
  description = "Cloud Tasks queue dispatch rate."
  type        = number
  default     = 1

  validation {
    condition     = var.task_max_dispatches_per_second > 0
    error_message = "task_max_dispatches_per_second must be positive."
  }
}

variable "task_max_concurrent_dispatches" {
  description = "Cloud Tasks queue concurrent dispatch cap."
  type        = number
  default     = 1

  validation {
    condition     = var.task_max_concurrent_dispatches >= 1
    error_message = "task_max_concurrent_dispatches must be at least 1."
  }
}

variable "max_processing_attempts" {
  description = "Shared application and Cloud Tasks processing-attempt limit."
  type        = number
  default     = 3

  validation {
    condition     = var.max_processing_attempts >= 1 && var.max_processing_attempts <= 10
    error_message = "max_processing_attempts must be between 1 and 10."
  }
}

variable "max_upload_bytes" {
  description = "Deployment upload byte limit shared by the web and worker services."
  type        = number
  default     = 262144000

  validation {
    condition = (
      floor(var.max_upload_bytes) == var.max_upload_bytes &&
      var.max_upload_bytes >= 1 && var.max_upload_bytes <= 262144000
    )
    error_message = "max_upload_bytes must be between 1 byte and the public 250 MiB contract."
  }
}

variable "max_media_duration_ms" {
  description = "Deployment inspected media duration limit in milliseconds."
  type        = number
  default     = 300000

  validation {
    condition = (
      floor(var.max_media_duration_ms) == var.max_media_duration_ms &&
      var.max_media_duration_ms >= 1000 && var.max_media_duration_ms <= 300000
    )
    error_message = "max_media_duration_ms must be between one second and five minutes."
  }
}

variable "max_media_width" {
  description = "Deployment maximum landscape display width; portrait media may swap width and height."
  type        = number
  default     = 1920

  validation {
    condition = (
      floor(var.max_media_width) == var.max_media_width &&
      var.max_media_width >= 1 && var.max_media_width <= 1920
    )
    error_message = "max_media_width must be between 1 and 1920 pixels."
  }
}

variable "max_media_height" {
  description = "Deployment maximum landscape display height; portrait media may swap width and height."
  type        = number
  default     = 1080

  validation {
    condition = (
      floor(var.max_media_height) == var.max_media_height &&
      var.max_media_height >= 1 && var.max_media_height <= 1080
    )
    error_message = "max_media_height must be between 1 and 1080 pixels."
  }
}

variable "max_active_inspections_per_user" {
  description = "Deployment per-user active inspection limit."
  type        = number
  default     = 3

  validation {
    condition = (
      floor(var.max_active_inspections_per_user) == var.max_active_inspections_per_user &&
      var.max_active_inspections_per_user >= 1 && var.max_active_inspections_per_user <= 3
    )
    error_message = "max_active_inspections_per_user must be between 1 and 3."
  }
}

variable "terminal_retention_days" {
  description = "Deployment retention window after an inspection reaches a terminal state."
  type        = number
  default     = 30

  validation {
    condition = (
      floor(var.terminal_retention_days) == var.terminal_retention_days &&
      var.terminal_retention_days >= 1 && var.terminal_retention_days <= 30
    )
    error_message = "terminal_retention_days must be between 1 and 30."
  }
}

variable "abandoned_upload_hours" {
  description = "Deployment retention window for incomplete uploads."
  type        = number
  default     = 24

  validation {
    condition = (
      floor(var.abandoned_upload_hours) == var.abandoned_upload_hours &&
      var.abandoned_upload_hours >= 1 && var.abandoned_upload_hours <= 24
    )
    error_message = "abandoned_upload_hours must be between 1 and 24."
  }
}

variable "maintenance_schedule" {
  description = "UTC cron schedule for bounded reconciliation."
  type        = string
  default     = "*/5 * * * *"
}

variable "deletion_protection" {
  description = "Protect production Cloud Run services from accidental Terraform destruction."
  type        = bool
  default     = true
}

check "instance_ranges" {
  assert {
    condition     = var.web_min_instances >= 0 && var.web_min_instances <= var.web_max_instances
    error_message = "web_min_instances must be nonnegative and no greater than web_max_instances."
  }

  assert {
    condition     = var.worker_min_instances >= 0 && var.worker_min_instances <= var.worker_max_instances
    error_message = "worker_min_instances must be nonnegative and no greater than worker_max_instances."
  }
}

check "worker_capacity" {
  assert {
    condition = var.task_max_concurrent_dispatches <= (
      var.worker_max_instances * var.worker_concurrency
    )
    error_message = "Cloud Tasks concurrency cannot exceed total configured worker concurrency."
  }

  assert {
    condition     = var.task_dispatch_deadline_seconds <= var.worker_timeout_seconds
    error_message = "The worker timeout must be at least the Cloud Tasks dispatch deadline."
  }
}
