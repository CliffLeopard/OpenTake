# Route B — DSH-native shell (slice 1)

Status: implementation slice · branch `feat/dsh-rust-engine` · 2026-11-08
Owner scope: `plugins/opentake-studio-route-b/ui/**`,
`plugins/opentake-studio-route-b/test/ui-mount.test.mjs`, this document.
Host `index.js`, `client.js`, `web/**` and `route-b.md` are intentionally
untouched; the Lead integrates the new shell.

Related: [route-b.md](route-b.md), [route-b-ui-inventory.md](route-b-ui-inventory.md),
`plugins/opentake-studio-route-b/README.md`.

---

## 1. What this slice is (and is not)

The Route B prototype mounts the whole OpenTake editor in one same-origin
iframe. This slice builds the **first step off that path without breaking it**:

```
DSH main panel (keyed "opentake-native")            ← new: native React shell
├── DSH header: title / engine-status badge / Retry / Reload
├── DSH status line (aria-live) → GET /engine/info
├── content region: existing built editor in an iframe
│     └── /opentake-studio-route-b/app/             ← still iframe (unchanged build)
└── DSH note line

DSH main panel (keyed "opentake-studio-route-b")     ← preserved: existing prototype
└── same built editor iframe (mirrored from ../client.js)
```

- **Native**: panel registration, sidebar entry, header/status/actions/note,
  theme inheritance, locale dictionaries, lifecycle.
- **Still iframe**: the editor body itself, because `web/src` and the Tauri
  bridge have not been migrated yet (see
  [route-b-ui-inventory.md](route-b-ui-inventory.md) §5.2 for the native-mount
  blockers).
- **Additive only**: this module registers new panel ids; it does not modify or
  replace the Host plugin routes. It also mirrors the iframe prototype panel
  (`INCLUDE_IFRAME_PROTOTYPE = true`) so the file can become the package client
  entry without dropping the working panel (see §8).

Files:

| Path | Purpose |
|---|---|
| `plugins/opentake-studio-route-b/ui/client.js` | DSH client module source (no build step, only `require('react')`) |
| `plugins/opentake-studio-route-b/ui/README.md` | short integration pointer |
| `plugins/opentake-studio-route-b/test/ui-mount.test.mjs` | Node stub harness (11 tests) |
| `docs/architecture/route-b-native-ui.md` | this document |

---

## 2. Exact slot registration

Module format (same as `../client.js`):

```js
window.__ModuleLoader__.load({
  id: '@opentake/studio-route-b',   // equals the package name (valid client entry)
  factory(require) {
    const React = require('react')
    return { inject: ['slots', 'locale'], apply(ctx) { … } }
  },
})
```

`apply(ctx)` binds the locale namespace and registers, through `ctx.effect`
(so unload disposes everything):

### 2.1 Native panel — `main` (keyed, root scope)

```js
ctx.slots.register({
  name: 'main',
  key: 'opentake-native',
  locale: 'opentake-native',
}, OpenTakeNativeShell)
```

| Option | Value | Notes |
|---|---|---|
| `name` | `main` | keyed central-panel slot |
| `key` | `opentake-native` | distinct from the prototype key `opentake-studio-route-b`; the keyed slot dispatches by sidebar id and registering an already-occupied key **replaces** that occupant — distinct keys are what makes A/B possible |
| `locale` | `opentake-native` | slot renderer passes a `t` bound to this namespace (see §4) |

The DSH slot catalog describes `main` as: *"Central panel selected by sidebar
entry id. The reserved `conversation` key hosts the Conversation; other keys
receive no Session binding."* Registration options are only `key`; owner props
are empty.

### 2.2 Native sidebar entry — `sidebar.panellist` (list, root scope)

```js
ctx.slots.register({
  name: 'sidebar.panellist',
  id: 'opentake-native',
  order: 17,
  locale: 'opentake-native',
  label: () => t('nav'),
}, Glyph)
```

| Option | Value | Notes |
|---|---|---|
| `id` | `opentake-native` | must equal the `main` key; the sidebar dispatches this id |
| `order` | `17` | after the prototype entry (`16`) |
| `label` | thunk `() => t('nav')` | re-read on every projection, so the label follows locale switches without re-registering |
| `component` | `Glyph` | 15×15 inline SVG, `currentColor`; catalog owner props are `{ size, active }` (ignored is fine) |

