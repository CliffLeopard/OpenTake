/**
 * Route B provider layer.
 *
 * Pure Node/WHATWG-fetch module for the provider-backed Route B features:
 *
 *   - ASR        OpenAI-compatible /audio/transcriptions (multipart, verbose JSON)
 *   - chat       OpenAI-compatible /chat/completions
 *   - image      OpenAI-compatible /images/generations
 *   - speech     OpenAI-compatible /audio/speech (binary audio)
 *   - video      generic JSON endpoint (fal-style immediate result by default)
 *
 * It deliberately does NOT know about the DSH Host, the Rust engine, project
 * files or ffmpeg. The Host supplies configuration (environment and/or the
 * existing `/engine/{kind}/config` overrides) and consumes the normalized result.
 * The Lead wires this module into `index.js`; see
 * `docs/architecture/route-b-providers.md` for the exact contract.
 *
 * Security properties:
 *   - provider keys are read from env/overrides/an optional DSH-style
 *     credential resolver, and are never returned by `describeConfig()`;
 *   - provider errors are constructed through `ProviderError`, which redacts
 *     every known secret from messages, causes and details;
 *   - redirects are handled by fetch; auth headers are never forwarded to
 *     generated-asset download URLs (callers use `download()`, which sends no
 *     authorization);
 *   - URLs with embedded credentials are rejected.
 */

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export const PROVIDER_KINDS = Object.freeze(['asr', 'chat', 'image', 'speech', 'video']);

export const PROVIDER_PROFILES = Object.freeze({
  asr: Object.freeze({
    kind: 'asr',
    label: 'OpenAI-compatible ASR',
    defaultModel: 'whisper-1',
    urlEnv: 'OPENTAKE_ASR_URL',
    modelEnv: 'OPENTAKE_ASR_MODEL',
    keyEnvs: Object.freeze(['OPENAI_API_KEY']),
    keyRefEnv: 'OPENTAKE_ASR_KEY_REF',
    defaultKeyRef: 'OPENAI_API_KEY',
    authScheme: 'Bearer',
    requestType: 'multipart',
  }),
  chat: Object.freeze({
    kind: 'chat',
    label: 'OpenAI-compatible chat',
    defaultModel: 'gpt-4o-mini',
    urlEnv: 'OPENTAKE_CHAT_URL',
    modelEnv: 'OPENTAKE_CHAT_MODEL',
    keyEnvs: Object.freeze(['OPENAI_API_KEY']),
    keyRefEnv: 'OPENTAKE_CHAT_KEY_REF',
    defaultKeyRef: 'OPENAI_API_KEY',
    authScheme: 'Bearer',
    requestType: 'json',
  }),
  image: Object.freeze({
    kind: 'image',
    label: 'OpenAI-compatible image generation',
    defaultModel: 'gpt-image-1',
    urlEnv: 'OPENTAKE_IMAGE_URL',
    modelEnv: 'OPENTAKE_IMAGE_MODEL',
    keyEnvs: Object.freeze(['OPENAI_API_KEY']),
    keyRefEnv: 'OPENTAKE_IMAGE_KEY_REF',
    defaultKeyRef: 'OPENAI_API_KEY',
    authScheme: 'Bearer',
    requestType: 'json',
  }),
  speech: Object.freeze({
    kind: 'speech',
    label: 'OpenAI-compatible speech synthesis',
    defaultModel: 'gpt-4o-mini-tts',
    urlEnv: 'OPENTAKE_TTS_URL',
    modelEnv: 'OPENTAKE_TTS_MODEL',
    keyEnvs: Object.freeze(['OPENAI_API_KEY']),
    keyRefEnv: 'OPENTAKE_TTS_KEY_REF',
    defaultKeyRef: 'OPENAI_API_KEY',
    authScheme: 'Bearer',
    requestType: 'json',
  }),
  video: Object.freeze({
    kind: 'video',
    label: 'Generic video generation endpoint',
    defaultModel: 'fal-ai/text-to-video',
    urlEnv: 'OPENTAKE_VIDEO_URL',
    modelEnv: 'OPENTAKE_VIDEO_MODEL',
    keyEnvs: Object.freeze(['OPENTAKE_VIDEO_KEY', 'FAL_KEY']),
    keyRefEnv: 'OPENTAKE_VIDEO_KEY_REF',
    defaultKeyRef: 'FAL_KEY',
    authScheme: 'Key',
    requestType: 'json',
  }),
});

