import { CloudTasksClient } from "@google-cloud/tasks";

import { cloudTasksConfigurationFromEnvironment } from "./cloud-tasks-config.js";
import { configureExistingCloudTasksQueue } from "./cloud-task-dispatcher.js";

async function configure(): Promise<void> {
  const configuration = cloudTasksConfigurationFromEnvironment(process.env);
  const client = new CloudTasksClient();
  try {
    await configureExistingCloudTasksQueue(configuration.queue, client);
    console.log("FactoryLens Cloud Tasks queue configuration applied");
  } finally {
    await client.close();
  }
}

void configure().catch(() => {
  console.error("FactoryLens Cloud Tasks queue configuration failed");
  process.exitCode = 1;
});
