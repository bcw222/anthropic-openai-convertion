/**
 * anthropic-openai-convertion
 * ---------------------------------------------------------------------------
 * OpenAI-compatible frontend  ->  Anthropic Messages API backend.
 *
 *   client (OpenAI /v1/chat/completions)  ->  this worker  ->  upstream /v1/messages
 *
 * Why: OpenWebUI (and most tools) only speak OpenAI Chat Completions. Upstreams
 * that expose *only* the Anthropic Messages API (/v1/messages) cannot be used
 * directly. This worker presents an OpenAI surface and translates both ways,
 * for streaming and non-streaming, including tools / tool_result / images.
 *
 * Routes
 *   POST /v1/chat/completions   (stream & non-stream)
 *   GET  /v1/models
 *   GET  /                      health
 *
 * Config (env)
 *   ANTHROPIC_BASE_URL     upstream root, no /v1 suffix.  default https://api.anthropic.com
 *                          e.g. https://opencode.ai/inference/anthropic
 *   ANTHROPIC_MODELS_URL   override the model-list URL.   default <base>/v1/models
 *   ANTHROPIC_VERSION      default 2023-06-01
 *   ANTHROPIC_AUTH_STYLE   x-api-key | bearer | both      default x-api-key
 *   DEFAULT_MODEL          used when a request omits model
 *   DEFAULT_MAX_TOKENS     Anthropic requires max_tokens   default 4096
 *
 * Auth in : Authorization: Bearer <key>  (or x-api-key: <key>)
 * Auth out: x-api-key / Authorization: Bearer  per ANTHROPIC_AUTH_STYLE
 */

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

/* ---------------------------------------------------------------- env ---- */

const env = (name, fallback) => {
  try {
    if (globalThis.process?.env?.[name] != null && globalThis.process.env[name] !== "") {
      return globalThis.process.env[name];
    }
  } catch {}
  try {
    if (globalThis.Deno?.env?.get?.(name) != null && globalThis.Deno.env.get(name) !== "") {
      return globalThis.Deno.env.get(name);
    }
  } catch {}
  return fallback;
};

const baseUrl = () => (env("ANTHROPIC_BASE_URL", DEFAULT_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, "");
const anthropicVersion = () => env("ANTHROPIC_VERSION", DEFAULT_ANTHROPIC_VERSION);
const authStyle = () => (env("ANTHROPIC_AUTH_STYLE", "x-api-key") || "x-api-key").toLowerCase();
const modelsUrl = () => env("ANTHROPIC_MODELS_URL", "") || `${baseUrl()}/v1/models`;
const defaultMaxTokens = () => Number(env("DEFAULT_MAX_TOKENS", DEFAULT_MAX_TOKENS)) || DEFAULT_MAX_TOKENS;

/* -------------------------------------------------------------- errors --- */

class HttpError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
const assert = (ok, status, message) => {
  if (!ok) throw new HttpError(message || "Bad request", status);
};

const cors = (init = {}) => {
  const headers = new Headers(init.headers || {});
  headers.set("Access-Control-Allow-Origin", "*");
  return { ...init, headers };
};

const fixCors = ({ headers, status, statusText }) => cors({ headers, status, statusText });

const jsonResponse = (obj, init = {}) =>
  new Response(JSON.stringify(obj), cors({ ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } }));

const handleOPTIONS = () =>
  new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    },
  });

/* ----------------------------------------------------------------- ids --- */

const randomId = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/* ------------------------------------------------------------- entry ----- */

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return handleOPTIONS();

    const errHandler = (err) => {
      console.error(err);
      const status = err?.status ?? 500;
      return jsonResponse(
        { error: { message: err?.message ?? String(err), type: err?.name ?? "error" } },
        { status },
      );
    };

    try {
      const { pathname } = new URL(request.url);
      const apiKey = getApiKey(request);

      if (pathname.endsWith("/chat/completions")) {
        assert(request.method === "POST", 405, "Method not allowed");
        assert(apiKey, 401, "Missing API key");
        const req = await request.json();
        return await handleCompletions(req, apiKey, request).catch(errHandler);
      }

      if (pathname.endsWith("/models")) {
        assert(request.method === "GET", 405, "Method not allowed");
        assert(apiKey, 401, "Missing API key");
        return await handleModels(apiKey).catch(errHandler);
      }

      if (pathname === "/" || pathname.endsWith("/health")) {
        return new Response("anthropic-openai-convertion: ok\n", cors({ status: 200 }));
      }

      throw new HttpError("404 Not Found", 404);
    } catch (err) {
      return errHandler(err);
    }
  },
};