/** Error thrown by config resolution, requests, validation and downloads. */
export class ProviderError extends Error {
  constructor(code, message, options = {}) {
    const secrets = Array.isArray(options.secrets) ? options.secrets : [];
    super(redactSecrets(message, secrets), options.cause === undefined ? undefined : {
      cause: new Error(redactSecrets(errorMessage(options.cause), secrets)),
    });
    this.name = 'ProviderError';
    this.code = code;
    this.status = Number.isInteger(options.status) ? options.status : null;
    this.retryable = options.retryable === true;
    this.details = options.details === undefined ? null : redactValue(options.details, secrets);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      ...(this.details === null ? {} : { details: this.details }),
    };
  }
}

/**
 * Resolve the default provider config for one kind from an environment map.
 * Synchronous; used at startup and by tests. The returned object may contain a
 * `key`; never serialize it directly — use `describeConfig()`.
 */
export function providerConfigFromEnv(kind, { env = process.env } = {}) {
  const profile = profileFor(kind);
  const base = providerDefaultBase(env);
  const url = envValue(env, profile.urlEnv) ?? defaultUrl(profile.kind, base);
  const key = firstEnvValue(env, profile.keyEnvs);
  const keyRef = envValue(env, profile.keyRefEnv) ?? profile.defaultKeyRef;
  const model = envValue(env, profile.modelEnv) ?? profile.defaultModel;
  return normalizeResolvedConfig(profile.kind, {
    url,
    model,
    key,
    keyRef,
    authScheme: profile.authScheme,
  });
}

/**
 * Resolve config from env + explicit Host overrides + optional credential
 * service.
 *
 * `overrides` is the shape the Host config routes already accept:
 *   { url?: string, key?: string, model?: string, keyRef?: string,
 *     authScheme?: 'Bearer'|'Key' }
 *
 * `credentials` may be:
 *   - an object with `resolve(ref)` returning a string or `{value}` (DSH style),
 *   - a function `(ref) => string|Promise<string>`,
 *   - a Map,
 *   - a plain object.
 *
 * A key found in overrides wins over env; env wins over the credential service.
 */
export async function resolveProviderConfig(kind, {
  env = process.env,
  overrides = {},
  credentials = null,
  signal = undefined,
} = {}) {
  const profile = profileFor(kind);
  const base = providerConfigFromEnv(kind, { env });
  const merged = {
    ...base,
    ...(overrides.url === undefined ? {} : { url: overrides.url }),
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
    ...(overrides.keyRef === undefined ? {} : { keyRef: overrides.keyRef }),
    ...(overrides.authScheme === undefined ? {} : { authScheme: overrides.authScheme }),
    ...(overrides.key === undefined ? {} : { key: overrides.key }),
  };
  const explicitKey = Object.prototype.hasOwnProperty.call(overrides, 'key');
  if (explicitKey) {
    // An explicit key override is authoritative, including null/'' to clear it.
    merged.key = normalizeKey(merged.key);
  } else if (merged.key === null || merged.key === '') {
    merged.key = null;
    if (typeof merged.keyRef === 'string' && merged.keyRef.length > 0) {
      merged.key = await resolveCredential(credentials, merged.keyRef, signal);
    }
  }
  return normalizeResolvedConfig(profile.kind, merged);
}

/**
 * Create a provider client. The Host can pass its existing state objects
 * directly:
 *   createProviderClient({ kind: 'asr', config: { url: state.asr.url,
 *     key: state.asr.key, model: state.asr.model } })
 */
export function createProviderClient({
  kind,
  config,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxDownloadBytes = MAX_DOWNLOAD_BYTES,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new ProviderError('provider-invalid-config', 'fetchImpl must be a function');
  }
  return new ProviderClient({
    kind,
    config,
    fetchImpl,
    timeoutMs,
    retries,
    retryDelayMs,
    maxDownloadBytes,
  });
}

/** Convenience one-shot ASR call. */
export function executeAsr(config, input, options) {
  return createProviderClient({ kind: 'asr', config, ...options }).transcribe(input, options);
}

