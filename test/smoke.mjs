/**
 * Smoke test: spins a mock Anthropic /v1/messages upstream, points the worker
 * at it, and exercises both directions (OpenAI request -> Anthropic payload,
 * Anthropic response -> OpenAI response) for stream / non-stream / tool calls.
 *
 *   node test/smoke.mjs
 */
import { createServer } from "node:http";

/* ------------------------------------------------------------ mock upstream */

let lastRequestBody = null;
let modelsHits = 0;
let failModels = false;
const MODEL = "claude-sonnet-5";
const MODEL2 = "claude-haiku-4-5";

const sse = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

const upstream = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      modelsHits++;
      if (failModels) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream down" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: MODEL, display_name: "Claude Sonnet 5" },
          { id: MODEL2, display_name: "Claude Haiku 4.5" },
        ],
        has_more: false,
      }));
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
      const body = JSON.parse(raw || "{}");
      lastRequestBody = body;
      const wantsTool = JSON.stringify(body.messages).includes("usetool");

      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse({ type: "message_start", message: { id: "msg_test1", model: MODEL, usage: { input_tokens: 10, output_tokens: 1 } } }));
        if (wantsTool) {
          res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" } }));
          res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } }));
          res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"Paris"}' } }));
          res.write(sse({ type: "content_block_stop", index: 0 }));
          res.write(sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }));
        } else {
          res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
          res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PONG" } }));
          res.write(sse({ type: "content_block_stop", index: 0 }));
          res.write(sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }));
        }
        res.write(sse({ type: "message_stop" }));
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      if (wantsTool) {
        res.end(JSON.stringify({
          id: "msg_test2", type: "message", role: "assistant", model: MODEL, stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }],
          usage: { input_tokens: 10, output_tokens: 12 },
        }));
      } else {
        res.end(JSON.stringify({
          id: "msg_test2", type: "message", role: "assistant", model: MODEL, stop_reason: "end_turn",
          content: [{ type: "text", text: "PONG" }],
          usage: { input_tokens: 10, output_tokens: 3 },
        }));
      }
      return;
    }
    res.writeHead(404).end();
  });
});

await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const port = upstream.address().port;
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

const worker = (await import("../src/worker.mjs")).default;

/* ------------------------------------------------------------------ assert */

let passed = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
  console.log("  ok  " + msg);
};