/* --------------------------------------------------------------- auth ---- */

function getApiKey(request) {
  const header = request.headers.get("x-api-key");
  if (header) return header.trim();
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function upstreamHeaders(apiKey, extra = {}, incoming) {
  const headers = { "anthropic-version": anthropicVersion(), ...extra };
  const style = authStyle();
  if (style === "bearer" || style === "both") headers["authorization"] = `Bearer ${apiKey}`;
  if (style === "x-api-key" || style === "both") headers["x-api-key"] = apiKey;
  const beta = incoming?.headers?.get?.("anthropic-beta");
  if (beta) headers["anthropic-beta"] = beta;
  return headers;
}

/* ------------------------------------------------------------- models ---- */

async function handleModels(apiKey) {
  const out = [];
  let url = modelsUrl();
  let afterId;
  for (let page = 0; page < 10; page++) {
    const u = new URL(url);
    u.searchParams.set("limit", "1000");
    if (afterId) u.searchParams.set("after_id", afterId);
    const res = await fetch(u.toString(), { headers: upstreamHeaders(apiKey) });
    if (!res.ok) return new Response(await res.text(), fixCors(res));
    const body = await res.json();
    for (const m of body.data ?? body.models ?? []) {
      const id = m.id ?? m.name;
      if (!id) continue;
      out.push({ id: String(id).replace(/^models\//, ""), object: "model", created: 0, owned_by: m.owned_by ?? "anthropic" });
    }
    if (!body.has_more) break;
    afterId = body.last_id;
    if (!afterId) break;
  }
  return jsonResponse({ object: "list", data: out });
}

/* -------------------------------------------------------- completions ---- */

async function handleCompletions(req, apiKey, incoming) {
  const payload = transformRequest(req);
  const stream = !!req.stream;

  const res = await fetch(`${baseUrl()}/v1/messages`, {
    method: "POST",
    headers: upstreamHeaders(apiKey, { "content-type": "application/json" }, incoming),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    // Surface the upstream error as an OpenAI-style error body.
    let text = await res.text();
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.error?.message ?? parsed?.message ?? text;
      return jsonResponse({ error: { message, type: "upstream_error", code: res.status } }, { status: res.status });
    } catch {
      return new Response(text, fixCors(res));
    }
  }

  if (stream) {
    const state = {
      id: "chatcmpl-" + randomId(),
      model: payload.model,
      created: Math.floor(Date.now() / 1000),
      toolIndex: -1,
      toolBlocks: {},
      finish: null,
      usage: null,
      includeUsage: !!req?.stream_options?.include_usage,
      started: false,
    };
    const body = res.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(anthropicToOpenAiStream(state))
      .pipeThrough(new TextEncoderStream());
    return new Response(body, cors({
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    }));
  }

  const message = await res.json();
  return jsonResponse(transformResponse(message, payload.model));
}

/* ============================================================ REQUEST ==== */
/*  OpenAI Chat Completions  ->  Anthropic Messages                      */

function transformRequest(req) {
  assert(req && typeof req === "object", 400, "Invalid request body");
  const model = req.model || env("DEFAULT_MODEL", "") || "";
  assert(model, 400, "model is not specified");
  assert(Array.isArray(req.messages), 400, "messages is required");

  const out = {
    model,
    messages: transformMessages(req.messages),
    max_tokens: req.max_tokens ?? req.max_completion_tokens ?? defaultMaxTokens(),
    stream: !!req.stream,
  };

  const system = collectSystem(req.messages);
  if (system) out.system = system;

  for (const key of ["temperature", "top_p", "top_k"]) {
    if (req[key] != null) out[key] = req[key];
  }
  if (req.stop != null) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.metadata && typeof req.metadata === "object") out.metadata = req.metadata;

  if (Array.isArray(req.tools)) {
    const tools = req.tools
      .filter((t) => t && t.type === "function" && t.function?.name)
      .map((t) => ({
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        input_schema: t.function.parameters ?? { type: "object", properties: {} },
      }));
    if (tools.length) out.tools = tools;
  }
  if (req.tool_choice != null && out.tools) out.tool_choice = transformToolChoice(req.tool_choice);

  // Escape hatch: extra_body.anthropic is merged verbatim.
  const extra = req.extra_body?.anthropic;
  if (extra && typeof extra === "object") Object.assign(out, extra);

  return out;
}

function collectSystem(messages) {
  const parts = [];
  for (const m of messages) {
    if (m?.role === "system" || m?.role === "developer") {
      const text = textFromContent(m.content);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n") || undefined;
}

function textFromContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === "text" || p.type === "input_text"))
      .map((p) => p.text ?? "")
      .join("");
  }
  return String(content);
}

function transformMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of messages) {
    if (!m) continue;
    switch (m.role) {
      case "system":
      case "developer":
        continue;
      case "user":
        push("user", toUserBlocks(m.content));
        break;
      case "assistant": {
        const blocks = toAssistantBlocks(m);
        if (blocks.length) push("assistant", blocks);
        break;
      }
      case "tool":
      case "function": {
        const toolUseId = m.tool_call_id || m.name || "";
        const block = { type: "tool_result", tool_use_id: toolUseId, content: toolResultContent(m.content) };
        if (m.is_error) block.is_error = true;
        push("user", [block]);
        break;
      }
      default:
        throw new HttpError(`Unknown message role: "${m.role}"`, 400);
    }
  }

  // Collapse single text-block messages to plain strings (smaller, closer to native).
  return out.map((m) =>
    m.content.length === 1 && m.content[0].type === "text"
      ? { role: m.role, content: m.content[0].text }
      : m,
  );
}