/** Convenience one-shot chat call. */
export function executeChat(config, input, options) {
  return createProviderClient({ kind: 'chat', config, ...options }).chat(input, options);
}

/** Convenience one-shot image-generation call. */
export function executeImage(config, input, options) {
  return createProviderClient({ kind: 'image', config, ...options }).generateImage(input, options);
}

/** Convenience one-shot speech call. */
export function executeSpeech(config, input, options) {
  return createProviderClient({ kind: 'speech', config, ...options }).generateSpeech(input, options);
}

/** Convenience one-shot video-generation call. */
export function executeVideo(config, input, options) {
  return createProviderClient({ kind: 'video', config, ...options }).generateVideo(input, options);
}

/** Redacted description suitable for `/engine/info`, logs or UI. */
export function describeConfig(config) {
  const kind = typeof config?.kind === 'string' ? config.kind : null;
  return {
    kind,
    label: kind === null ? null : profileFor(kind).label,
    configured: config?.configured === true,
    url: typeof config?.url === 'string' ? redactUrl(config.url) : null,
    model: typeof config?.model === 'string' ? config.model : null,
    authScheme: typeof config?.authScheme === 'string' ? config.authScheme : null,
    keyRef: typeof config?.keyRef === 'string' ? config.keyRef : null,
    hasKey: typeof config?.key === 'string' && config.key.length > 0,
  };
}

/** Remove every known secret from an arbitrary string. */
export function redactSecrets(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 3) continue;
    text = text.split(secret).join('[redacted]');
  }
  return text;
}

/**
 * Build one provider request without executing it. This is exported for the
 * Host, diagnostics and the local mock probe. `init` may contain an
 * Authorization header; do not serialize it.
 */
export function buildRequest(kind, config, input = {}) {
  const profile = profileFor(kind);
  const normalized = normalizeClientConfig(kind, config);
  if (normalized.url === null) {
    throw new ProviderError('provider-not-configured', `${profile.label} provider is not configured`, {
      secrets: secretsOf(normalized),
    });
  }
  const headers = authHeaders(normalized);
  switch (kind) {
    case 'asr':
      return buildAsrRequest(normalized, input, headers);
    case 'chat':
      return buildJsonRequest('chat', normalized, input, headers, {
        model: input.model ?? normalized.model,
        messages: requiredArray(input.messages, 'messages'),
        ...(input.temperature === undefined ? {} : { temperature: finiteNumber(input.temperature, 'temperature') }),
        ...(input.maxTokens === undefined ? {} : { max_tokens: positiveInteger(input.maxTokens, 'maxTokens') }),
      });
    case 'image':
      return buildJsonRequest('image', normalized, input, headers, {
        model: input.model ?? normalized.model,
        prompt: requiredString(input.prompt, 'prompt'),
        size: input.size === undefined ? '1024x1024' : requiredString(input.size, 'size'),
        n: 1,
        response_format: input.responseFormat ?? 'b64_json',
      });
    case 'speech':
      return buildJsonRequest('speech', normalized, input, headers, {
        model: input.model ?? normalized.model,
        input: requiredString(input.text, 'text'),
        voice: input.voice === undefined ? 'alloy' : requiredString(input.voice, 'voice'),
        response_format: input.format === undefined ? 'mp3' : requiredString(input.format, 'format'),
      });
    case 'video':
      return buildJsonRequest('video', normalized, input, headers, {
        model: input.model ?? normalized.model,
        prompt: requiredString(input.prompt, 'prompt'),
        ...(input.duration === undefined ? {} : { duration: finiteNumber(input.duration, 'duration') }),
        ...(input.aspectRatio === undefined ? {} : { aspect_ratio: requiredString(input.aspectRatio, 'aspectRatio') }),
      });
    default:
      throw new ProviderError('provider-invalid-kind', `Unknown provider kind: ${String(kind)}`);
  }
}

