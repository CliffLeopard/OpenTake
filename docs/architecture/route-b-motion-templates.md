# Route B Motion templates

Status: implementation + Host integration contract, 2026-11-08,
branch `feat/dsh-rust-engine`.

This document covers the missing **template/code** path for Route B Motion.
Today the Host can store Motion Studio documents and publish one through
headless Chrome (`motion_add {documentId, revisionHash, ...}`). This workstream
adds a template/code source so an agent or UI can publish a built-in
title/lower-third/callout without authoring a document first.

Owned files:

- `plugins/opentake-studio-route-b/lib/motion-templates.js` — pure template
  library, validation and HTML/CSS converter.
- `plugins/opentake-studio-route-b/test/motion-templates.test.mjs` — node:test
  coverage.
- this document.

The Host (`index.js`), `web/**`, and `docs/architecture/route-b.md` are
deliberately **not** edited here. Section 5 is the integration patch the Host
owner should apply.

## 1. Why templates are HTML/CSS, not a Motion Canvas runner

The existing packaged `title-card` path uses the pinned Motion Canvas 3.17.2
runner. That runner is a separate Node bundle and is only available for the
desktop `motion-canvas-studio` plugin. Route B already renders Motion Studio
documents through headless Chrome; the template path reuses that renderer:

- server-side Chrome renders every frame → PNG;
- FFmpeg encodes H.264 MP4 or transparent ProRes 4444;
- the encoded file is imported and placed on the timeline exactly like the
  document publish path.

The template library therefore returns a self-contained HTML fragment + CSS
stylesheet. It has no Node, filesystem, DOM, Chrome or network dependency, so it
is deterministic and unit-testable.

## 2. Template IDs and parameters

Canonical ids (stable order):

| id | UI name | Default duration | Description |
|---|---|---|---|
| `title-card` | Title card | 3 s | Centred title + optional subtitle, accent underline, fade/scale in/out. |
| `lower-third.glass` | Lower third | 3 s | Bottom-left glass card, accent bar, slide-in. |
| `callout` | Callout | 3 s | Rounded translucent callout card, accent edge, pop-in. |

Accepted aliases (normalized by `resolveTemplateId`):

- `title`, `titlecard`, `titleCard` → `title-card`
- `lower-third`, `lowerthird`, `lowerThird`, `lowerThirdGlass` → `lower-third.glass`
- `callout.card` → `callout`

All three use the same four string parameters:

| param | required | type | default | notes |
|---|---|---|---|---|
| `title` | yes | string | `OpenTake` / `OpenTake` / `Key point` | non-empty, ≤160 Unicode code points |
| `subtitle` | no | string | `Motion Canvas` / `Motion Graphic` / `''` | ≤240 code points |
| `accent` | no | colour | `#7C5CFF` | `#RRGGBB` or `#RRGGBBAA` |
| `background` | no | colour or `transparent` | `#11131A` | stage background; pass `transparent` for alpha publishing |

Unknown parameters, non-string values, control characters, invalid colours and
over-length text are rejected with a `MotionTemplateError` carrying a stable
`code` and the offending `field`. Defaults are applied, colours are normalized
to lower case, and the input params object is never mutated.

`params` is intentionally strict (no arbitrary object/number/boolean values):
the template path is data, not code. Callers needing richer input should use the
`code` path described in §4.

## 3. Converter API

`lib/motion-templates.js` exports:

```js
TEMPLATE_IDS, TEMPLATES, TEMPLATE_ALIASES
getTemplate(id), listTemplates(), resolveTemplateId(id)
validateTemplateParams(templateId, params) -> normalized params
templateToHtmlCss(templateId, params) -> { templateId, html, css, params }
templateToDocument(templateId, params, options) -> { templateId, durationSeconds, frame, document }
escapeHtml(value)
OFFLINE_DOCUMENT_CSP
MotionTemplateError
```

`templateToHtmlCss` is pure: it returns the fragment and stylesheet only.
The first argument is a canonical id, an accepted alias, or a template
definition object (its `id` is resolved through the same alias table).

`templateToDocument` wraps the fragment for the existing Chrome renderer:

- `<meta http-equiv="Content-Security-Policy" content="...">` with
  `OFFLINE_DOCUMENT_CSP` (`script-src 'none'`, no network, no object/embed/
  frame/worker, inline style only);
