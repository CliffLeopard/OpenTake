# Route B — Provider layer (ASR / chat / image / speech / video)

> Status: implemented + local-mock verified · 2026-11-08 · branch `feat/dsh-rust-engine`
>
> Scope: the new `plugins/opentake-studio-route-b/lib/providers.js` module, its
> tests, and the contract the Host must call. **The Host (`index.js`) is not
> modified by this work**; the Lead wires these functions into the Routes and
> tools. No paid provider was called and no provider budget was spent.

- Module: [`plugins/opentake-studio-route-b/lib/providers.js`](../../plugins/opentake-studio-route-b/lib/providers.js)
- Tests: [`plugins/opentake-studio-route-b/test/providers.test.mjs`](../../plugins/opentake-studio-route-b/test/providers.test.mjs)
- Route B architecture: [route-b.md](route-b.md)
- Route B media/AI boundary map: [route-b-media-map.md](route-b-media-map.md)

---

## 1. What this layer is

The Route B Host currently performs provider calls inline in `index.js`:
`generateImage`, `generateSpeech`, `generateVideo`, and `asrTranscript`. Those
paths have no shared timeout/retry/cancel policy, no structured provider errors,
no response validation beyond the happy path, and no consistent secret
redaction. This module extracts those responsibilities:

```
Host route/tool
  → resolveProviderConfig(kind, {env, overrides, credentials})
  → createProviderClient({kind, config})
  → client.transcribe / chat / generateImage / generateSpeech / generateVideo
  → normalized result (JSON data or bytes) or ProviderError
```

It is a pure Node module: no DSH imports, no Rust engine calls, no project/media
access, no ffmpeg. The Host owns caching, file writing, media import and project
mutation.

## 2. Exact Host integration API

### 2.1 Config resolution

```js
import {
  providerConfigFromEnv,
  resolveProviderConfig,
  describeConfig,
} from './lib/providers.js';

// Startup defaults from process.env (synchronous; returns key internally).
const asrDefaults = providerConfigFromEnv('asr');

// Per-request / config-route resolution. `overrides` is the same object the
// Host config routes already receive ({ url, key, model }).
const asrConfig = await resolveProviderConfig('asr', {
  env: process.env,
  overrides: state.asr,                       // {url, key, model}
  credentials: ctx.get('credentials'),        // optional DSH-style resolver
});

// Safe for /engine/info, logs and UI. Never contains the key.
const publicView = describeConfig(asrConfig);
```

`resolveProviderConfig` precedence per field:

1. explicit `overrides`;
2. environment (`OPENTAKE_*` / `OPENAI_*` / `FAL_KEY`);
3. optional `credentials.resolve(keyRef)` (or a plain function / Map / object);
4. profile default.

`credentials.resolve` may return a string or `{ value }` (DSH style). A missing
credential is not an error at resolve time; the client fails closed with
`provider-not-configured` when executed.

### 2.2 Client

```js
import { createProviderClient } from './lib/providers.js';

const asr = createProviderClient({
  kind: 'asr',
  config: asrConfig,
  // optional:
  fetchImpl: fetch,          // test injection; defaults to global fetch
  timeoutMs: 60_000,         // default 60s
  retries: 1,                // default 1 retry after the first attempt
  retryDelayMs: 250,         // exponential backoff base
  maxDownloadBytes: 256 * 1024 * 1024,
});
```

Methods:

| Method | Input | Normalized result |
|---|---|---|
| `transcribe(input, options?)` / `execute` | `{ audio: Buffer\|Uint8Array\|Blob, filename, language?, prompt?, model?, responseFormat? }` | `{ kind:'asr', model, text, language?, durationSeconds?, segments:[{start,end,text}], words:[{start,end,text}] }` |
| `chat(input, options?)` | `{ messages:[{role,content}], model?, temperature?, maxTokens? }` | `{ kind:'chat', model, text, usage? }` |
| `generateImage(input, options?)` | `{ prompt, size?, model?, responseFormat? }` | `{ kind:'image', model, b64, url, bytes, mediaType, revisedPrompt }` |
| `generateSpeech(input, options?)` | `{ text, voice?, format?, model? }` | `{ kind:'speech', bytes, mediaType, extension, model }` |
| `generateVideo(input, options?)` | `{ prompt, model?, duration?, aspectRatio? }` | `{ kind:'video', model, url, b64, bytes, mediaType, requestId }` |
| `download(url, options?)` | absolute http(s) URL | `{ kind, bytes, mediaType, url }` |
| `describe()` | — | redacted config (`describeConfig`) |

`options` passed to a method may override `timeoutMs`, `retries`,
`retryDelayMs` and `signal` per call.

Image/video results are descriptors. If the provider returned `b64_json` /
`video_b64`, `bytes` is already decoded. If it returned a URL, call
`client.download(result.url)`; the download is a plain `GET` with **no
`Authorization` header**, so provider credentials are not forwarded to a CDN or
storage host.

