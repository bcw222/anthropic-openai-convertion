# anthropic-openai-convertion

> OpenAI-compatible frontend for the **Anthropic Messages API**. Serverless!

The Anthropic API only speaks the [Messages API](https://platform.claude.com/docs/en/api/messages)
(`/v1/messages`). Lots of tools — Open WebUI, most OpenAI SDK code, anything that
only knows `chat/completions` — cannot talk to it directly. This project gives you
an **OpenAI-compatible endpoint** that translates both ways:

```
your client ──/v1/chat/completions──▶ this worker ──/v1/messages──▶ Anthropic
             ◀──── OpenAI shape ────            ◀── Anthropic SSE/JSON ──
```

Same shape as [`bcw222/gemini-openai-convertion`](https://github.com/bcw222/gemini-openai-convertion),
but for Claude instead of Gemini. Runs in the cloud (Vercel / Netlify / Cloudflare
Workers) with **no server to maintain**, or locally.

Both **streaming** and **non-streaming** are handled — a `stream: false` request
returns a single `chat.completion` JSON object, exactly as an OpenAI client expects.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/chat/completions` | `stream: true` → SSE; `stream: false` → one JSON object |
| `GET`  | `/v1/models` | Anthropic model list, reshaped to the OpenAI list format |
| `GET`  | `/` , `/health` | liveness |

## Auth

Send the key the way OpenAI clients do, and it is forwarded as `x-api-key`:

```
Authorization: Bearer <your-anthropic-key>
```

`x-api-key: <key>` is also accepted on the way in. Use `ANTHROPIC_AUTH_STYLE` to
change how the key is sent upstream (`x-api-key` default, `bearer`, or `both`).

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Upstream root, **no `/v1` suffix**. The worker appends `/v1/messages`. |
| `ANTHROPIC_MODELS_URL` | `<base>/v1/models` | Override the model-list URL (some gateways expose it elsewhere). |
| `ANTHROPIC_VERSION` | `2023-06-01` | Sent as `anthropic-version`. |
| `ANTHROPIC_AUTH_STYLE` | `x-api-key` | `x-api-key` \| `bearer` \| `both`. |
| `DEFAULT_MODEL` | *(empty)* | Used when a request omits `model`. |
| `DEFAULT_MAX_TOKENS` | `4096` | Anthropic requires `max_tokens`; used when absent. |
| `PORT` | `8080` | Local adapters only. |

### Examples

**Anthropic direct** — leave `ANTHROPIC_BASE_URL` unset.

**OpenCode Console's Anthropic endpoint**
(from [opencode.ai/v2/docs/console/models](https://opencode.ai/v2/docs/console/models)):

```
ANTHROPIC_BASE_URL=https://opencode.ai/inference/anthropic
ANTHROPIC_MODELS_URL=https://opencode.ai/inference/v1/models
```

**Your own reverse proxy** that only exposes `/v1/messages`:

```
ANTHROPIC_BASE_URL=https://your-relay.example.com/some/anthropic   # no /v1
ANTHROPIC_AUTH_STYLE=bearer                                        # if it wants Bearer
```

## Deploy

### Cloudflare Workers

```bash
npm install -g wrangler
wrangler deploy
# then, in the dashboard or via --var / wrangler.toml [vars], set ANTHROPIC_BASE_URL if needed
```

Or paste `src/worker.mjs` into the Workers playground.

### Vercel

Button-deploy isn't provided here; fork this repo (CI needs it) and import it on
Vercel. `vercel.json` rewrites everything to `api/handler.mjs` (edge runtime).

```bash
vercel deploy
vercel dev        # local
```

### Netlify

Fork + import, or:

```bash
netlify deploy
netlify dev       # local
```

Serves via `netlify/functions/handler.mjs`; `publish = "public/"`.

### Serve locally — with Node / Deno / Bun

```bash
npm install                       # only needed for Node
npm run start                     # Node
npm run start:deno                # Deno
npm run start:bun                 # Bun
```

The upstream key is taken from the request, so no key needs to live on the box —
but you can also just send one.

### Docker

```bash
docker build -t anthropic-openai-convertion .
docker run --rm -p 8080:8080 \
  -e ANTHROPIC_BASE_URL=https://api.anthropic.com \
  anthropic-openai-convertion
```

`docker compose up -d` also works (see `docker-compose.yml`).

Where `docker.io` is unreachable, build against a mirror:

```bash
docker build --build-arg NODE_IMAGE=registry.cn-hangzhou.aliyuncs.com/arm64m/node:24-alpine .
```

CI publishes a **multi-arch** image (`linux/amd64`, `linux/arm64`) to GHCR:

```bash
docker pull ghcr.io/gsmainagent/anthropic-openai-convertion:latest
```

> Building/running the `arm64` variant on an `x86_64` host needs QEMU user-mode
> binfmt registered (`qemu-user-static`); the CI runner handles this automatically.

## Use with Open WebUI

Add a normal OpenAI connection (API Type: **Chat Completions**):

| Field | Value |
|---|---|
| URL | `https://<your-deployment>/v1` |
| API Key | your upstream key |
| Model IDs | e.g. `claude-sonnet-5` (or leave blank if `/v1/models` works through your upstream) |

Because it is a plain OpenAI connection, OpenWebUI's normal chat pipeline is used —
including proper **non-streaming** responses, which it cannot get from a Pipe model.

## What is translated

Request (OpenAI → Anthropic):

- `system` / `developer` messages are concatenated into the top-level `system` field
- `tools[].function.parameters` → `input_schema`
- assistant `tool_calls` → `tool_use` content blocks
- `role: "tool"` → a `user` message with a `tool_result` block
- `image_url` (data URI → `source.base64`; http(s) → `source.url`)
- `max_tokens` (required by Anthropic — defaults to `DEFAULT_MAX_TOKENS`)
- `stop` → `stop_sequences`, `top_k`, `temperature`, `top_p`
- `tool_choice`: `auto` → `auto`, `required` → `any`, `none` → `none`, function → `tool`
- OpenAI-only params (`frequency_penalty`, `presence_penalty`, `seed`, `logit_bias`,
  `n`, `response_format`, `stream_options`, …) are dropped — Anthropic rejects them
- `extra_body.anthropic` is merged verbatim as an escape hatch
- `anthropic-beta` from the incoming request is forwarded upstream

Response (Anthropic → OpenAI):

- `content[].text` → `choices[0].message.content`
- `content[].tool_use` → `choices[0].message.tool_calls`
- `content[].thinking` → `message.reasoning_content`
- `stop_reason`: `end_turn`/`stop_sequence` → `stop`, `max_tokens` → `length`,
  `tool_use` → `tool_calls`
- `usage.input_tokens`/`output_tokens` → `prompt_tokens`/`completion_tokens`
  (+ `prompt_tokens_details.cached_tokens` from cache read)

Streaming:

- `message_start` → opening `role: "assistant"` chunk
- `text_delta` → `delta.content`
- `thinking_delta` → `delta.reasoning_content`
- `tool_use` block → `delta.tool_calls[i]` (start + `input_json_delta` as arguments)
- final chunk carries `finish_reason`, then optional `usage`, then `data: [DONE]`

## Tests

```bash
npm test          # node test/smoke.mjs
```

Spins a mock Anthropic upstream and covers models, stream/non-stream text,
tool calls (both modes), `tool_result` round-trip, and upstream-error surfacing.

## Notes / limitations

- No embeddings endpoint (Anthropic has none).
- `response_format` / structured output is not translated.
- Prompt caching, extended thinking *controls*, files API and other Claude-native
  features are not first-class here — this is a compatibility shim, not a full
  Claude-native client. Use `extra_body.anthropic` for raw passthrough.

## License

MIT
