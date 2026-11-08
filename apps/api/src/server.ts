import { app } from "./app.js";

const host = process.env.API_HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? 3000);

app.listen(port, host, () => {
  console.log(`FactoryLens API listening on http://${host}:${port}`);
});