### 2.3 Mirrored iframe prototype entry (default on)

To make this file a safe drop-in, it also registers the exact prototype panel
from `../client.js` behind `INCLUDE_IFRAME_PROTOTYPE`:

```js
{ name: 'main', key: 'opentake-studio-route-b', locale: 'opentake-studio-route-b' }
{ name: 'sidebar.panellist', id: 'opentake-studio-route-b', order: 16,
  locale: 'opentake-studio-route-b', label: () => 'OpenTake (Rust)' }
```

The prototype's `locale: 'opentake-studio-route-b'` namespace has no registered
dictionary (same as `../client.js` today); its label stays the hard-coded
`'OpenTake (Rust)'`. Set the flag to `false` if the native registration is
merged into the existing `client.js` (which already registers this panel).

### 2.4 Coexistence

Both panels can be installed at once:

- sidebar entries: `OpenTake (Rust)` (iframe, order 16) and
  `OpenTake (native)` (order 17);
- main keys are distinct, so switching in the sidebar swaps the centre panel;
- no registration replaces an existing occupant.

---

## 3. Theme inheritance

The native chrome is rendered in the DSH document and uses **only**
`--dsw-alias-*` theme tokens from the live catalog of this DSH build. `.otn-`
classes are injected by one `<style>` element inside `ctx.effect`; there are no
global selectors (`html`/`body`/`:root`), no hard-coded colours and no
`document.body` portals.

| Token | Element |
|---|---|
| `--dsw-alias-bg-base` | root and iframe background |
| `--dsw-alias-bg-layer-1` | header background |
| `--dsw-alias-bg-layer-2` | button hover, content region |
| `--dsw-alias-border-l1` / `-l2` | note/status separators, button borders |
| `--dsw-alias-label-primary` | title, button text |
| `--dsw-alias-label-secondary` | status detail, note, badge fallback |
| `--dsw-alias-state-idle-primary` | "checking" badge |
| `--dsw-alias-state-success-primary` | "engine ready" badge |
| `--dsw-alias-state-warn-primary` | "status unavailable" badge |
| `--dsw-alias-state-error-primary` | "engine failed to load" badge |
| `--dsw-alias-brand-primary` | focus ring |

The **iframe content keeps the editor's own dark theme** (`web/src/styles/tokens.css`
defines 151 vars on its own `:root`, dark-only). On a light DSH theme the
native header is light while the editor body stays dark; that mismatch is
deliberate for this slice and disappears when the editor mounts natively
(theme mapping is tracked in the inventory doc, blocker B5).

No CSS from the editor document leaks into DSH: the iframe is a separate
document.

---

## 4. Locale inheritance

- Namespace: `opentake-native`.
- `const t = ctx.locale.bind('opentake-native')` in `apply` (for the sidebar
  label), and `locale: 'opentake-native'` on the `main` registration so the DSH
  slot renderer passes a bound `t` prop to `OpenTakeNativeShell` — the installed
  renderer does exactly this for entries that declare `locale`
  (`lib/types/client/scoped-slots.js` in `@deepseek-ai/dsh-client-ui-renderer`).
- Dictionaries registered via
  `ctx.effect(() => ctx.locale.register('opentake-native', { en, zh }), …)`:
  identical key sets, matching `{placeholder}` sets, English + Simplified
  Chinese.
- Keys: `nav`, `title`, `status.checking`,
  `status.checkingDetail`, `status.ready`, `status.engineDetail`,
  `status.engineError`, `status.engineErrorDetail`, `status.loadErrorDetail`,
  `status.unavailable`, `common.unknown`, `action.retry`, `action.reload`,
  `editorTitle`, `note.iframe`, `error.network`, `error.http`,
  `error.invalidResponse`, `error.generic`.
- Locale switching re-renders the panel (locale snapshot revision) and re-reads
  the sidebar `label` thunk.