class ProviderClient {
  constructor({ kind, config, fetchImpl, timeoutMs, retries, retryDelayMs, maxDownloadBytes }) {
    const profile = profileFor(kind);
    this.kind = profile.kind;
    this.label = profile.label;
    this.config = normalizeClientConfig(kind, config);
    this.secrets = secretsOf(this.config);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = normalizeDuration(timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.retries = normalizeRetries(retries);
    this.retryDelayMs = normalizeDuration(retryDelayMs, DEFAULT_RETRY_DELAY_MS, 'retryDelayMs', true);
    this.maxDownloadBytes = normalizePositiveInteger(maxDownloadBytes, MAX_DOWNLOAD_BYTES, 'maxDownloadBytes');
  }

  describe() {
    return describeConfig(this.config);
  }

  /** Execute one provider request, retrying only transient failures. */
  async execute(input = {}, options = {}) {
    if (this.config.configured !== true) {
      throw new ProviderError('provider-not-configured', `${this.label} provider is not configured`, {
        secrets: this.secrets,
      });
    }
    switch (this.kind) {
      case 'asr':
        return this.#executeJson('asr', input, options, (body) => normalizeAsrResponse(body, this.config));
      case 'chat':
        return this.#executeJson('chat', input, options, (body) => normalizeChatResponse(body, this.config));
      case 'image':
        return this.#executeJson('image', input, options, (body) => normalizeImageResponse(body, this.config));
      case 'speech':
        return this.#executeBinary(input, options);
      case 'video':
        return this.#executeJson('video', input, options, (body) => normalizeVideoResponse(body, this.config));
      default:
        throw new ProviderError('provider-invalid-kind', `Unknown provider kind: ${String(this.kind)}`);
    }
  }

  transcribe(input, options) {
    return this.execute(input, options);
  }

  chat(input, options) {
    return this.execute(input, options);
  }

  generateImage(input, options) {
    return this.execute(input, options);
  }

  generateSpeech(input, options) {
    return this.execute(input, options);
  }

  generateVideo(input, options) {
    return this.execute(input, options);
  }

  /** Download a generated asset URL. Sends no provider authorization header. */
  async download(url, options = {}) {
    const safeUrl = validateHttpUrl(url, this.secrets);
    const timeout = withTimeout(options.signal, this.#option(options, 'timeoutMs', this.timeoutMs));
    try {
      const response = await this.fetchImpl(safeUrl, { method: 'GET', signal: timeout.signal });
      if (!response.ok) {
        const body = await readLimitedText(response, MAX_ERROR_BYTES);
        throw httpError(response.status, body, safeUrl, this.secrets);
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > this.maxDownloadBytes) {
        throw new ProviderError('provider-response-too-large', 'Provider download exceeds the configured size limit', {
          status: response.status,
          details: { length, limit: this.maxDownloadBytes },
          secrets: this.secrets,
        });
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) {
        throw new ProviderError('provider-invalid-response', 'Provider download returned an empty body', {
          status: response.status,
          secrets: this.secrets,
        });
      }
      if (bytes.length > this.maxDownloadBytes) {
        throw new ProviderError('provider-response-too-large', 'Provider download exceeds the configured size limit', {
          status: response.status,
          details: { length: bytes.length, limit: this.maxDownloadBytes },
          secrets: this.secrets,
        });
      }
      return {
        kind: this.kind,
        bytes,
        mediaType: response.headers.get('content-type') ?? 'application/octet-stream',
        url: safeUrl,
      };
    } catch (error) {
      throw normalizeFetchError(error, timeout, options, this.secrets, safeUrl);
    } finally {
      timeout.cleanup();
    }
  }

  async #executeJson(kind, input, options, normalize) {
    return this.#retry(async () => {
      const request = buildRequest(kind, this.config, input);
      const timeout = withTimeout(options.signal, this.#option(options, 'timeoutMs', this.timeoutMs));
      try {
        const response = await this.fetchImpl(request.url, { ...request.init, signal: timeout.signal });
        if (!response.ok) {
          const body = await readLimitedText(response, MAX_ERROR_BYTES);
          throw httpError(response.status, body, request.url, this.secrets);
        }
        const body = await readJsonResponse(response, this.secrets);
        try {
          return normalize(body);
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          throw new ProviderError('provider-invalid-response', `Provider response failed validation: ${errorMessage(error)}`, {
            status: response.status,
            details: { kind },
            secrets: this.secrets,
          });
        }
      } catch (error) {
        throw normalizeFetchError(error, timeout, options, this.secrets, request.url);
      } finally {
        timeout.cleanup();
      }
    }, options);
  }

