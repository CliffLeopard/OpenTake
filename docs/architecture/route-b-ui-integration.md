# Route B UI integration

Status: design decision + milestone-1 prototype notes, 2026-11-08,
branch `feat/dsh-rust-engine`.

This document answers how the OpenTake React editor should appear inside
DeepSeek Harness (DSH) when the editing engine is the Route B in-process Rust
engine (`crates/opentake-node` loaded by the DSH Host through N-API). It
compares three integration surfaces, recommends one for the first milestone,
and records the exact DSH wiring, Tauri IPC shim contract, CSP/sandbox risks,
and the changes the existing `web/` application still needs.

## Inputs and evidence

- [`docs/architecture/route-b.md`](route-b.md) — engine/route milestone status.
- [`docs/architecture/route-b-packaging.md`](route-b-packaging.md) — native addon
  packaging, ABI, signing and platform matrix.
- `plugins/opentake-studio-route-b/` — current prototype: Host plugin
  (`index.js`), DSH client shell (`client.js`), bundle patch
  (`cordis.patch.yml`), built React app under `web/`, Tauri shim
  (`web/tauri-shim.js`), native addon under `native/`.
- `web/` — the existing Tauri/Vite React editor source and `web/dist`.
- DSH plugin rules (`cordis-plugin-development` skill): page UI should render
  React in a slot, inherit `--dsw-alias-*` theme tokens and `ctx.locale`, and
  must not append a second application to the Host document.
- A `docs/architecture/route-b-ui-inventory.md` component inventory was not
  present at the time of writing; if it lands, reconcile its component counts
  with the option comparison below.

## 1. Constraints

1. The engine is already in-process in the DSH Host. There is no Tauri window,
   WebView, sidecar process or MCP bridge in Route B.
2. The existing React app was built for a Tauri WebView. Its runtime boundary
   is `window.__TAURI_INTERNALS__` plus `@tauri-apps/api/*` and
   `@tauri-apps/plugin-dialog` imports.
3. DSH Host web routes are same-origin with the DSH page and already protected
   by `connection.requestRejection`.
4. The editor is large and stateful (project, media, timeline, preview,
   playback, export, library, settings). Copying all of it into a second UI
   implementation is expensive and immediately creates a parity gap.
5. DSH UI must keep working across light/dark themes, locale changes, panel
   collapse/reload and plugin unload. Long-lived resources must be registered
   through `ctx.effect` so teardown is deterministic.

## 2. Options compared

### (a) Same-origin iframe serving the built React app

The DSH client shell registers a `main` slot; the slot renders an iframe whose
`src` is a Host route (`/opentake-studio-route-b/app/`). The app boots exactly as
it does in Tauri, except a Tauri shim that forwards `invoke` to the Host is
loaded first. The Host serves the built Vite app and the engine APIs from the
same origin.

**Strengths**

- Reuses the whole existing editor and build; no React source refactor.
- Strong DOM/CSS isolation: the app's global CSS cannot disturb the DSH shell.
- Fastest path to validating engine behavior, project load, timeline, media
  import, compositing, playback and export through the real UI.
- Same-origin iframe can fetch Host routes with cookies/credentials and use
  the shared browser storage for app-local state.
- Current prototype already works this way and has exercised the full
  home/editor/timeline path in DSH.

**Weaknesses / risks**

- An iframe document does not inherit the DSH theme tokens or `ctx.locale`.
  Theme and language need an explicit bridge (postMessage or duplicated
  settings), and the app keeps its own visual language rather than looking like
  the rest of DSH. This is the main reason DSH's UI guidance prefers a React
  slot mount.
- Two documents, two focus trees, two keyboard surfaces. App shortcuts only
  work while the iframe has focus; Host shortcuts and app shortcuts can
  conflict (Space, Cmd/Ctrl shortcuts, Escape, file dialogs).
- File dialogs are Tauri plugin calls. The current shim stubs them to
  `/tmp`; a real implementation needs a Host-side dialog/path flow or a native
  picker bridge, not browser directory-picker semantics.
- CSP/sandbox and frame-ancestors need to be explicit on both the DSH page and
  the served app document.
