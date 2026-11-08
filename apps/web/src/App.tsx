import { createHealthResponse } from "@factorylens/contracts";

const health = createHealthResponse("web");

export function App() {
  return (
    <main>
      <p>FactoryLens web</p>
      <h1>Recorded-video inspection is ready to build.</h1>
      <p role="status">Health: {health.status}</p>
    </main>
  );
}