- `--otm-duration: <durationSeconds>s` so the CSS in/out cycle spans the clip;
- optional `{fps, frame}` adds a **deterministic parked animation** style:
  `animation-delay: calc(-1 * var(--otm-time))` and
  `animation-play-state: paused`. The Host passes the current frame and fps for
  preview and for every publish frame, so Chrome screenshots are frame-accurate
  instead of depending on page-load timing.

The template CSS cycles opacity/scale/slide across the clip duration and holds
the final visible state when the host does not supply a frame. No template emits
a `<script>`, external URL, `url(...)`, `@import`, event handler or untrusted
CSS. User text is HTML-escaped (including attribute breakouts), and colours are
validated before interpolation.

## 4. `motion_add` / `motion_preview` contract extension

Current request (document path, unchanged):

```jsonc
{
  "documentId": "doc-id",
  "revisionHash": "…",
  "startFrame": 0,
  "durationFrames": 90,
  "width": 1280,
  "height": 720,
  "fps": 30,
  "transparent": false,
  "trackIndex": 0
}
```

Extended request — exactly one of `documentId` or `source`:

```jsonc
// template path
{
  "source": {
    "templateId": "title-card",     // or alias
    "params": {
      "title": "Launch",
      "subtitle": "Today",
      "accent": "#22AA66",
      "background": "transparent"   // omit for #11131A
    }
  },
  "startFrame": 0,
  "durationFrames": 90,
  "width": 1280,
  "height": 720,
  "fps": 30,
  "transparent": true,              // also see background
  "trackIndex": 0
}
```

```jsonc
// code path
{
  "source": { "code": "<!doctype html>…OpenTake.onSeek(…)" },
  "startFrame": 0,
  "durationFrames": 90,
  "width": 1280,
  "height": 720,
  "fps": 30
}
```

Rules:

1. `source` and `documentId` are mutually exclusive. Missing both is an error.
2. With `source.templateId`, `source.params` may be omitted; no `code` may be
   supplied. With `source.code`, no `templateId` or `params` may be supplied.
3. `source.code` is constrained as in §6; it is not a template parameter.
4. `motion_preview` accepts the same `source` union. A template preview renders
   at `frame`/`fps` using the deterministic parked CSS; a code preview must use
   the Host's deterministic `OpenTake.onSeek` clock (the existing document path
   uses the same Chrome screenshot loop).
5. Responses:
   - document path: existing `revisionHash` / `sourceDocument.documentId`.
   - template path: `revisionHash: null`, `sourceHash` = SHA-256 of canonical
     HTML + `\0` + CSS, and `source: {kind: "template", templateId, params}`.
   - code path: `revisionHash: null`, `sourceHash` = SHA-256 of the validated
     code, and `source: {kind: "code", bytes, sha256}`.
6. `transparent: true` (or `background: "transparent"` for a template) selects
   the ProRes 4444 `.mov` encode and passes a transparent stage. The template
   converter's default stage is `#11131A` to match the existing Rust template
   behavior; callers must request transparency explicitly.
7. Template paths do not create a `motion-documents/<id>` directory or catalog
   entry; they are one-shot source descriptions. Only the rendered asset enters
   project media.

Invalid templates/params map to `invalid-input` (HTTP 400 through the invoke
bridge); render failures remain `motion-add-failed`/`motion-preview-failed`.

## 5. Host integration patch

The Lead owns `index.js`; the following is the minimal patch.

### 5.1 Package files

Add the new library to the package’s published file list:

```diff
   "files": [
     "index.js",
     "client.js",
     "cordis.patch.yml",
+    "lib/*.js",
     "web/**",
     "native/*/*.node",
     "README.md"
   ],
```

### 5.2 Import and source resolver

At the top of `plugins/opentake-studio-route-b/index.js`:

```js
import {
  templateToDocument,
  templateToHtmlCss,
  validateTemplateParams,
} from './lib/motion-templates.js';
```

Add near the Motion helpers (after `motionRoot`/`motionHash`):