Convenience one-shots exist (`executeAsr`, `executeChat`, `executeImage`,
`executeSpeech`, `executeVideo`) for callers that do not need a client object.

### 2.3 Host wiring examples

ASR (replace `asrTranscript`'s inline fetch; keep mediaId/cache around it):

```js
const config = await resolveProviderConfig('asr', {
  env: process.env,
  overrides: state.asr,
  credentials: ctx.get('credentials'),
});
const client = createProviderClient({ kind: 'asr', config });
const transcript = await client.transcribe({
  audio: buffer,                  // mono 16 kHz WAV bytes
  filename: path.basename(audioFile),
  language: request.language,
});
// Host adds mediaId and writes the cache; the module does neither.
return { mediaId, ...transcript };
```

Image:

```js
const image = await client.generateImage({ prompt, size });
const bytes = image.bytes ?? (await client.download(image.url)).bytes;
```

Speech:

```js
const speech = await client.generateSpeech({ text, voice });
await writeFile(target, speech.bytes);
```

Video (immediate-result endpoint):

```js
const result = await videoClient.generateVideo({ prompt });
const bytes = result.bytes ?? (await videoClient.download(result.url)).bytes;
```

Config endpoints: `/engine/asr/config`, `/engine/generation/config`,
`/engine/speech/config`, `/engine/video/config` already carry
`{url, key, model}`; pass those objects as `overrides`. The `chat` kind has no
dedicated Host route yet; use env or an explicit override.

## 3. Provider profiles and environment contract

`OPENAI_BASE_URL` defaults to `https://api.openai.com/v1` and is used only for
the OpenAI-compatible profiles. An explicit `OPENTAKE_*_URL` always wins.

| Kind | URL env / default | Model env / default | Key env / default ref | Auth |
|---|---|---|---|---|
| `asr` | `OPENTAKE_ASR_URL` → `${base}/audio/transcriptions` | `OPENTAKE_ASR_MODEL` → `whisper-1` | `OPENAI_API_KEY`; `OPENTAKE_ASR_KEY_REF` → `OPENAI_API_KEY` | `Bearer` |
| `chat` | `OPENTAKE_CHAT_URL` → `${base}/chat/completions` | `OPENTAKE_CHAT_MODEL` → `gpt-4o-mini` | `OPENAI_API_KEY`; `OPENTAKE_CHAT_KEY_REF` → `OPENAI_API_KEY` | `Bearer` |
| `image` | `OPENTAKE_IMAGE_URL` → `${base}/images/generations` | `OPENTAKE_IMAGE_MODEL` → `gpt-image-1` | `OPENAI_API_KEY`; `OPENTAKE_IMAGE_KEY_REF` → `OPENAI_API_KEY` | `Bearer` |
| `speech` | `OPENTAKE_TTS_URL` → `${base}/audio/speech` | `OPENTAKE_TTS_MODEL` → `gpt-4o-mini-tts` | `OPENAI_API_KEY`; `OPENTAKE_TTS_KEY_REF` → `OPENAI_API_KEY` | `Bearer` |
| `video` | `OPENTAKE_VIDEO_URL` (no default) | `OPENTAKE_VIDEO_MODEL` → `fal-ai/text-to-video` | `OPENTAKE_VIDEO_KEY` or `FAL_KEY`; `OPENTAKE_VIDEO_KEY_REF` → `FAL_KEY` | `Key` |

Notes:

- A config is `configured` when it has a URL and either a key or a loopback URL.
  Keyless loopback endpoints are allowed (local whisper/mock servers); a remote
  URL without a key fails closed.
- URLs are validated as `http`/`https`; embedded credentials (`user:pass@`) are
  rejected. `describeConfig` never includes the key.
- The video profile is a **generic immediate-result JSON endpoint**, matching the
  current Host shape (`POST {prompt, model}` with `authorization: Key …`,
  response `video_url`/`url`/`video_b64`/`b64_json`). It does not implement
  asynchronous fal queue polling; see §7.
- No provider SDK is bundled; every call is a WHATWG `fetch`.

## 4. Request shapes

| Kind | Method/body |
|---|---|
| ASR | `POST multipart/form-data`; fields `file` (filename, media type), `model`, `response_format=verbose_json`, optional `language`, `prompt`, `temperature` |
| Chat | `POST application/json` `{model, messages, temperature?, max_tokens?}` |
| Image | `POST application/json` `{model, prompt, size, n:1, response_format:'b64_json'}` |
| Speech | `POST application/json` `{model, input, voice, response_format:'mp3'}` |
| Video | `POST application/json` `{model, prompt, duration?, aspect_ratio?}` |
| Download | `GET` generated asset URL; no provider auth header |

The local probe (`/tmp/route-b-provider-probe.mjs`, not committed) confirmed
these shapes against a loopback mock: ASR multipart fields `file`, `model`,
`response_format`, `language`; image/speech/video JSON bodies as above; download
request had no authorization header.

## 5. Response validation

- **ASR**: response must be an object with non-empty `text` and/or non-empty
  `segments`; segments/words are normalized to finite `start`/`end` and trimmed
  text. Missing/empty content is `provider-invalid-response`.
- **Chat**: `choices[0].message.content` must be a non-empty string (or a text
  content-part array); usage is passed through when present.
- **Image**: `data[0].b64_json` or `data[0].url` is required; base64 is decoded
  and an image media type is detected from the signature (PNG/JPEG/WebP).
- **Speech**: non-empty binary body; a JSON content type is rejected as
  `provider-invalid-response`; the extension comes from the requested format
  and media type.
- **Video**: `video_url`/`url` or `video_b64`/`b64_json` is required; URL values
  are validated as http(s).
- Response bodies are bounded: JSON 2 MiB, error bodies 64 KiB, downloads and
  audio 256 MiB (configurable via `maxDownloadBytes`).

## 6. Errors, timeout, retry and cancellation

Every failure is a `ProviderError`:

```js
{
  name: 'ProviderError',
  code,        // stable taxonomy below
  message,     // secret-redacted
  status,      // HTTP status or null
  retryable,   // boolean
  details,     // secret-redacted object (URL/status/body excerpt where safe)
}
```

`error.toJSON()` returns the same safe shape; `String(error)` and `message` never
contain a known provider key.

| Code | Meaning | Retryable |
|---|---|---|
| `provider-invalid-kind` | unknown `kind` | no |
| `provider-invalid-config` | bad URL/config/fetch injection | no |
| `provider-not-configured` | no URL, or remote URL without key | no |
| `provider-invalid-input` | missing/blank required input | no |
| `provider-auth` | HTTP 401/403 | no |
| `provider-rate-limit` | HTTP 429 | yes |
| `provider-unavailable` | HTTP 5xx | yes |
| `provider-http` | other non-2xx | no |
| `provider-timeout` | per-attempt timeout | yes |
| `provider-cancelled` | caller `AbortSignal` | no |
| `provider-network` | fetch/network failure | yes |
| `provider-invalid-response` | malformed JSON/invalid payload/empty binary | no |
| `provider-response-too-large` | response/download exceeds bound | no |

Defaults: `timeoutMs = 60_000`, `retries = 1` (one retry after the first
attempt), `retryDelayMs = 250` with exponential backoff. Retries happen only for
`408`/`425`/`429`/`5xx`, network errors and timeouts. A caller `AbortSignal`
cancels immediately, including during backoff. Each retry rebuilds the request,
so multipart bodies are not consumed twice.

## 7. Security model

- Keys come from env, explicit Host overrides, or an optional credential
  resolver. They are held only in the client/config object; the module never
  persists them and never writes them to disk.
- `describeConfig()` returns `hasKey: true/false` and no key; it is the only
  approved way to expose provider state.
- `ProviderError` redacts every known secret (`provider key`) from messages,
  causes, `details`, `toJSON()` and `String(error)`. Server error bodies are
  redacted before being attached.
- Provider URLs with embedded credentials are rejected; the URL is redacted in
  error details.
- `download()` sends no provider `Authorization` header. It validates the URL
  scheme/host and enforces a size bound.
- The module has no logger and performs no analytics/telemetry. A Host should not
  log request headers or raw config; log `describeConfig()` and error
  `toJSON()` only.
- Provider request/response bodies may contain user prompts. Treat them as
  user data; do not echo full bodies into logs.

## 8. Real-network verification status

**Not verified against real providers.** The 21 tests and the `/tmp` probe use
only an ephemeral loopback HTTP server; they assert that no request leaves the
mock origin. No OpenAI, fal.ai, Azure, or other paid endpoint was called, and no
provider key was used or spent.

What was verified:

- `node --test plugins/opentake-studio-route-b/test/providers.test.mjs` →
  **21/21 pass**.
- Local probe `/tmp/route-b-provider-probe.mjs` → ASR/image/speech/video request
  shapes, normalized results, and auth-header redaction.
- No Host/UI changes; Host integration remains for the Lead.

What remains unknown / requires approval before claiming “real provider works”:

- Real OpenAI-compatible ASR/image/speech/chat response variants (error bodies,
  model names, limits).
- Real fal-style video behavior: the current generic endpoint expects an
  immediate result. fal’s queue/judge polling is a different flow and is not
  implemented here; `request_id` is only preserved, not polled.
- Provider-specific auth schemes beyond Bearer/`Key` (e.g. Azure `api-key`).
- Rate-limit headers, idempotency and retry safety for paid generation.
- Real network latency/timeout behavior and ASR upload limits.
- Whether the Host should store keys in DSH credentials vs env/config routes;
  this module accepts either, but the Host decision is outside this deliverable.

## 9. Out of scope

- Host route/tool wiring (Lead will edit `index.js`).
- Provider streaming, async video job polling, model catalogs, cost accounting.
- Caching, media import, writing generated files into the project, project
  mutation, UI/provider settings.
- Any paid live provider call or budget spend.