- The iframe editor keeps its own independent i18n (`web/src/i18n`, default
  `zh-CN`, persisted in `localStorage["locale"]` inside the iframe origin). A
  locale switch in DSH updates the native shell only; during A/B the two
  languages can differ. Follow-up: bridge DSH locale into the editor once the
  native mount exists.

---

## 5. CSP and same-origin contract

Everything the shell does is same-origin, so no CORS configuration or CSP
loosening is required:

| Request | When | Notes |
|---|---|---|
| `GET /opentake-studio-route-b/engine/info` | mount + every 10 s while visible + Retry | `cache: 'no-store'`, `credentials: 'same-origin'`, `method: 'GET'` |
| `GET /opentake-studio-route-b/app/` (iframe `src`) | mount | existing built editor; same-origin frame |

Engine route auth is the Host's existing policy fence: the route calls
`connection.requestRejection(req)`; a missing fence answers `503`
`{ error: { code: 'connection-untrusted' } }`, a browser outside the DSH
connection policy gets `403` `{ error: { code: 'forbidden' } }`. The shell maps
both to the **unavailable** badge with the localized HTTP message.

The iframe's own document is served by the Host `serveStatic` path
(`plugins/opentake-studio-route-b/index.js` `serveStatic`) with only
`content-type` and `cache-control` headers — no CSP and no `X-Frame-Options`.
Embedding therefore depends on the **DSH page CSP** allowing a same-origin
frame (`frame-src 'self'`, or no frame restriction); the working prototype in
this build is the evidence that it does. This slice does not change any CSP.

Native shell constraints honoured:

- no inline `<script>`, no `eval`, no external CDN/origin, no loopback URLs;
- the shell injects two scoped `<style>` elements (native chrome + mirrored
  iframe prototype), the same mechanism shipped client plugins and the
  prototype already use under `style-src`;
- any future DSH CSP tightening (`frame-src`) would only affect the iframe
  body; the native header/status keeps working.

---

## 6. Lifecycle and cleanup

Plugin level (`ctx.effect`, disposed when the plugin fiber unloads):

| Effect | Cleanup |
|---|---|
| `ctx.locale.register('opentake-native', { en, zh })` | locale disposer |
| native `<style data-opentake-native="shell">` | `style.remove()` |
| `slots.inject('sidebar.panellist', …)` | slot unregister |
| `slots.inject('main', …)` | slot unregister |
| iframe prototype `<style data-opentake-iframe="prototype">` (flag) | `style.remove()` |
| iframe `sidebar.panellist` + `main` (flag, 2 effects) | slot unregister |

Component level (`OpenTakeNativeShell`):

- one `useEffect` (dependency `[retryNonce]`) owns the whole status poll:
  - initial `load(true)` on mount;
  - `setInterval(load, 10000)` — both interval ticks and visibility handling
    skip while `document.visibilityState === 'hidden'`;
  - a `visibilitychange` listener refreshes immediately when the panel becomes
    visible;
  - an `inFlight` guard prevents overlapping requests;
  - cleanup sets `disposed`, clears the interval, removes the listener and
    aborts the in-flight request (`AbortController`), so panel unmount cannot
    leak work or update state after unmount;
  - Retry increments `retryNonce`, which runs the cleanup and starts a fresh
    poll (phase returns to "checking").
- Reload increments `reloadNonce`, which changes the iframe's React `key` and
  remounts it (a real reload of the built editor; unsaved in-editor state is
  lost by design).
- No `window` listeners, no `document.body` mutation, no storage writes, no
  cross-document messaging. All cleanup is exercised by the harness.

---

## 7. Static asset strategy

- `ui/client.js` is a **single dependency-free file**. It is authored directly
  in the DSH client module format (`window.__ModuleLoader__.load`), so there is
  no build step for the native shell and nothing new to serve beyond the module
  itself. It requires only `react` from the DSH browser module table.
- The editor content keeps using the existing, checked-in Vite build served at
  `/opentake-studio-route-b/app/` (hashed assets, `--base` set at build time,
  `no-store` for `index.html`/`*.js` in `serveStatic`). This slice adds nothing
  to and removes nothing from `web/`.
- No mock/preview HTML, no fonts, icons or other assets: the sidebar glyph is
  inline SVG using `currentColor`.