- The iframe adds a second application lifecycle: reloading/unloading the DSH
  plugin must dispose the iframe document cleanly; deep links and accessibility
  landmarks are harder.
- Not the target DSH surface (see DSH UI rules); it is an exception for a
  time-boxed milestone.

### (b) Mount the built React app inside the DSH client bundle

The DSH client bundle imports a library build of the same React app and mounts
it into a container owned by a DSH slot (optionally inside a ShadowRoot for CSS
isolation). React and ReactDOM are supplied by the DSH client module table; the
app receives a Tauri-compatible IPC object from the shell instead of relying on
a global WebView shim.

**Strengths**

- One document: native focus, native Host theme tokens and `ctx.locale`
  inheritance (including inside a ShadowRoot for CSS isolation).
- No iframe CSP/frame surface; plugin lifecycle maps directly to React unmount.
- Full app reuse remains possible if the build can externalize React and expose
  a mount API.

**Weaknesses / risks**

- The current Vite output is an application bundle that executes immediately
  against `#root`; it is not a library with `mount(element, ipc)` exports.
  A second build pipeline is required: Vite library mode/UMD or ESM, React and
  ReactDOM external, CSS extracted and scoped or injected into a ShadowRoot.
- The app's bootstrap reads `window.__TAURI_INTERNALS__` and imports Tauri
  packages at module evaluation time in several stores. Those imports must be
  made injectable (or the global shim must be installed before the module
  evaluates). `isTauri` currently gates command dispatch on the global.
- Global CSS resets (`html`, `body`, `#root`) must be scoped; otherwise DSH
  chrome is restyled.
- A duplicate React copy would break hooks or produce a second scheduler.
  The DSH module table's React must be the only copy.
- App state/lifecycle assumes one editor instance; DSH panel remounts and
  multiple windows/tabs need a singleton or explicit session ownership.
- Still a bridge for host theme/locale: better than iframe (tokens cascade into
  ShadowRoot custom properties) but the app's own theme store and locale
  dictionaries need a DSH adapter to avoid visual drift.

### (c) DSH-native shell reusing selected React components

Build a small DSH-native editor shell (React, DSH slots/theme/locale) that
imports only selected app components or, initially, reimplements the minimum
home/project/timeline view. Engine calls go through a typed Host client; the new
shell owns state, IPC and layout.

**Strengths**

- Matches DSH UI rules from day one: theme tokens, locale, focus, panel
  lifecycle, accessibility and slot resizing are natural.
- Small, testable surface for the first milestone; no iframe/CSP exception.
- Components can be migrated incrementally from `web/src` behind a small IPC
  adapter, avoiding a one-shot big-bang port.

**Weaknesses / risks**

- Largest initial UI work; existing Tauri-coupled components need an adapter
  or rewrite. The engine DTOs and command payloads must be mapped into a new
  store rather than the existing Zustand/Tauri store.
- Two UI implementations coexist during migration; parity must be tracked.
- Reusing selected components requires extracting them from app-global stores,
  CSS and Tauri imports, which is non-trivial for timeline/media/shell code.

## 3. Recommendation

**Use option (a), the same-origin iframe, only for the first Route B UI
milestone; it is a validation spike, not the production DSH integration.**
The target is option (c), a DSH-native shell that reuses components
incrementally; option (b) is an optional intermediate if full-editor reuse is
required before the component extraction is complete.

Rationale:

- The first milestone is about proving the Rust engine, IPC contract, project
  loading, timeline rendering, selection and clip moves in DSH — not about
  proving a new design system. The iframe gets the entire existing editor in
  front of the engine with the least new UI code.
- It is already implemented in the prototype and has been exercised in DSH;
  that is concrete evidence for the engine boundary and shim shape.
- The iframe's known fidelity gap (theme/locale, focus, dialogs) is acceptable
  only with explicit exit criteria. Do not treat it as the final product.

**Exit criteria to move off the iframe (required before calling the UI done):**

1. The first-screen milestone (below) is accepted and all engine commands it
   uses have stable request/response contracts.