function toUserBlocks(content) {
  if (content == null) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }];

  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    switch (part.type) {
      case "text":
      case "input_text":
        blocks.push({ type: "text", text: part.text ?? "" });
        break;
      case "image_url":
        blocks.push(imageBlock(part.image_url?.url ?? part.image_url));
        break;
      case "input_image":
        blocks.push(imageBlock(part.image_url ?? part.url));
        break;
      case "image":
        if (part.source) blocks.push({ type: "image", source: part.source });
        else if (part.image_url) blocks.push(imageBlock(part.image_url?.url ?? part.image_url));
        break;
      default:
        // Unknown content part: ignore rather than 400 (lenient, like OpenWebUI).
        break;
    }
  }
  if (!blocks.length) blocks.push({ type: "text", text: "" });
  return blocks;
}

function imageBlock(url) {
  assert(typeof url === "string" && url, 400, "Invalid image url");
  const m = url.match(/^data:(?<media_type>[^;,]+);base64,(?<data>[\s\S]*)$/);
  if (m) {
    const media_type = m.groups.media_type;
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: media_type === "image/jpg" ? "image/jpeg" : media_type,
        data: m.groups.data,
      },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

function toAssistantBlocks(m) {
  const blocks = [];
  const content = m.content;
  if (typeof content === "string") {
    if (content) blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue;
      if (part.type === "text" || part.type === "output_text") {
        blocks.push({ type: "text", text: part.text ?? "" });
      }
    }
  } else if (content != null) {
    blocks.push({ type: "text", text: String(content) });
  }

  if (Array.isArray(m.tool_calls)) {
    for (const call of m.tool_calls) {
      let input = {};
      const args = call?.function?.arguments;
      if (typeof args === "string") {
        try {
          input = args.trim() ? JSON.parse(args) : {};
        } catch {
          input = {};
        }
      } else if (args && typeof args === "object") {
        input = args;
      }
      blocks.push({
        type: "tool_use",
        id: call?.id || "toolu_" + randomId(),
        name: call?.function?.name ?? "",
        input,
      });
    }
  }
  return blocks;
}

function toolResultContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push({ type: "text", text: p });
      else if (p?.type === "text" || p?.type === "input_text") parts.push({ type: "text", text: p.text ?? "" });
    }
    if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
    return parts;
  }
  return String(content);
}

function transformToolChoice(tc) {
  if (typeof tc === "string") {
    switch (tc) {
      case "required":
        return { type: "any" };
      case "none":
        return { type: "none" };
      case "auto":
      default:
        return { type: "auto" };
    }
  }
  if (tc?.type === "function" && tc.function?.name) return { type: "tool", name: tc.function.name };
  if (tc?.type === "any") return { type: "any" };
  if (tc?.type === "auto") return { type: "auto" };
  return { type: "auto" };
}

/* =========================================================== RESPONSE ==== */
/*  Anthropic Messages  ->  OpenAI Chat Completions                      */

const STOP_REASON_MAP = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
  pause_turn: "stop",
};
const mapStopReason = (reason) => STOP_REASON_MAP[reason] ?? (reason ? "stop" : null);