```js
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function motionSourceHash(html, css) {
  return createHash('sha256').update(String(html)).update('\u0000').update(String(css)).digest('hex');
}

// Resolves documentId (existing) or source (template/code). For template
// sources this is synchronous and pure; code validation remains Host-side.
function resolveMotionSource(request) {
  const hasDocument = typeof request.documentId === 'string' && request.documentId.length > 0;
  const hasSource = hasOwn(request, 'source') && request.source !== null;
  if (hasDocument === hasSource) {
    throw new Error('motion request requires exactly one of documentId or source');
  }
  if (hasDocument) {
    const document = readMotionDocument(motionRoot(), request.documentId);
    if (request.revisionHash !== document.summary.revisionHash) {
      throw new Error('motion document changed; reload before previewing');
    }
    return {
      kind: 'document',
      html: document.html,
      css: document.css,
      revisionHash: document.summary.revisionHash,
      sourceHash: null,
      metadata: { documentId: request.documentId, revisionHash: request.revisionHash },
    };
  }
  const source = request.source;
  if (typeof source !== 'object' || Array.isArray(source)) throw new Error('source must be an object');
  const hasTemplate = typeof source.templateId === 'string';
  const hasCode = typeof source.code === 'string';
  if (hasTemplate === hasCode) throw new Error("source requires exactly one of 'templateId' or 'code'");
  if (hasCode) {
    if (hasOwn(source, 'params')) throw new Error("source.params is only valid with source.templateId");
    if (request.templateId !== undefined || request.code !== undefined) {
      throw new Error('source fields must be nested under request.source');
    }
    const code = validateMotionCode(source.code); // Host-side validator, see §6
    return {
      kind: 'code',
      code,
      html: null,
      css: null,
      revisionHash: null,
      sourceHash: createHash('sha256').update(code).digest('hex'),
      metadata: { kind: 'code', bytes: Buffer.byteLength(code, 'utf8'), sha256: createHash('sha256').update(code).digest('hex') },
    };
  }
  const params = source.params === undefined ? {} : source.params;
  // transparent publishing must not paint an opaque stage; force the stage
  // transparent even if the caller passed a background colour.
  const effectiveParams = request.transparent === true ? { ...params, background: 'transparent' } : params;
  const normalized = validateTemplateParams(source.templateId, effectiveParams);
  const converted = templateToHtmlCss(source.templateId, normalized);
  return {
    kind: 'template',
    html: converted.html,
    css: converted.css,
    templateId: converted.templateId,
    params: converted.params,
    revisionHash: null,
    sourceHash: motionSourceHash(converted.html, converted.css),
    metadata: { kind: 'template', templateId: converted.templateId, params: converted.params },
  };
}
```

### 5.3 Preview page builder

Replace the current page construction in `motionPreview` with a source-aware
builder. Keep the existing document page behavior for documents; use
`templateToDocument` for templates.

```js
function motionPreviewPage(source, request) {
  const width = Math.max(2, Math.round(Number(request.width) || 1280));
  const height = Math.max(2, Math.round(Number(request.height) || 720));
  const fps = Math.max(1, Math.round(Number(request.fps) || 30));
  const frame = Math.max(0, Math.round(Number(request.frame) || 0));
  const durationSeconds =
    request.durationFrames !== undefined
      ? Math.max(1, Math.round(Number(request.durationFrames))) / fps
      : undefined;
  if (source.kind === 'template') {
    const duration = durationSeconds ?? 3;
    return templateToDocument(source.templateId, source.params, {
      width, height, durationSeconds: duration, fps, frame,
    }).document;
  }
  if (source.kind === 'document') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${source.css}</style><style>html,body{width:${width}px;height:${height}px;margin:0;overflow:hidden}</style></head><body>${source.html}</body></html>`;
  }
  return motionCodeDocument(source.code, { width, height, fps, frame });
}
```

`motionCodeDocument` is the raw-code wrapper (§6); it must include the
deterministic clock and an offline CSP.

`motionPreview` then resolves once, writes the page, runs the existing Chrome
flags, and returns:

```js
return {
  revisionHash: source.revisionHash,
  sourceHash: source.sourceHash,
  source: source.metadata,
  frame,
  pngDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  diagnostics: [],
};
```

The cache key/file names must include `sourceHash` for source requests (not a
missing `documentId`). Example:

```js
const cacheKey = source.revisionHash ?? source.sourceHash.slice(0, 16);
const htmlFile = path.join(directory, `${cacheKey}-${frame}.html`);
const pngFile = path.join(directory, `${cacheKey}-${frame}.png`);
```

### 5.4 `motionAdd` publish loop

Resolve the source **once**, then use the source-aware page builder for each
frame. Do not call `motionPreview({documentId})` for source requests.

```js
async function motionAdd(request) {
  const source = resolveMotionSource(request);
  const width = Math.max(2, Math.round(Number(request.width) || 1280));
  const height = Math.max(2, Math.round(Number(request.height) || 720));
  const fps = Math.max(1, Math.round(Number(request.fps) || 30));
  const duration = Math.max(1, Math.round(Number(request.durationFrames) || 30));
  const startFrame = Math.max(0, Math.round(Number(request.startFrame) || 0));
  const directory = path.join(
    CACHE_ROOT,
    'motion-publish',
    `${source.revisionHash ?? source.sourceHash.slice(0, 16)}-${Date.now()}`,
  );
  await mkdir(directory, { recursive: true });
  state.motionJob = { active: true, phase: 'rendering', doneFrames: 0, totalFrames: duration };
  // Existing renderer loop, but call the shared capture helper
  // `captureMotionFrame(source, {frame, width, height, fps, durationFrames})`
  // instead of `motionPreview({documentId})`. The rest of the existing
  // import/track/commit logic is unchanged.
  // ...
  return {
    clipId,
    assetId: asset.id,
    contentHash,
    actionName: 'Add Motion Graphic',
    sourceDocument:
      source.kind === 'document'
        ? { documentId: request.documentId, revisionHash: request.revisionHash }
        : null,
    source: source.metadata,
    output: { /* unchanged */ },
  };
}
```

Recommended refactor to avoid duplicating the screenshot code:

```js
async function captureMotionFrame(source, request) {
  // writes motionPreviewPage(source, request), invokes Chrome exactly as the
  // existing motionPreview does, returns { bytes, frame, sourceHash }
}