2. The Tauri API surface used by the milestone is inventoried and each call is
   mapped to a Host route or explicitly removed.
3. A DSH-native shell can render the same timeline DTO and issue
   select/move/undo/redo without Tauri globals; then the iframe is demoted to a
   diagnostic fallback and removed.
4. Theme/locale behavior is validated in light and dark mode in the native
   shell (or an explicit theme bridge is designed and tested for the iframe in
   the interim).

## 4. Exact DSH wiring (milestone 1, option a)

### Bundle manifest

`plugins/opentake-studio-route-b/package.json`:

```json
{
  "name": "@opentake/studio-route-b",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js"
  },
  "files": [
    "index.js", "client.js", "cordis.patch.yml",
    "web/**", "native/*/*.node", "README.md"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true }
  }
}
```

- The bundle patch (`cordis.patch.yml`) inserts one plugin row with the package
  name; the Host plugin's `index.js` is the row's implementation.
- `dsh.client.platform: web` makes the browser artifact (`client.js`) load in
  the DSH Web GUI; `immediately: true` activates it with the page. `exports.
  "./client"` points at that artifact. The client module id must equal the
  package name (`@opentake/studio-route-b`), and `client.js` must be authored in
  the DSH `window.__ModuleLoader__.load({ id, factory })` format (only
  `require('react')` is available from the module table).

### Host plugin and routes

`plugins/opentake-studio-route-b/index.js`:

- `export const inject = ['tools', 'webServer', 'connection']`.
- Registers one prefix route with
  `ctx.webServer.register({ kind: 'prefix', path: '/opentake-studio-route-b', handler })`.
- Every request first calls `connection.requestRejection({headers, method,
  url})`; a non-null rejection returns 403. Do not expose engine routes without
  this fence.
- Routes currently consumed by the UI:

| Route | Purpose |
|---|---|
| `GET /opentake-studio-route-b/app/*` | Built Vite app, `index.html` and hashed assets; MIME + cache-control + path traversal guard |
| `POST /opentake-studio-route-b/engine/invoke` | `{cmd, args, options}` → Tauri-compatible command dispatch; returns JSON result |
| `GET /opentake-studio-route-b/engine/timeline` | Timeline snapshot JSON |
| `POST /opentake-studio-route-b/engine/new`, `/open`, `/save` | Project lifecycle |
| `GET /opentake-studio-route-b/engine/asset?path=` | Media bytes for `convertFileSrc` (see security caveat) |
| `GET /opentake-studio-route-b/engine/preview/frame`, playback/status/audio/sync | Preview and playback |
| `POST /opentake-studio-route-b/engine/export/*`, motion/ASR/generation routes | Feature bridges |

- Tools (`opentake_route_b_*`) call the same engine methods for agent access;
  UI and tools must not diverge in behavior.

### Static-asset build and serving

- Build the existing app with the plugin route as Vite base:

  ```bash
  cd web
  pnpm exec vite build --base=/opentake-studio-route-b/app/
  rm -rf ../plugins/opentake-studio-route-b/web
  cp -R dist ../plugins/opentake-studio-route-b/web
  ```

- `web/index.html` must load the Tauri shim **before** the app module so
  `window.__TAURI_INTERNALS__` exists when `@tauri-apps/api` is imported:

  ```html
  <script src="/opentake-studio-route-b/app/tauri-shim.js?v=N"></script>
  <script type="module" src="/opentake-studio-route-b/app/assets/index-*.js"></script>
  ```

- `serveStatic` resolves only under the plugin's `web/` directory, falls back to
  `index.html` for extensionless paths (SPA), and serves `.js`/`.html` with
  `no-store` and hashed assets with a short cache. Keep the path traversal
  guard.
- The app does not use a history router today (no `window.location`/router
  dependency found in `web/src`). If routing is added, use a memory/hash router
  or set the router basename to the `/app/` base; do not rely on server-side
  path routes that the static handler does not know.

### DSH client shell

`plugins/opentake-studio-route-b/client.js`:

- Registers the editor as the `main` slot (`{name:'main', key:'opentake-studio-route-b'}`)
  and an icon in `sidebar.panellist` (`id`, `order: 16`, `locale`).