const call = (path, body) =>
  worker.fetch(new Request(`http://localhost${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", authorization: "Bearer test-key" },
    body: body ? JSON.stringify(body) : undefined,
  }));

const baseMessages = [
  { role: "system", content: "You are terse." },
  { role: "user", content: "PING" },
];

/* -------------------------------------------------------------- models ---- */

console.log("\n[models]");
{
  const res = await call("/v1/models");
  const json = await res.json();
  ok(res.status === 200, "GET /v1/models -> 200");
  ok(json.object === "list" && json.data[0].id === MODEL, "model list reshaped to OpenAI");
  ok(json.data.length === 2, "all upstream models returned by default");
}

console.log("\n[ENABLED_MODELS: all static → upstream not contacted]");
{
  const before = modelsHits;
  process.env.ENABLED_MODELS = " claude-sonnet-5 , my-custom-model ";
  const json = await (await call("/v1/models")).json();
  ok(json.data.map((m) => m.id).join(",") === "claude-sonnet-5,my-custom-model", "static entries in config order (trimmed)");
  ok(modelsHits === before, "no upstream request at all");
  delete process.env.ENABLED_MODELS;
}

console.log("\n[ENABLED_MODELS: pattern expands against upstream]");
{
  const before = modelsHits;
  process.env.ENABLED_MODELS = "claude-*";
  const json = await (await call("/v1/models")).json();
  ok(modelsHits === before + 1, "upstream contacted exactly once");
  ok(json.data.map((m) => m.id).join(",") === "claude-sonnet-5,claude-haiku-4-5", "both claude-* models, upstream order");

  process.env.ENABLED_MODELS = "claude-*,nothing-matches-*";
  const json2 = await (await call("/v1/models")).json();
  ok(json2.data.length === 2, "non-matching pattern contributes nothing");
  delete process.env.ENABLED_MODELS;
}

console.log("\n[ENABLED_MODELS: mixed literal + pattern]");
{
  process.env.ENABLED_MODELS = "claude-haiku-4-5,zzz-custom";
  const json = await (await call("/v1/models")).json();
  ok(json.data.map((m) => m.id).join(",") === "claude-haiku-4-5,zzz-custom", "all-static literals in config order");

  process.env.ENABLED_MODELS = "claude-*,zzz-custom";
  const json2 = await (await call("/v1/models")).json();
  const ids = json2.data.map((m) => m.id);
  ok(ids[0] === "claude-sonnet-5" && ids[2] === "zzz-custom", "pattern expands in place; unknown literal still served");
  delete process.env.ENABLED_MODELS;
}

console.log("\n[ENABLED_MODELS: upstream fails → static only]");
{
  failModels = true;
  process.env.ENABLED_MODELS = "claude-sonnet-5,claude-*";
  const json = await (await call("/v1/models")).json();
  ok(json.data.length === 1 && json.data[0].id === "claude-sonnet-5", "only the static entry survives (HTTP 500)");

  const saved = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1"; // fetch throws
  const json2 = await (await call("/v1/models")).json();
  ok(json2.data.length === 1 && json2.data[0].id === "claude-sonnet-5", "only the static entry survives (fetch throws)");
  process.env.ANTHROPIC_BASE_URL = saved;
  failModels = false;
  delete process.env.ENABLED_MODELS;
}

/* -------------------------------------------------------- non-streaming --- */

console.log("\n[non-stream, text]");
{
  const res = await call("/v1/chat/completions", { model: MODEL, messages: baseMessages, max_tokens: 40, stream: false });
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  ok(res.status === 200, "200");
  ok(ct.includes("application/json"), "content-type is application/json (single JSON, not SSE)");
  const json = JSON.parse(text); // throws if it were SSE -> exactly the bug we fix
  ok(json.object === "chat.completion", "object=chat.completion");
  ok(json.choices[0].message.content === "PONG", "content=PONG");
  ok(json.choices[0].finish_reason === "stop", "finish_reason=stop");
  ok(json.usage.prompt_tokens === 10 && json.usage.completion_tokens === 3, "usage mapped");
  ok(lastRequestBody.system === "You are terse.", "system hoisted to top-level");
  ok(lastRequestBody.max_tokens === 40, "max_tokens forwarded");
  ok(!("stream" in lastRequestBody) || lastRequestBody.stream === false, "stream=false forwarded");
}

/* ------------------------------------------------------------- streaming -- */

console.log("\n[stream, text]");
{
  const res = await call("/v1/chat/completions", { model: MODEL, messages: baseMessages, max_tokens: 40, stream: true });
  ok((res.headers.get("content-type") || "").includes("text/event-stream"), "SSE content-type");
  const events = (await res.text()).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  ok(events.at(-1) === "[DONE]", "ends with [DONE]");
  const objs = events.slice(0, -1).map((e) => JSON.parse(e));
  ok(objs[0].choices[0].delta.role === "assistant", "first chunk has role");
  ok(objs.some((o) => o.choices[0]?.delta?.content === "PONG"), "text delta present");
  const last = objs.find((o) => o.choices[0]?.finish_reason);
  ok(last && last.choices[0].finish_reason === "stop", "finish_reason=stop emitted");
  ok(objs.every((o) => o.object === "chat.completion.chunk"), "all chunks are chat.completion.chunk");
}

/* ----------------------------------------------------------- tool calls --- */

console.log("\n[non-stream, tool call]");
{
  const res = await call("/v1/chat/completions", {
    model: MODEL,
    messages: [...baseMessages, { role: "user", content: "usetool please" }],
    max_tokens: 40,
    stream: false,
    tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
    tool_choice: "required",
  });
  const json = await res.json();
  ok(json.choices[0].finish_reason === "tool_calls", "finish_reason=tool_calls");
  const tc = json.choices[0].message.tool_calls?.[0];
  ok(tc && tc.function.name === "get_weather" && JSON.parse(tc.function.arguments).city === "Paris", "tool_call mapped");
  ok(lastRequestBody.tools[0].input_schema.properties.city.type === "string", "tools -> input_schema");
  ok(lastRequestBody.tool_choice.type === "any", "tool_choice required -> any");
}

console.log("\n[stream, tool call]");
{
  const res = await call("/v1/chat/completions", {
    model: MODEL,
    messages: [...baseMessages, { role: "user", content: "usetool please" }],
    max_tokens: 40,
    stream: true,
    tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
  });
  const objs = (await res.text()).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter((e) => e && e !== "[DONE]").map((e) => JSON.parse(e));
  const start = objs.find((o) => o.choices[0]?.delta?.tool_calls?.[0]?.function?.name);
  ok(start && start.choices[0].delta.tool_calls[0].function.name === "get_weather", "tool_use block start -> tool_calls delta");
  const args = objs.map((o) => o.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments || "").join("");
  ok(args === '{"city":"Paris"}', "streamed arguments reassemble");
  ok(objs.find((o) => o.choices[0]?.finish_reason)?.choices[0].finish_reason === "tool_calls", "finish_reason=tool_calls (stream)");
}

/* ------------------------------------------------------- tool_result in --- */

console.log("\n[tool_result round-trip]");
{
  await call("/v1/chat/completions", {
    model: MODEL,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"temp":20}' },
    ],
    max_tokens: 40,
    stream: false,
  });
  const msgs = lastRequestBody.messages;
  const asst = msgs.find((m) => m.role === "assistant");
  ok(asst.content[0].type === "tool_use" && asst.content[0].name === "get_weather", "assistant tool_calls -> tool_use block");
  const lastUser = msgs.at(-1);
  ok(lastUser.role === "user" && lastUser.content[0].type === "tool_result" && lastUser.content[0].tool_use_id === "call_1", "role:tool -> user/tool_result");
}

/* ---------------------------------------------------------------- error --- */

console.log("\n[upstream error surface]");
{
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1"; // dead port
  const res = await call("/v1/chat/completions", { model: MODEL, messages: baseMessages, stream: false });
  ok(res.status >= 400, "dead upstream yields error status");
  const json = await res.json();
  ok(json.error && json.error.message, "error body is OpenAI-shaped");
}

upstream.close();
console.log(`\nALL PASSED (${passed} assertions)`);
