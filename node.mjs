import { createServerAdapter } from "@whatwg-node/server";
import { createServer } from "node:http";
import worker from "./src/worker.mjs";

const port = +(process.env.PORT || 8080);

const serverAdapter = createServerAdapter(worker.fetch);
const server = createServer(serverAdapter);
server.listen(port, () => {
  console.log("Listening on:", server.address());
});

// Inside a container this process is PID 1, and the kernel only delivers
// signals to PID 1 when it has an explicit handler — Node installs none unless
// you register one. Without the handlers below, Ctrl+C and `docker stop` are
// silently ignored until the runtime gives up (10s) and SIGKILLs the container.
const shutdown = (signal) => {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => {
    // Long-lived (SSE) connections would otherwise hold the process open.
    server.closeAllConnections?.();
    process.exit(0);
  }, 3000).unref();
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}