async function motionPreview(request) {
  const source = resolveMotionSource(request);
  const result = await captureMotionFrame(source, request);
  return {
    revisionHash: source.revisionHash,
    sourceHash: source.sourceHash,
    source: source.metadata,
    frame: result.frame,
    pngDataUrl: `data:image/png;base64,${result.bytes.toString('base64')}`,
    diagnostics: [],
  };
}
```

This preserves the current HTTP invoke shape and `motion_progress` polling:
the Host writes `state.motionJob` during the loop and encodes the same PNG
sequence with the same FFmpeg commands.

### 5.5 Validation / error mapping

- Call `validateTemplateParams` before any Chrome launch. Let
  `MotionTemplateError.code` flow to the invoke error `code` (or map to
  `invalid-input`), and keep `field` in the message for diagnosis.
- For source requests, reject `documentId`, `revisionHash`, `params` at the
  wrong level, and unknown `source` keys. This prevents a request that silently
  ignores an agent’s intended template.
- Keep the existing 512 KiB source cap and the existing dimensions/fps/duration
  bounds for both paths.

## 6. Security constraints for the `code` path

Templates are data and cannot execute. Raw `code` is **not** template data and
must be treated as hostile author content:

- Maximum size 512 KiB UTF-8 (align with the Rust Motion document limit).
- Exactly one of `source.templateId` / `source.code`; `params` only with
  `templateId`.
- Only a self-contained HTML/CSS/JS document is accepted. The supported runtime
  surface is `OpenTake.onSeek(seconds)`; anything else is optional author code.
- Reject before Chrome:
  - external URLs (`http:`, `https:`, `//`, `file:`, `javascript:` in any
    attribute/script);
  - `<script src=…>`, `<link>`, `<iframe>`, `<object>`, `<embed>`, `<form>`,
    `<base>`, `<meta>` refresh/navigation;
  - CSS `@import` and `url(...)` (including data URLs except where explicitly
    allowed by the wrapper);
  - network/storage/navigation APIs (`fetch`, `XMLHttpRequest`, `WebSocket`,
    `EventSource`, `import()`, `eval`, `window.open`, `location`, storage
    access) — these must be rejected statically and blocked by CSP.
- Wrap the code in a CSP-guarded document. Do not rely on Chrome’s process
  sandbox: the Route B preview launches Chrome with `--no-sandbox`. A suitable
  code-page CSP is an offline policy with inline script/style allowed for the
  author’s own animation and all network/media/frame/object sources disabled:

  ```
  default-src 'none';
  script-src 'unsafe-inline';
  style-src 'unsafe-inline';
  img-src data:;
  media-src data:;
  font-src data:;
  connect-src 'none';
  object-src 'none';
  frame-src 'none';
  worker-src 'none';
  base-uri 'none';
  form-action 'none'
  ```

- Run each code preview in the existing cache directory, never inside the
  project bundle. Do not copy source code into project documents or expose it
  over `/app`.
- Add a deterministic clock (`OpenTake.onSeek`) before author script execution;
  no wall-clock animation and no network timing.
- If any validation or render step fails, delete the partial frame directory
  and return a clear error; do not publish a partially rendered clip.

