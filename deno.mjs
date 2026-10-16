import worker from "./src/worker.mjs";

const port = +(Deno.env.get("PORT") ?? 8080);

Deno.serve({ port }, worker.fetch);