- Uses `ctx.slots.inject(...)` + `ctx.slots.register(...)` inside
  `ctx.effect` so panel collapse/reload disposes and reinstalls the slot.
- The slot component renders a same-origin iframe with
  `src="/opentake-studio-route-b/app/"`, `allow="clipboard-read;
  clipboard-write; fullscreen"`, and no `sandbox` attribute in the prototype.
- Styles are one plugin-prefixed style effect (`.otsb-*`) using
  `--dsw-alias-bg-base`; the iframe itself is styled by its own app CSS.
- The prototype shell does not yet register a locale dictionary; a production
  shell must register `ctx.locale` entries and pass the DSH language/theme into
  the iframe or native mount.

## 5. Tauri IPC shim strategy

`web/tauri-shim.js` runs before the app module and installs
`window.__TAURI_INTERNALS__`. It must cover the subset the app actually calls;
the current shim does.

### invoke and callbacks

- `invoke(cmd, args, options)` POSTs
  `{cmd, args: args ?? {}, options: options ?? null}` to
  `/opentake-studio-route-b/engine/invoke`, parses JSON, and rejects
  `{code, message}` errors. The Host dispatches through the same
  `EditRequest`/engine methods used by the agent tools.
- `transformCallback(callback, once)` / `unregisterCallback(id)` maintain the
  callback id map expected by `@tauri-apps/api/event`.
- `plugin:event|listen` and `plugin:event|unlisten` register/unregister event
  handlers; the shim emits `timeline_changed`, `media_changed`,
  `project_saved`, `playback_frame`, `export://progress`, `motion_progress`
  after the corresponding commands/polling. This is an event bridge, not a
  real Tauri IPC implementation.

### Asset protocol

- `convertFileSrc(path, 'opentake-asset')` must return a URL the iframe can
  load. The prototype returns
  `/opentake-studio-route-b/engine/asset?path=<encoded absolute path>`.
- Security caveat: the current asset route reads **any absolute path** the
  caller supplies and has no Range support. That is acceptable only for a
  local prototype. Before this is exposed beyond a trusted local DSH profile,
  it must:
  - authorize paths against the current project/media roots (or use opaque
    asset IDs),
  - support `GET` + `HEAD` and HTTP `Range`/`Content-Range` for video seeking,
  - set safe content types and reject non-media paths.
- `@tauri-apps/api/window`, `@tauri-apps/api/dpi` and
  `@tauri-apps/api/menu` calls need explicit shims/no-ops for
  `getCurrentWindow`, monitor queries, fullscreen and native menus. The
  prototype works around missing calls in the app's existing browser fallback
  paths; audit these when the native mount replaces the iframe.

### Dialogs and window APIs

- `@tauri-apps/plugin-dialog` calls are stubbed to `/tmp/opentake-route-b/`
  (`save`, `open`, `message`, `ask`, `confirm`). This is not a production file
  picker: it silently picks a path, cannot browse a project, and does not ask
  the user. Replace with a Host-mediated dialog command (the DSH profile should
  own native dialogs) or a same-origin path-input flow with explicit user
  action.
- Window close/minimize/fullscreen, updater/account surfaces and
  notification/opener plugins are not part of the first milestone; remove or
  hide their entry points in the DSH shell rather than letting them invoke
  unsupported Tauri commands.
- Clipboard: the browser clipboard API is available in the same-origin iframe
  with the `allow` attribute; the app's copy/paste should use browser
  clipboard events rather than a Tauri clipboard plugin.

## 6. CSP and sandbox concerns

### Iframe (milestone 1)

- Serve the app same-origin. The DSH page's CSP, if present, must allow
  `frame-src 'self'` (or the exact plugin origin); the app document must not
  send `X-Frame-Options: DENY`/`SAMEORIGIN` that blocks the DSH page, and should
  send `Content-Security-Policy: frame-ancestors 'self'`.