- **Packaging caveat**: `plugins/opentake-studio-route-b/package.json` currently
  lists only `client.js` (not `ui/**`) in `files`, so
  `scripts/package-route-b.sh`'s `npm pack` would omit the new directory until
  the Lead adds `ui/**` (and `test/**`, if tests should ship) and points the
  `exports["./client"]` entry at the file.
- Future native editor bundle (not in this slice): build `web/` once with
  `react`/`react-dom` externalized to the DSH module table, emit a lazily
  imported chunk under `ui/editor/`, and mount it into the content region
  instead of the iframe. The static strategy is the same: same-origin files,
  hashed names, no new origin.

---

## 8. Integration options (Lead-owned change)

Exactly one client module can be the package client entry
(`exports["./client"]`, `dsh.client`). Three viable integrations:

### Option A — replace the client entry (smallest change)

1. Set `exports["./client"] = "./ui/client.js"` (or copy the file over
   `client.js`).
2. Add `ui/**` to `package.json` `files`.
3. Leave `INCLUDE_IFRAME_PROTOTYPE = true`.

Result: both panels are registered from one module — the existing iframe
prototype (order 16) and the new native shell (order 17). `client.js` becomes
unused; keep it in the tree until parity, as the reference implementation.

### Option B — merge the native registration into `client.js`

Copy the native-only pieces from `ui/client.js` into `client.js` (the
registration block is isolated in `registerNativeShell`, with
`OpenTakeNativeShell`, `Glyph`, dictionaries and `STYLES` beside it), call
`registerNativeShell(ctx)` from `client.js`'s `apply`, and do **not** copy
`registerIframePrototype` (the file already registers that panel). This keeps
one module source and avoids duplicating the prototype code, at the cost of one
manual merge.

### Option C — separate bundle

If a second dynamic client module per package is acceptable in the installed
DSH build (not verified in this slice), publish `ui/` as its own bundle
package. Otherwise, Option A/B are the supported paths.

No Host `index.js` change is needed: the shell only uses the existing
`/engine/info` route and the existing `/app/` static mount.

### Acceptance checks after integration

```bash
node --check plugins/opentake-studio-route-b/ui/client.js
node --test plugins/opentake-studio-route-b/test/ui-mount.test.mjs
```

Then, in DSH:

1. `cordis_inspect_query` → `Slots.listSubTree` for `main` shows keys
   `opentake-studio-route-b` and `opentake-native`; `sidebar.panellist` shows
   both ids (`16`/`17`).
2. Page: two sidebar entries; the native panel shows the engine badge
   (`Engine ready` + plugin/platform/arch) and the editor iframe.
3. Negative paths: stop/invalid engine → `Engine failed to load` + `loadError`
   detail; blocked route (`403`/`503`) → `Engine status unavailable` + HTTP
   message.
4. Theme switch: native header follows the DSH theme; iframe body stays dark
   (documented limitation).
5. Locale switch: native labels change; iframe labels do not (documented).
6. Unload/disable the plugin: both style elements and panels disappear; no
   console errors.

---

## 9. Verification performed in this slice

| Check | Result |
|---|---|
| `node --check plugins/opentake-studio-route-b/ui/client.js` | OK (641 lines) |
| `node --check plugins/opentake-studio-route-b/test/ui-mount.test.mjs` | OK |
| `node --test plugins/opentake-studio-route-b/test/ui-mount.test.mjs` | **11/11 pass** |

The harness stubs `window.__ModuleLoader__`, `require('react')`, `document`,
`setInterval`/`clearInterval`, `AbortController` and `fetch`, and asserts:

1. bundle id equals the package name; only `require('react')`; no ESM imports,
   no `document.body`, no `localStorage`, no Tauri imports, no hex colours;
2. `inject` contract; native + mirrored iframe registrations (`main` keys,
   sidebar ids `opentake-native`/`opentake-studio-route-b`, orders 17/16,
   locale namespaces, labels, components) and 7 plugin effects with cleanups;
3. one native `.otn-` `<style>` and one iframe `.otsb-` `<style>`, scoped
   selectors only, DSH alias-token catalog only, removed on cleanup;