  async #executeBinary(input, options) {
    return this.#retry(async () => {
      const request = buildRequest('speech', this.config, input);
      const timeout = withTimeout(options.signal, this.#option(options, 'timeoutMs', this.timeoutMs));
      try {
        const response = await this.fetchImpl(request.url, { ...request.init, signal: timeout.signal });
        if (!response.ok) {
          const body = await readLimitedText(response, MAX_ERROR_BYTES);
          throw httpError(response.status, body, request.url, this.secrets);
        }
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > this.maxDownloadBytes) {
          throw new ProviderError('provider-response-too-large', 'Provider audio exceeds the configured size limit', {
            status: response.status,
            details: { length, limit: this.maxDownloadBytes },
            secrets: this.secrets,
          });
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0) {
          throw new ProviderError('provider-invalid-response', 'Provider returned empty audio', {
            status: response.status,
            secrets: this.secrets,
          });
        }
        if (bytes.length > this.maxDownloadBytes) {
          throw new ProviderError('provider-response-too-large', 'Provider audio exceeds the configured size limit', {
            status: response.status,
            details: { length: bytes.length, limit: this.maxDownloadBytes },
            secrets: this.secrets,
          });
        }
        const mediaType = response.headers.get('content-type') ?? 'audio/mpeg';
        if (mediaType.toLowerCase().includes('application/json')) {
          throw new ProviderError('provider-invalid-response', 'Provider returned JSON instead of audio', {
            status: response.status,
            secrets: this.secrets,
          });
        }
        return {
          kind: 'speech',
          bytes,
          mediaType,
          extension: extensionForAudio(input.format ?? 'mp3', mediaType),
          model: input.model ?? this.config.model,
        };
      } catch (error) {
        throw normalizeFetchError(error, timeout, options, this.secrets, request.url);
      } finally {
        timeout.cleanup();
      }
    }, options);
  }

  async #retry(work, options) {
    const retries = normalizeRetries(this.#option(options, 'retries', this.retries), this.retries);
    const delayMs = normalizeDuration(this.#option(options, 'retryDelayMs', this.retryDelayMs), this.retryDelayMs, 'retryDelayMs', true);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof ProviderError) || error.retryable !== true || attempt >= retries) throw error;
        await sleep(delayMs * 2 ** attempt, options.signal, this.secrets);
      }
    }
  }

  #option(options, key, fallback) {
    return options[key] === undefined ? fallback : options[key];
  }
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function buildAsrRequest(config, input, headers) {
  const audio = input.audio;
  if (!(audio instanceof Uint8Array) && !(typeof Blob !== 'undefined' && audio instanceof Blob)) {
    throw new ProviderError('provider-invalid-input', 'ASR input.audio must be a Buffer/Uint8Array or Blob', {
      secrets: secretsOf(config),
    });
  }
  const filename = requiredString(input.filename ?? 'audio.wav', 'filename');
  const form = new FormData();
  const blob = typeof Blob !== 'undefined' && audio instanceof Blob
    ? audio
    : new Blob([audio], { type: input.mediaType ?? 'audio/wav' });
  form.append('file', blob, filename);
  form.append('model', input.model ?? config.model);
  form.append('response_format', input.responseFormat ?? 'verbose_json');
  if (input.language !== undefined && input.language !== null && String(input.language).length > 0) {
    form.append('language', String(input.language));
  }
  if (input.prompt !== undefined) form.append('prompt', requiredString(input.prompt, 'prompt'));
  if (input.temperature !== undefined) form.append('temperature', String(finiteNumber(input.temperature, 'temperature')));
  return {
    kind: 'asr',
    url: config.url,
    init: { method: 'POST', headers, body: form },
  };
}

