import { CloudTasksClient } from "@google-cloud/tasks";

import { cloudTasksConfigurationFromEnvironment } from "./cloud-tasks-config.js";
import { configureExistingCloudTasksQueue } from "./cloud-task-dispatcher.js";
import { writeStructuredLog } from "./security.js";

async function configure(): Promise<void> {
  const configuration = cloudTasksConfigurationFromEnvironment(process.env);
  const client = new CloudTasksClient();
  try {
    await configureExistingCloudTasksQueue(configuration.queue, client);
    writeStructuredLog("info", "cloud_tasks_queue_configured");
  } finally {
    await client.close();
  }
}

void configure().catch((error: unknown) => {
  writeStructuredLog("error", "cloud_tasks_queue_configuration_failed", {
    errorType: error instanceof Error ? error.constructor.name : "UnknownError",
  });
  process.exitCode = 1;
});