4. `GET /opentake-studio-route-b/engine/info` with `cache: 'no-store'`,
   `credentials: 'same-origin'`, `GET`; success normalization; `network`,
   `http-503`, `invalid-response`, abort classification; body-shape rejection;
5. polling: immediate fetch, 10 s delay, hidden-tab skip, interval and
   `visibilitychange` refresh, cleanup clears the interval, removes the
   listener and aborts the request;
6. rendered loading / ready / engine-error / unavailable states, aria-live
   status, `type="button"` actions, retry disabled while checking, interim
   iframe host with the exact `src`, and action state updates.

Not verified here: browser rendering, DSH page CSP, live slot occupancy,
engine-addon availability, or the DSH theme/locale switch — the Lead's
installation is the first browser check.

---

## 10. Migration steps (after this slice)

1. **Integrate the shell** (Lead): Option A or B in §8, package `files`, install
   the bundle, run the acceptance checks. Keep the iframe panel as the
   fallback.
2. **Add project context to the native shell** (next UI slice): read
   `GET /engine/timeline` (or `POST /engine/invoke` with `get_timeline`) to show
   project name/fps/resolution/duration/track count next to the engine badge,
   with the same poll/cleanup pattern; handle engine-not-loaded responses.
3. **Move the editor body native**: build the existing `web/src` app as a DSH
   client bundle (external `react`/`react-dom`), alias `@tauri-apps/*` to a
   Host route bridge, and scope its document-global behaviour (see
   [route-b-ui-inventory.md](route-b-ui-inventory.md) §5.2 B1–B12). Mount it
   into the content region instead of the iframe, behind a flag.
4. **Parity and cleanup**: keep the iframe panel behind a manifest flag for one
   release, then retire `INCLUDE_IFRAME_PROTOTYPE`, the mirrored prototype code
   and the hand-injected Tauri shim; update `route-b.md`/packaging docs.

---

## 11. Blockers, risks and open questions

| # | Item | Impact / owner |
|---|---|---|
| R1 | One client entry per package: `ui/client.js` and `../client.js` cannot both be loaded as separate modules | choose Option A (drop-in, both panels) or B (merge); Lead decision |
| R2 | `ui/**` is missing from `package.json` `files`; `exports["./client"]` still points at `client.js` | packaging/bundle install until Lead updates the manifest |
| R3 | Editor body is still the iframe build; native shell is chrome/status only | expected scope of this slice; native mount tracked in inventory doc |
| R4 | DSH page CSP was not observed directly; the same-origin iframe relies on current `frame-src` behaviour (prototype works) | re-verify after DSH updates; if iframe is blocked, native header still works but content needs the native mount |
| R5 | Dark editor theme vs DSH light theme mismatch inside the native panel | visual limitation until native theme mapping |
| R6 | Two sidebar entries during A/B (`OpenTake (Rust)` / `OpenTake (native)`), iframe label not localized | product decision; remove after parity |
| R7 | Engine status route reports addon load state only; no project/timeline summary yet | next UI slice (§10 step 2) |
| R8 | No SSE/push; the shell polls status every 10 s | cheap; revisit when Host adds `/engine/events` |
| R9 | The iframe reload discards in-editor state and does not coordinate with Host tools | documented button behaviour; no cross-frame messaging by design |
| R10 | `engine/info` includes `addonPath`; the shell currently renders only plugin/platform/arch and `loadError` | avoid leaking paths in UI; if engine error detail could contain a path, it is Host-provided and displayed as-is — consider truncating in a follow-up |

---

## 12. Files added

```
plugins/opentake-studio-route-b/ui/client.js             (DSH client module source)
plugins/opentake-studio-route-b/ui/README.md
plugins/opentake-studio-route-b/test/ui-mount.test.mjs   (node:test stub harness)
docs/architecture/route-b-native-ui.md                   (this document)
```

No existing files were modified; nothing was committed.


## Lead integration status (2026-11-08)

The package `exports["./client"]` now points at `ui/client.js` and the mirrored
iframe prototype registration is disabled. Live DSH verification after a plugin
reload showed the native panel `OpenTake（原生）` with engine-ready status and the
existing editor iframe rendered inside it; the old `OpenTake (Rust)` duplicate
panel is no longer registered. Editor body remains iframe by design.