function buildJsonRequest(kind, config, input, headers, body) {
  return {
    kind,
    url: config.url,
    init: {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

function authHeaders(config) {
  const headers = { accept: 'application/json' };
  if (typeof config.key === 'string' && config.key.length > 0) {
    headers.authorization = config.authScheme === 'Key' ? `Key ${config.key}` : `Bearer ${config.key}`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

/** Normalize a verbose-JSON transcription response into the Host transcript shape. */
export function normalizeAsrResponse(body, config = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidResponse('ASR response must be a JSON object');
  }
  const segments = Array.isArray(body.segments)
    ? body.segments
        .filter((segment) => segment !== null && typeof segment === 'object')
        .map((segment) => ({
          text: String(segment.text ?? '').trim(),
          start: finiteOrZero(segment.start),
          end: finiteOrZero(segment.end),
        }))
        .filter((segment) => segment.text.length > 0)
    : [];
  const words = Array.isArray(body.words)
    ? body.words
        .filter((word) => word !== null && typeof word === 'object')
        .map((word) => ({
          text: String(word.word ?? word.text ?? '').trim(),
          start: finiteOrZero(word.start),
          end: finiteOrZero(word.end),
        }))
        .filter((word) => word.text.length > 0)
    : [];
  const text = typeof body.text === 'string' && body.text.trim().length > 0
    ? body.text.trim()
    : segments.map((segment) => segment.text).join(' ').trim();
  if (text.length === 0) throw invalidResponse('ASR response has no text or segments');
  return {
    kind: 'asr',
    model: typeof body.model === 'string' ? body.model : (config.model ?? null),
    text,
    ...(typeof body.language === 'string' && body.language.length > 0 ? { language: body.language } : {}),
    ...(Number.isFinite(Number(body.duration)) ? { durationSeconds: Number(body.duration) } : {}),
    segments,
    words,
  };
}

/** Normalize a chat-completions response to the assistant text. */
export function normalizeChatResponse(body, config = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidResponse('Chat response must be a JSON object');
  }
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  const content = choice?.message?.content;
  let text = '';
  if (typeof content === 'string') text = content.trim();
  else if (Array.isArray(content)) {
    text = content
      .filter((part) => part !== null && typeof part === 'object' && part.type === 'text')
      .map((part) => String(part.text ?? ''))
      .join('')
      .trim();
  }
  if (text.length === 0) throw invalidResponse('Chat response has no assistant text');
  return {
    kind: 'chat',
    model: typeof body.model === 'string' ? body.model : (config.model ?? null),
    text,
    ...(body.usage !== undefined ? { usage: body.usage } : {}),
  };
}

/** Normalize an images response; returns base64 bytes, a URL, or both. */
export function normalizeImageResponse(body, config = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidResponse('Image response must be a JSON object');
  }
  const item = Array.isArray(body.data) ? body.data[0] : null;
  if (item === null || typeof item !== 'object') throw invalidResponse('Image response has no data[0]');
  const b64 = typeof item.b64_json === 'string' && item.b64_json.length > 0 ? item.b64_json : null;
  const url = typeof item.url === 'string' && item.url.length > 0 ? validateHttpUrl(item.url, []) : null;
  if (b64 === null && url === null) throw invalidResponse('Image response has no b64_json or url');
  let bytes = null;
  if (b64 !== null) {
    try {
      bytes = Buffer.from(b64, 'base64');
    } catch (error) {
      throw invalidResponse(`Image response b64_json is not valid base64: ${errorMessage(error)}`);
    }
    if (bytes.length === 0) throw invalidResponse('Image response b64_json decoded to empty bytes');
  }
  return {
    kind: 'image',
    model: typeof body.model === 'string' ? body.model : (config.model ?? null),
    b64,
    url,
    bytes,
    mediaType: bytes === null ? null : detectImageMediaType(bytes),
    revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : null,
  };
}

/** Normalize a video response; returns a URL and/or decoded bytes. */
export function normalizeVideoResponse(body, config = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidResponse('Video response must be a JSON object');
  }
  const urlValue = body.video_url ?? body.url;
  const b64Value = body.video_b64 ?? body.b64_json;
  const url = typeof urlValue === 'string' && urlValue.length > 0 ? validateHttpUrl(urlValue, []) : null;
  const b64 = typeof b64Value === 'string' && b64Value.length > 0 ? b64Value : null;
  if (url === null && b64 === null) throw invalidResponse('Video response has no video_url/url or video_b64/b64_json');
  let bytes = null;
  if (b64 !== null) {
    bytes = Buffer.from(b64, 'base64');
    if (bytes.length === 0) throw invalidResponse('Video response b64 decoded to empty bytes');
  }
  return {
    kind: 'video',
    model: typeof body.model === 'string' ? body.model : (config.model ?? null),
    url,
    b64,
    bytes,
    mediaType: bytes === null ? null : 'video/mp4',
    requestId: typeof body.request_id === 'string' ? body.request_id : null,
  };
}

// ---------------------------------------------------------------------------
// Config resolution helpers
// ---------------------------------------------------------------------------

function profileFor(kind) {
  const profile = PROVIDER_PROFILES[kind];
  if (profile === undefined) {
    throw new ProviderError('provider-invalid-kind', `Unknown provider kind: ${String(kind)}`);
  }
  return profile;
}

function providerDefaultBase(env) {
  const raw = envValue(env, 'OPENAI_BASE_URL') ?? OPENAI_DEFAULT_BASE;
  return raw.replace(/\/+$/, '');
}

function defaultUrl(kind, base) {
  switch (kind) {
    case 'asr': return `${base}/audio/transcriptions`;
    case 'chat': return `${base}/chat/completions`;
    case 'image': return `${base}/images/generations`;
    case 'speech': return `${base}/audio/speech`;
    case 'video': return null;
    default: return null;
  }
}

function normalizeResolvedConfig(kind, value) {
  const profile = profileFor(kind);
  const url = value.url === undefined || value.url === null || String(value.url).trim() === ''
    ? null
    : validateHttpUrl(String(value.url).trim());
  const model = value.model === undefined || value.model === null || String(value.model).trim() === ''
    ? profile.defaultModel
    : String(value.model);
  const key = normalizeKey(value.key);
  const keyRef = value.keyRef === undefined || value.keyRef === null || String(value.keyRef).trim() === ''
    ? null
    : String(value.keyRef);
  const authScheme = value.authScheme === 'Key' ? 'Key' : 'Bearer';
  const allowKeyless = url !== null && isLoopbackUrl(url);
  return {
    kind,
    url,
    model,
    key,
    keyRef,
    authScheme,
    configured: url !== null && (key !== null || allowKeyless),
  };
}

function normalizeClientConfig(kind, value) {
  profileFor(kind);
  if (value === null || typeof value !== 'object') {
    throw new ProviderError('provider-invalid-config', 'Provider config must be an object');
  }
  return normalizeResolvedConfig(kind, value);
}

function normalizeKey(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

async function resolveCredential(credentials, ref, signal) {
  if (credentials === null || credentials === undefined) return null;
  if (signal?.aborted) throw new ProviderError('provider-cancelled', 'Provider credential resolution was cancelled');
  let value = null;
  if (typeof credentials === 'function') {
    value = await credentials(ref);
  } else if (typeof credentials.resolve === 'function') {
    const resolved = await credentials.resolve(ref);
    value = resolved !== null && typeof resolved === 'object' ? resolved.value : resolved;
  } else if (credentials instanceof Map) {
    value = credentials.get(ref);
  } else if (typeof credentials === 'object') {
    value = credentials[ref];
  }
  return normalizeKey(value);
}

function secretsOf(config) {
  return typeof config?.key === 'string' && config.key.length > 0 ? [config.key] : [];
}

function validateHttpUrl(value, secrets = []) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new ProviderError('provider-invalid-config', `Invalid provider URL: ${String(value)}`, { secrets });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProviderError('provider-invalid-config', `Unsupported provider URL protocol: ${parsed.protocol}`, { secrets });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ProviderError('provider-invalid-config', 'Provider URLs must not embed credentials', { secrets });
  }
  return parsed.toString();
}

function redactUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.username !== '' || parsed.password !== '') return '[redacted-url]';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

function isLoopbackUrl(value) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP/error helpers
// ---------------------------------------------------------------------------

async function readJsonResponse(response, secrets) {
  const text = await readLimitedText(response, MAX_JSON_BYTES);
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('provider response must be a JSON object');
    }
    return body;
  } catch (error) {
    throw new ProviderError('provider-invalid-response', `Provider returned invalid JSON: ${errorMessage(error)}`, {
      status: response.status,
      secrets,
    });
  }
}

async function readLimitedText(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    throw new ProviderError('provider-response-too-large', 'Provider response exceeds the configured size limit', {
      status: response.status,
      details: { length, limit },
    });
  }
  const text = await response.text();
  return text.length > limit ? text.slice(0, limit) : text;
}

function httpError(status, bodyText, url, secrets) {
  const detail = extractProviderMessage(bodyText);
  const code = status === 401 || status === 403
    ? 'provider-auth'
    : status === 429
      ? 'provider-rate-limit'
      : status >= 500
        ? 'provider-unavailable'
        : 'provider-http';
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  const message = `Provider request failed (HTTP ${status})${detail === null ? '' : `: ${detail}`}`;
  return new ProviderError(code, message, {
    status,
    retryable,
    details: { status, url: redactUrl(url), body: bodyText.slice(0, 2_000) },
    secrets,
  });
}