function usageFromAnthropic(u) {
  if (!u) return undefined;
  const prompt = u.input_tokens ?? 0;
  const completion = u.output_tokens ?? 0;
  const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  if (u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null) {
    usage.prompt_tokens_details = { cached_tokens: u.cache_read_input_tokens ?? 0 };
  }
  return usage;
}

function transformResponse(message, fallbackModel) {
  const content = Array.isArray(message?.content) ? message.content : [];
  let text = "";
  let reasoning = "";
  const toolCalls = [];

  for (const block of content) {
    if (!block) continue;
    if (block.type === "text") text += block.text ?? "";
    else if (block.type === "thinking") reasoning += block.thinking ?? "";
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || "call_" + randomId(),
        type: "function",
        function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const msg = {
    role: "assistant",
    content: text || (toolCalls.length ? null : ""),
  };
  if (reasoning) msg.reasoning_content = reasoning;
  if (toolCalls.length) msg.tool_calls = toolCalls;

  return {
    id: "chatcmpl-" + String(message?.id ?? randomId()).replace(/^msg_/, ""),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: message?.model ?? fallbackModel ?? "",
    choices: [{ index: 0, message: msg, logprobs: null, finish_reason: mapStopReason(message?.stop_reason) }],
    usage: usageFromAnthropic(message?.usage),
  };
}

/* =========================================================== STREAMING === */
/*  Anthropic SSE  ->  OpenAI SSE (chat.completion.chunk)                */

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function chunk(state, delta, finishReason = null) {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function anthropicToOpenAiStream(state) {
  let buffer = "";
  const emit = (controller, obj) => controller.enqueue(sse(obj));

  const handle = (controller, ev) => {
    switch (ev.type) {
      case "message_start": {
        const m = ev.message ?? {};
        if (m.id) state.id = "chatcmpl-" + String(m.id).replace(/^msg_/, "");
        if (m.model) state.model = m.model;
        if (m.usage) state.usage = usageFromAnthropic(m.usage);
        if (!state.started) {
          state.started = true;
          emit(controller, chunk(state, { role: "assistant", content: "" }));
        }
        break;
      }
      case "content_block_start": {
        const block = ev.content_block ?? {};
        if (block.type === "tool_use") {
          state.toolIndex += 1;
          state.toolBlocks[ev.index] = state.toolIndex;
          emit(controller, chunk(state, {
            tool_calls: [{
              index: state.toolIndex,
              id: block.id || "call_" + randomId(),
              type: "function",
              function: { name: block.name ?? "", arguments: "" },
            }],
          }));
        }
        break;
      }
      case "content_block_delta": {
        const d = ev.delta ?? {};
        if (!state.started) {
          state.started = true;
          emit(controller, chunk(state, { role: "assistant", content: "" }));
        }
        if (d.type === "text_delta") {
          emit(controller, chunk(state, { content: d.text ?? "" }));
        } else if (d.type === "input_json_delta") {
          const ti = state.toolBlocks[ev.index] ?? state.toolIndex;
          emit(controller, chunk(state, {
            tool_calls: [{ index: ti, function: { arguments: d.partial_json ?? "" } }],
          }));
        } else if (d.type === "thinking_delta") {
          emit(controller, chunk(state, { reasoning_content: d.thinking ?? "" }));
        }
        break;
      }
      case "message_delta": {
        if (ev.delta?.stop_reason) state.finish = mapStopReason(ev.delta.stop_reason);
        if (ev.usage) state.usage = { ...(state.usage ?? {}), ...usageFromAnthropic(ev.usage) };
        break;
      }
      case "error": {
        emit(controller, { error: { message: ev.error?.message ?? "upstream error", type: ev.error?.type ?? "api_error" } });
        break;
      }
      default:
        // ping, content_block_stop, message_stop: ignored.
        break;
    }
  };

  return new TransformStream({
    transform(text, controller) {
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        handle(controller, ev);
      }
    },
    flush(controller) {
      if (!state.started) {
        state.started = true;
        controller.enqueue(sse(chunk(state, { role: "assistant", content: "" })));
      }
      controller.enqueue(sse(chunk(state, {}, state.finish ?? "stop")));
      if (state.includeUsage && state.usage) {
        controller.enqueue(sse({
          id: state.id,
          object: "chat.completion.chunk",
          created: state.created,
          model: state.model,
          choices: [],
          usage: state.usage,
        }));
      }
      controller.enqueue("data: [DONE]\n\n");
    },
  });
}