- Suggested app-document CSP for the prototype:

  ```
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  media-src 'self' blob:;
  connect-src 'self';
  font-src 'self' data:;
  worker-src 'self' blob:;
  frame-ancestors 'self'
  ```

  Vite injects a CSS file, not a required inline script; `style-src
  'unsafe-inline'` is only needed if the app injects style attributes/elements
  at runtime (the DSH shell's own style effect lives outside the iframe).
  Do not add `unsafe-eval`; the production Vite bundle does not need it.
- Sandbox attribute: the prototype intentionally omits it because the Tauri
  shim needs same-origin fetch, storage, audio and clipboard. A sandbox with
  both `allow-scripts` and `allow-same-origin` provides little isolation; a
  sandbox without `allow-same-origin` would break the shim. If a sandbox is
  required, use at minimum
  `allow-scripts allow-same-origin allow-forms allow-downloads allow-modals`
  and verify every file/media/network path; never grant top-navigation.
- Downloads: export downloads/frames must use browser downloads from the
  iframe (`allow-downloads` if sandboxed) or a Host command; do not rely on
  Tauri's dialog path.
- Theme/locale: iframe documents do not inherit CSS custom properties from the
  DSH page. For the interim, postMessage `{theme, tokens, language}` from the
  shell and apply it in the app; long-term the native shell removes this
  bridge.

### Native mount (target)

- A ShadowRoot mount inherits CSS custom properties, so `--dsw-alias-*` tokens
  keep working while isolating the app's global CSS. If Shadow DOM is not used,
  scope every app selector.
- The DSH page CSP must allow the bundle's script/style sources; no iframe
  directive is needed. Do not `require` DSH Client primitives from the app
  bundle (unsupported); use host tokens and local controls.
- The Host routes remain the trust boundary: same-origin fetch, connection
  request fence, project-root path allowlist for assets and media.

## 7. Required changes in the existing web app

| Area | Milestone-1 iframe | Target native mount |
|---|---|---|
| Vite base | Build with `--base=/opentake-studio-route-b/app/` (current route-b build does this); check favicon/asset URLs are base-aware | Add a library build with `mount()`/`unmount()` and base-independent asset URLs |
| Router | None currently; no change. If added, memory/hash router or `basename` | Same |
| Asset protocol | Shim `convertFileSrc` to Host asset route; add Host Range/allowlist | Keep adapter, no global Tauri dependency |
| Tauri imports | Shim must exist before module evaluation; cover core/event/dialog/window/dpi/menu | Inject an IPC adapter; remove direct `@tauri-apps` imports from mounted components |
| Dialogs | Stub to `/tmp`; replace with Host dialog/path flow | Host dialog service |
| Window APIs | Shims/no-ops for window/monitor/fullscreen/menu | DSH-native controls; remove window chrome |
| CSS | App CSS isolated by iframe | Shadow DOM or scoped CSS |
| Theme | postMessage theme/token/language bridge | Inherit DSH tokens; map app theme store |
| Locale | App's own locale; bridge language setting | Route visible UI text through/align with DSH locale service |
| React | App bundle owns React inside iframe | React/ReactDOM external from DSH module table; single copy |
| Build output | `web/dist` copied to plugin `web/` | Library/ESM artifact packaged in client bundle |

## 8. Minimal first-screen milestone (acceptance)

**Goal:** prove the engine + DSH panel + timeline interaction path, not full
editor parity.

1. DSH plugin loads; `GET /engine/info` reports the addon loaded or a clear
   load error; the panel shows a useful failure state instead of a blank iframe.
2. Home/new/open renders; `new_project` creates an `.opentake` bundle and
   returns a timeline snapshot; open loads an existing bundle.
3. Timeline renders from the engine DTO: tracks, clips, start/duration, names;
   no media decoding required for the first check.
4. Select a clip; selection survives refresh/re-render.
5. Move a clip (drag or nudge) → `edit_apply` with the expected `EditRequest`;
   engine response refreshes the timeline; invalid move shows an inline error.
6. Undo/redo through the shim updates the timeline.
7. Manual checks: DSH light/dark, panel collapse/reopen, Host page reload,
   plugin unload/reload, no leaked iframe/document listeners.
8. Tool parity: execute the same new/open/move through `opentake_route_b_*`
   tools and compare returned state with the UI action.

The current prototype has exercised load/new/open, timeline, media import,
selection/edit commands and preview in DSH; the remaining acceptance items for
this milestone are the formal light/dark, reload and unload checks and a
repeatable engine tool/UI parity script.

## 9. Prototype shell (current files)

The Route B prototype already occupies the allowed new directory; this design
task made no changes to it to avoid colliding with the active Route B
implementation. The shell is low risk and is the option-(a) reference:

| File | Role |
|---|---|
| `plugins/opentake-studio-route-b/package.json` | bundle + client manifest, exports and files |
| `plugins/opentake-studio-route-b/cordis.patch.yml` | inserts the Route B plugin row |
| `plugins/opentake-studio-route-b/index.js` | Host plugin: engine addon, routes, tools, static app, IPC dispatch |
| `plugins/opentake-studio-route-b/client.js` | DSH client shell: iframe `main` panel + sidebar icon + scoped styles |
| `plugins/opentake-studio-route-b/web/index.html` | built app entry, shim script first, hashed Vite assets |
| `plugins/opentake-studio-route-b/web/tauri-shim.js` | `__TAURI_INTERNALS__` invoke/event/asset/dialog bridge |
| `plugins/opentake-studio-route-b/web/assets/*` | built React app (do not edit by hand) |
| `plugins/opentake-studio-route-b/native/<platform>-<arch>/*.node` | platform-specific engine addon |

If a shell is built from scratch instead, keep it to
`package.json` + `cordis.patch.yml` + a small `client.js` (React slot + iframe
or thin native shell) + a minimal Host `index.js`; do not copy the whole web
app into the prototype directory until the asset/IPC contract is accepted.

## 10. Risks and open questions

- **Native addon availability and signing:** the addon is per platform/arch,
  macOS ad-hoc signed; Windows/Linux and notarization are not solved. A
  missing addon must be a clear panel error, not a broken iframe.
- **Engine threading/lifecycle:** one `AppCore` instance in the Host; multiple
  DSH windows/tabs/panel instances need explicit session ownership and
  serialization. The client shell currently assumes one panel/one engine.
- **Asset route security:** arbitrary absolute paths and no Range are
  prototype-only. Fix before any shared/multi-user profile.
- **Dialogs:** Tauri stubs to `/tmp` are not usable for real projects. Decide
  whether DSH Host or a native shell owns file picking.
- **CSP/frame policy:** DSH host CSP changes could block the iframe; the native
  mount removes the frame surface but needs a bundle that does not require
  `unsafe-eval`/inline scripts.
- **Theme/locale fidelity:** the iframe bridge is manual and likely to drift;
  the native shell is the only durable way to inherit DSH theme and locale.
- **Duplicate React/bundle size:** a native mount must externalize React and
  scope CSS; a full app bundle is large and includes Tauri plugin code that
  should be dead-code eliminated.
- **Build reproducibility:** the checked-in `web/` is a built artifact; package
  versions, Vite base and shim version must be recorded in the build script.
- **Keyboard/focus:** app shortcuts versus DSH shortcuts need a documented
  ownership rule (iframe focused vs native panel focus).
- **Streaming/playback:** the current wall-clock/HTMLAudio bridge is
  approximate; it is outside the first-screen acceptance but affects perceived
  editor quality.

## 11. Follow-ups (ordered)

1. Add the missing Range/allowlist to `engine/asset` and a real Host dialog
   path flow; keep iframe-only for local trusted profiles until then.
2. Add light/dark + locale bridge or move directly to the native mount; record
   the decision and remove the iframe when native shell passes the milestone.
3. Extract the engine IPC adapter (`invoke` command map, DTO types, event
   names) into a small shared module so iframe, native shell and tools share
   one contract.
4. Build the native mount (Vite library output, React external, ShadowRoot) and
   port the first screen (home/project/timeline) with DSH slots/theme/locale.
5. Keep the Route B engine tools (`opentake_route_b_*`) as the agent-facing
   contract and add a parity test that executes the same operations through
   UI and tools.