function extractProviderMessage(bodyText) {
  try {
    const body = JSON.parse(bodyText);
    if (typeof body?.error?.message === 'string') return body.error.message;
    if (typeof body?.detail === 'string') return body.detail;
    if (typeof body?.message === 'string') return body.message;
  } catch {
    // Not JSON.
  }
  const trimmed = String(bodyText ?? '').trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 300);
}

function normalizeFetchError(error, timeout, options, secrets, url) {
  if (error instanceof ProviderError) return error;
  if (timeout.timedOut()) {
    return new ProviderError('provider-timeout', 'Provider request timed out', {
      retryable: true,
      details: { url: redactUrl(url), timeoutMs: options?.timeoutMs ?? null },
      secrets,
    });
  }
  if (options?.signal?.aborted) {
    return new ProviderError('provider-cancelled', 'Provider request was cancelled', {
      details: { url: redactUrl(url) },
      secrets,
    });
  }
  if (error?.name === 'AbortError') {
    return new ProviderError('provider-cancelled', 'Provider request was cancelled', {
      details: { url: redactUrl(url) },
      secrets,
    });
  }
  return new ProviderError('provider-network', `Provider network request failed: ${errorMessage(error)}`, {
    retryable: true,
    details: { url: redactUrl(url) },
    secrets,
  });
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(signal?.reason);
  };
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        if (!controller.signal.aborted) controller.abort(new Error('provider timeout'));
      }, timeoutMs)
    : null;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      if (timer !== null) clearTimeout(timer);
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', forwardAbort);
    },
  };
}

function sleep(ms, signal, secrets) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('provider-cancelled', 'Provider request was cancelled', { secrets }));
      return;
    }
    const timer = setTimeout(() => {
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('provider-cancelled', 'Provider request was cancelled', { secrets }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function invalidResponse(message) {
  return new ProviderError('provider-invalid-response', message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function detectImageMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

function extensionForAudio(format, mediaType) {
  const normalized = String(format ?? '').toLowerCase();
  if (normalized === 'mp3' || mediaType.includes('mpeg')) return 'mp3';
  if (normalized === 'aac' || normalized === 'm4a') return 'm4a';
  if (normalized === 'wav' || mediaType.includes('wav')) return 'wav';
  if (normalized === 'opus' || mediaType.includes('opus')) return 'opus';
  return 'bin';
}

function envValue(env, key) {
  const value = env?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function firstEnvValue(env, keys) {
  for (const key of keys) {
    const value = envValue(env, key);
    if (value !== null) return value;
  }
  return null;
}

function normalizeDuration(value, fallback, name, allowZero = false) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) {
    throw new ProviderError('provider-invalid-config', `${name} must be a non-negative number`);
  }
  return Math.round(number);
}

function normalizeRetries(value, fallback = DEFAULT_RETRIES) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 5) {
    throw new ProviderError('provider-invalid-config', 'retries must be an integer between 0 and 5');
  }
  return number;
}

function normalizePositiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new ProviderError('provider-invalid-config', `${name} must be a positive number`);
  }
  return Math.round(number);
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new ProviderError('provider-invalid-input', `${name} must be a finite number`);
  }
  return number;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ProviderError('provider-invalid-input', `${name} must be a positive integer`);
  }
  return number;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProviderError('provider-invalid-input', `${name} must be a non-empty string`);
  }
  return value;
}

function requiredArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProviderError('provider-invalid-input', `${name} must be a non-empty array`);
  }
  return value;
}

function finiteOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function redactValue(value, secrets) {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactValue(item, secrets);
    }
    return out;
  }
  return value;
}