The template path is the preferred agent-facing path for the three built-ins
because it avoids executing author code entirely.

## 7. Preview and publish behavior

### Preview

1. Resolve `documentId` or `source` exactly once.
2. Validate template params (or code) before launching Chrome.
3. For templates, call `templateToDocument` with the requested width, height,
   fps, duration seconds and current frame; the parked CSS shows the exact
   frame rather than relying on page-load timing.
4. Write the HTML to the Motion preview cache, invoke Chrome with the existing
   flags (`--headless=new --disable-gpu --no-sandbox --hide-scrollbars
   --force-device-scale-factor=1 --default-background-color=00000000
   --window-size=W,H --virtual-time-budget=<frame/fps*1000>` +
   `--screenshot`), and return `pngDataUrl`, `source` and `sourceHash`.
5. Preview must not create a document, catalog entry or timeline clip.

### Publish

1. Resolve once; for templates, reuse the canonical HTML/CSS and generate a
   CSP-guarded frame page per frame with `frame`/`fps` so the animation is
   deterministic.
2. Render `durationFrames` frames sequentially; report
   `state.motionJob = {phase:'rendering', doneFrames, totalFrames}` after each
   frame (the existing `motion_progress` bridge).
3. Encode the PNG sequence with the existing H.264 (or transparent ProRes 4444)
   command, import the output, place one clip on a video track, and commit the
   same timeline operation as the document path.
4. Return `clipId`, `assetId`, `contentHash`, `source` metadata and the existing
   `output` block. Keep `sourceDocument` only for the legacy document path.
5. Clear/delete the temporary frame directory after success or failure; a
   cancelled publish must not leave a timeline clip or partial directory.

## 8. `/tmp` Chrome proof

Generated documents from all three canonical templates were rendered with the
same headless Chrome flags used by the Host preview, plus the deterministic
frame-parked style from `templateToDocument({frame,fps})` so the screenshot
shows the intended animation state instead of page-load timing.

Command shape:

```bash
# generated per template by /tmp/proof-route-b-motion-templates.mjs
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=1 --default-background-color=00000000 \
  --window-size=1280,720 --virtual-time-budget=1500 \
  --screenshot=/tmp/opentake-route-b-motion-templates-proof/<id>.png \
  file:///tmp/opentake-route-b-motion-templates-proof/<id>.html
```

Results (Chrome 157.0.8103.38, 1280×720, transparent stage, frame 45 @ 30 fps):

| template | PNG | bytes | non-transparent px | coverage |
|---|---|---:|---:|---:|
| `title-card` | `title-card.png` | 19,427 | 21,477 | 2.33% |
| `lower-third.glass` | `lower-third.glass.png` | 27,953 | 142,893 | 15.50% |
| `callout` | `callout.png` | 30,437 | 150,897 | 16.37% |

Each screenshot is 1280×720 PNG (colour type 6/RGBA), has non-zero alpha
content, and the HTML documents include the offline CSP and
`animation-play-state:paused` for the requested frame. Proof files are under
`/tmp/opentake-route-b-motion-templates-proof/` (`*.html`, `*.png`,
`proof.json`); they are not repository artifacts.

## 9. Test coverage

`node --test plugins/opentake-studio-route-b/test/motion-templates.test.mjs`
covers:

- canonical ids, aliases and stable definitions;
- defaults, normalized colours, deterministic repeated conversion;
- accepted custom title/subtitle/accent/background and transparent stage;
- HTML escaping for script/attribute breakouts and newline→`<br>`;
- unknown template/param, wrong type, empty title, bad colour, over-length
  and control-character rejection with stable error codes/fields;
- standalone CSP document, dimensions, duration and frame parking;
- no `<script>`, `@import`, `url(`, inline handlers or unsafe URLs in output;
- caller params immutability.

## 10. Open follow-ups

- Host integration was applied after this task: `index.js` imports the module,
  resolves template sources for preview/publish, and `package.json` includes
  `lib/*.js`; a live template preview/publish was verified. Raw code remains
  unexposed.
- Rebuild the plugin tarball so installs include the template module.
- Add an agent-facing tool for templates if the Host chooses to expose this
  beyond the local client invoke path; reuse the same validation and return
  `source` metadata.
- Consider replacing the raw-code path with the stricter Rust
  `MotionDocumentSource` HTML/CSS-only policy if arbitrary JS is not required.
- Document/preview all three templates in the Motion panel UI once the Host
  bridge lands.
