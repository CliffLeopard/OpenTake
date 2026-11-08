/*
 * OpenTake Studio Route B — DSH-native shell source.
 *
 * This is the first, deliberately small step off the iframe path:
 *
 *   - the OpenTake panel chrome (title, engine status, actions, note) is a
 *     normal DSH client React component mounted in the keyed `main` slot, so it
 *     inherits the DSH theme and locale services directly;
 *   - the existing built editor (`web/` served at `/opentake-studio-route-b/app/`)
 *     is still hosted in the content region as an iframe, unchanged.
 *
 * The iframe prototype in `../client.js` keeps using the `main` key
 * `opentake-studio-route-b`; this shell uses the distinct key
 * `opentake-native`, so both panels can be registered side by side while the
 * native editor mount is built out. See `docs/architecture/route-b-native-ui.md`
 * for the integration options, theme/locale contract and migration steps.
 *
 * Format: DSH client module bundle (`window.__ModuleLoader__.load`), matching
 * the DSH template and `../client.js`. Only `require('react')`; no JSX; no
 * local imports; no third-party dependencies.
 *
 * Integration note for the Host owner: this file registers ONLY the native
 * panel. To keep the iframe panel alive, either register both from one client
 * module (recommended) or install this file as a separate bundle package.
 */
window.__ModuleLoader__.load({
  id: '@opentake/studio-route-b',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by the native shell. */
    const NS = 'opentake-native'
    /** Keyed `main` slot key and `sidebar.panellist` id (distinct from the iframe key). */
    const PANEL_KEY = 'opentake-native'
    /** Route prefix served by `../index.js` (read-only for this slice). */
    const BASE = '/opentake-studio-route-b'
    /** Existing engine status route (`../index.js` GET /engine/info). */
    const INFO_PATH = BASE + '/engine/info'
    /** Existing built React editor, still hosted in an iframe for now. */
    const EDITOR_PATH = BASE + '/app/'
    /** Self-contained native editor bundle served by the existing /app/* route. */
    const NATIVE_BUNDLE_URL = BASE + '/app/native-editor/native-editor.js'
    /** Engine status poll cadence; skipped while the document is hidden. */
    const POLL_MS = 10000
    /** Existing iframe prototype panel key/id in `../client.js`. */
    const IFRAME_PANEL_ID = 'opentake-studio-route-b'
    const IFRAME_APP_PATH = BASE + '/app/'
    /**
     * Mirror the iframe prototype panel registrations from `../client.js` so
     * this file can replace the package's client entry without dropping the
     * working panel. Set to false when merging ONLY the native pieces into the
     * existing `client.js` (which already registers the iframe panel).
     */
    const INCLUDE_IFRAME_PROTOTYPE = false

    // ---------------------------------------------------------------------
    // Engine status contract
    // ---------------------------------------------------------------------

    /** Build the error thrown by the status request without leaking bodies. */
    function engineRequestError(code, message) {
      const error = new Error(message || code)
      error.name = 'EngineRequestError'
      error.code = code
      return error
    }

    function stringOrNull(value) {
      return typeof value === 'string' && value.length > 0 ? value : null
    }

    /**
     * Normalize the `GET /engine/info` payload defined by the Host plugin:
     * `{ pluginVersion, platform, arch, node, napi, addonPath, loaded, loadError }`.
     * Returns null when the body is not the shape this shell understands.
     */
    function normalizeEngineInfo(body) {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
      if (typeof body.loaded !== 'boolean') return null
      return {
        loaded: body.loaded,
        pluginVersion: stringOrNull(body.pluginVersion),
        platform: stringOrNull(body.platform),
        arch: stringOrNull(body.arch),
        node: stringOrNull(body.node),
        napi: stringOrNull(body.napi),
        addonPath: stringOrNull(body.addonPath),
        loadError: stringOrNull(body.loadError),
      }
    }

    /** True for the AbortError raised by the polling cleanup. */
    function isAbort(error) {
      return error !== null && typeof error === 'object' && error.name === 'AbortError'
    }

    /** Normalize any thrown status failure into `{ code, message }`. */
    function toFailure(thrown) {
      if (thrown !== null && typeof thrown === 'object') {
        if (typeof thrown.code === 'string' && thrown.code !== '') {
          return {
            code: thrown.code,
            message: typeof thrown.message === 'string' ? thrown.message : null,
          }
        }
        if (typeof thrown.message === 'string') return { code: 'internal', message: thrown.message }
      }
      return { code: 'internal', message: null }
    }

    /**
     * Read one engine status snapshot. Deliberately takes the fetch
     * implementation so the Node stub harness can prove the wire contract
     * without a browser.
     */
    async function requestEngineInfo(fetchImpl, options) {
      const impl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
      if (typeof impl !== 'function') throw engineRequestError('network')
      const init = {
        cache: 'no-store',
        credentials: 'same-origin',
        method: 'GET',
      }
      const signal = options !== null && options !== undefined ? options.signal : undefined
      if (signal !== undefined) init.signal = signal
      let response
      try {
        response = await impl(INFO_PATH, init)
      } catch (error) {
        if (isAbort(error)) throw error
        throw engineRequestError('network')
      }
      let body = null
      try {
        body = await response.json()
      } catch (_error) {
        body = null
      }
      if (response.ok !== true) {
        const hostError =
          body !== null && typeof body === 'object' && body.error !== null && typeof body.error === 'object'
            ? body.error
            : null
        const message =
          hostError !== null && typeof hostError.message === 'string' ? hostError.message : null
        throw engineRequestError('http-' + String(response.status), message)
      }
      const info = normalizeEngineInfo(body)
      if (info === null) throw engineRequestError('invalid-response')
      return info
    }

    /** Localized text for a status request failure. */
    function failureText(failure, t) {
      if (failure === null || typeof failure !== 'object') return t('error.generic')
      if (failure.code === 'network') return t('error.network')
      if (failure.code === 'invalid-response') return t('error.invalidResponse')
      if (typeof failure.code === 'string' && failure.code.indexOf('http-') === 0) {
        return t('error.http', { status: failure.code.slice('http-'.length) })
      }
      if (typeof failure.message === 'string' && failure.message !== '') return failure.message
      return t('error.generic')
    }

    /** Badge label + tone + detail line for the current shell state. */
    function statusPresentation(phase, engine, failure, t) {
      if (phase === 'ready' && engine !== null) {
        return {
          tone: 'success',
          label: t('status.ready'),
          detail: t('status.engineDetail', {
            version: engine.pluginVersion !== null ? engine.pluginVersion : t('common.unknown'),
            platform: engine.platform !== null ? engine.platform : t('common.unknown'),
            arch: engine.arch !== null ? engine.arch : t('common.unknown'),
          }),
        }
      }
      if (phase === 'engine-error' && engine !== null) {
        return {
          tone: 'error',
          label: t('status.engineError'),
          detail:
            engine.loadError !== null
              ? t('status.loadErrorDetail', { error: engine.loadError })
              : t('status.engineErrorDetail'),
        }
      }
      if (phase === 'unavailable') {
        return {
          tone: 'warn',
          label: t('status.unavailable'),
          detail: failureText(failure, t),
        }
      }
      return {
        tone: 'idle',
        label: t('status.checking'),
        detail: t('status.checkingDetail'),
      }
    }

    // ---------------------------------------------------------------------
    // Native editor bundle
    // ---------------------------------------------------------------------

    /** Cache one in-flight bundle import; clear it on failure so Retry works. */
    let nativeBundlePromise = null
    function loadNativeBundle() {
      if (nativeBundlePromise === null) {
        nativeBundlePromise = import(/* webpackIgnore: true */ NATIVE_BUNDLE_URL).catch((error) => {
          nativeBundlePromise = null
          throw error
        })
      }
      return nativeBundlePromise
    }

    /** Read the current DSH language without mutating the page. */
    function resolveNativeLocale() {
      if (
        typeof document !== 'undefined' &&
        document.documentElement !== null &&
        document.documentElement !== undefined &&
        typeof document.documentElement.lang === 'string' &&
        document.documentElement.lang.length > 0
      ) {
        return document.documentElement.lang
      }
      return 'en'
    }

    /** Read an explicit DSH theme marker when present; tokens still drive CSS. */
    function resolveNativeTheme() {
      if (
        typeof document !== 'undefined' &&
        document.documentElement !== null &&
        document.documentElement !== undefined &&
        document.documentElement.dataset !== undefined
      ) {
        const value = document.documentElement.dataset.theme
        if (value === 'light' || value === 'dark') return value
      }
      return 'system'
    }

    // ---------------------------------------------------------------------
    // Component
    // ---------------------------------------------------------------------

    /**
     * Native shell: DSH-themed header + engine status + iframe editor body.
     * `t` is supplied by the slot renderer because the registration declares
     * `locale: NS`.
     */
    function OpenTakeNativeShell({ t }) {
      const [phase, setPhase] = React.useState('loading')
      const [engine, setEngine] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [retryNonce, setRetryNonce] = React.useState(0)
      const [reloadNonce, setReloadNonce] = React.useState(0)
      const [mode, setMode] = React.useState('iframe')
      const [nativePhase, setNativePhase] = React.useState('idle')
      const [nativeFailure, setNativeFailure] = React.useState(null)
      const [nativeRetry, setNativeRetry] = React.useState(0)
      const nativeHostRef = React.useRef(null)
      const uid = React.useId()
      const headingId = uid + '-otn-heading'

      // Poll the existing Host status route; one initial fetch, then every
      // POLL_MS while visible. Re-runs on Retry. All resources are released in
      // the cleanup so panel unmount cannot leak a timer, listener or request.
      React.useEffect(() => {
        let disposed = false
        let inFlight = false
        let timer = 0
        const controller =
          typeof AbortController === 'function' ? new AbortController() : null
        setPhase('loading')
        const load = async (initial) => {
          if (disposed || inFlight) return
          if (
            !initial &&
            typeof document !== 'undefined' &&
            document.visibilityState === 'hidden'
          ) {
            return
          }
          inFlight = true
          try {
            const info = await requestEngineInfo(
              typeof fetch === 'function' ? fetch : undefined,
              controller === null ? undefined : { signal: controller.signal },
            )
            if (disposed) return
            setEngine(info)
            setFailure(null)
            setPhase(info.loaded ? 'ready' : 'engine-error')
          } catch (error) {
            if (!disposed && !isAbort(error)) {
              setFailure(toFailure(error))
              setPhase('unavailable')
            }
          } finally {
            inFlight = false
          }
        }
        void load(true)
        timer = setInterval(() => {
          void load(false)
        }, POLL_MS)
        const onVisibilityChange = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
            void load(false)
          }
        }
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibilityChange)
        }
        return () => {
          disposed = true
          clearInterval(timer)
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibilityChange)
          }
          if (controller !== null) controller.abort()
        }
      }, [retryNonce])

      // Mount the native editor only while it is selected. The iframe stays
      // mounted underneath, so switching back restores the working editor
      // without reloading it. The bundle import and controller are disposed
      // together when the mode changes or the panel unmounts.
      React.useEffect(() => {
        if (mode !== 'native' || nativeHostRef.current === null) return undefined
        let disposed = false
        let controller = null
        setNativePhase('loading')
        setNativeFailure(null)
        loadNativeBundle()
          .then((bundle) => {
            if (disposed) return
            if (bundle === null || typeof bundle.mountNative !== 'function') {
              throw new Error('native editor bundle has no mountNative export')
            }
            controller = bundle.mountNative({
              host: nativeHostRef.current,
              base: BASE,
              locale: resolveNativeLocale(),
              theme: resolveNativeTheme(),
              pollIntervalMs: 0,
              onReady: () => {
                if (!disposed) setNativePhase('ready')
              },
            })
            if (disposed) {
              controller.dispose()
              controller = null
            }
          })
          .catch((error) => {
            if (disposed) return
            setNativePhase('error')
            setNativeFailure(toFailure(error))
          })
        return () => {
          disposed = true
          if (controller !== null) controller.dispose()
          controller = null
        }
      }, [mode, nativeRetry])

      const presentation = statusPresentation(phase, engine, failure, t)

      return h(
        'section',
        { className: 'otn-root', 'aria-labelledby': headingId, 'data-otn-shell': 'native' },
        h(
          'header',
          { className: 'otn-header' },
          h(
            'div',
            { className: 'otn-heading' },
            h('h2', { id: headingId, className: 'otn-title' }, t('title')),
            h(
              'span',
              {
                className: 'otn-badge otn-badge--' + presentation.tone,
                'data-otn-phase': phase,
              },
              presentation.label,
            ),
          ),
          h(
            'div',
            { className: 'otn-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'otn-button',
                'data-otn-action': 'toggle-mode',
                'aria-pressed': mode === 'native',
                onClick: () => setMode((value) => (value === 'native' ? 'iframe' : 'native')),
              },
              mode === 'native' ? t('action.showIframe') : t('action.showNative'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'otn-button',
                'data-otn-action': 'retry',
                disabled: phase === 'loading',
                onClick: () => setRetryNonce((value) => value + 1),
              },
              t('action.retry'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'otn-button',
                'data-otn-action': 'reload',
                onClick: () => {
                  setReloadNonce((value) => value + 1)
                  if (mode === 'native') setNativeRetry((value) => value + 1)
                },
              },
              t('action.reload'),
            ),
          ),
        ),
        h('p', { className: 'otn-detail', 'aria-live': 'polite' }, presentation.detail),
        h(
          'div',
          { className: 'otn-content', 'data-otn-mode': mode },
          h('iframe', {
            key: 'otn-editor-' + reloadNonce,
            className: 'otn-frame' + (mode === 'native' ? ' otn-frame--hidden' : ''),
            src: EDITOR_PATH,
            title: t('editorTitle'),
            allow: 'clipboard-read; clipboard-write; fullscreen',
            'data-otn-editor': 'iframe',
          }),
          h('div', {
            ref: nativeHostRef,
            className: 'otn-native-host' + (mode === 'iframe' ? ' otn-native-host--hidden' : ''),
            'data-otn-editor': 'native',
          }),
          mode === 'native' && nativePhase === 'loading'
            ? h(
                'p',
                { className: 'otn-native-state', role: 'status', 'data-otn-native-state': 'loading' },
                t('native.loading'),
              )
            : null,
          mode === 'native' && nativePhase === 'error'
            ? h(
                'div',
                { className: 'otn-native-state otn-native-state--error', role: 'alert', 'data-otn-native-state': 'error' },
                h('span', null, t('native.error') + ': ' + failureText(nativeFailure, t)),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'otn-button',
                    'data-otn-action': 'retry-native',
                    onClick: () => setNativeRetry((value) => value + 1),
                  },
                  t('action.retryNative'),
                ),
              )
            : null,
        ),
        h('p', { className: 'otn-note' }, mode === 'native' ? t('note.native') : t('note.iframe')),
      )
    }

    /** Sidebar glyph for the native panel entry (inherits currentColor). */
    function Glyph() {
      return h(
        'span',
        { className: 'otn-glyph', 'aria-hidden': 'true' },
        h(
          'svg',
          { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none' },
          h('rect', {
            key: 'body',
            x: 1.5,
            y: 2.5,
            width: 13,
            height: 11,
            rx: 2,
            stroke: 'currentColor',
            strokeWidth: 1.2,
          }),
          h('path', {
            key: 'split',
            d: 'M5.5 2.5v11M10.5 2.5v11',
            stroke: 'currentColor',
            strokeWidth: 1.2,
          }),
          h('path', {
            key: 'spark',
            d: 'M7 6.2l1 1.8 1-1.8',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Iframe prototype (mirrors ../client.js; kept while the native editor
    // mount is unfinished). This is what is still iframe in this slice.
    // ---------------------------------------------------------------------

    /** The existing built React editor, hosted unchanged in a same-origin iframe. */
    function IframeEditorPage() {
      return h(
        'div',
        { className: 'otsb-root', 'data-otn-editor': 'iframe-prototype' },
        h('iframe', {
          key: 'iframe-editor',
          className: 'otsb-frame',
          src: IFRAME_APP_PATH,
          title: 'OpenTake Studio',
          allow: 'clipboard-read; clipboard-write; fullscreen',
        }),
      )
    }

    /** Sidebar glyph for the iframe prototype entry. */
    function IframeGlyph() {
      return h(
        'span',
        { className: 'otsb-glyph', 'aria-hidden': 'true' },
        h(
          'svg',
          { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none' },
          h('rect', {
            key: 'a',
            x: 1.5,
            y: 2.5,
            width: 13,
            height: 11,
            rx: 2,
            stroke: 'currentColor',
            strokeWidth: 1.2,
          }),
          h('path', {
            key: 'b',
            d: 'M5 2.5v11M11 2.5v11',
            stroke: 'currentColor',
            strokeWidth: 1.2,
          }),
        ),
      )
    }

    /** Register the existing iframe panel exactly as `../client.js` does. */
    function registerIframePrototype(ctx) {
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const style = document.createElement('style')
        style.setAttribute('data-opentake-iframe', 'prototype')
        style.textContent = [
          '.otsb-root{position:relative;display:flex;flex:1 1 auto;min-width:0;min-height:0;height:100%;background:var(--dsw-alias-bg-base)}',
          '.otsb-frame{display:block;flex:1 1 auto;width:100%;height:100%;min-width:0;min-height:0;border:0;background:var(--dsw-alias-bg-base)}',
          '.otsb-glyph{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:currentColor}',
        ].join('')
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, 'opentake-native: iframe prototype styles')
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: IFRAME_PANEL_ID,
                order: 16,
                locale: IFRAME_PANEL_ID,
                label: () => 'OpenTake (Rust)',
              },
              IframeGlyph,
            ),
          ),
        'opentake-native: iframe prototype sidebar entry',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: IFRAME_PANEL_ID,
                locale: IFRAME_PANEL_ID,
              },
              IframeEditorPage,
            ),
          ),
        'opentake-native: iframe prototype main panel',
      )
    }

    // ---------------------------------------------------------------------
    // Locale dictionaries (en / zh — identical key sets)
    // ---------------------------------------------------------------------

    /** English copy. */
    const en = {
      nav: 'OpenTake (native)',
      title: 'OpenTake',
      'status.checking': 'Checking engine…',
      'status.checkingDetail': 'Reading the in-process Rust engine status.',
      'status.ready': 'Engine ready',
      'status.engineDetail': 'v{version} · {platform}/{arch}',
      'status.engineError': 'Engine failed to load',
      'status.engineErrorDetail': 'The native addon is unavailable; the iframe editor may also fail.',
      'status.loadErrorDetail': 'Load error: {error}',
      'status.unavailable': 'Engine status unavailable',
      'common.unknown': 'unknown',
      'action.retry': 'Retry',
      'action.retryNative': 'Retry native preview',
      'action.reload': 'Reload editor',
      'action.showNative': 'Native preview',
      'action.showIframe': 'Iframe editor',
      'native.loading': 'Starting native editor…',
      'native.error': 'Native editor failed to start',
      'editorTitle': 'OpenTake editor (iframe)',
      'note.iframe':
        'Native shell: header, status, theme and locale are DSH-native. The editor content is the working iframe build; switch to native preview for the bounded ShadowRoot mount.',
      'note.native':
        'Native preview: home, media, timeline and preview run in a ShadowRoot against the live /engine routes. Inspector, effects, export, motion and the rest remain in the iframe fallback.',
      'error.network': 'Could not reach the Route B engine route.',
      'error.http': 'Engine status request failed (HTTP {status}).',
      'error.invalidResponse': 'The engine status response was not valid JSON.',
      'error.generic': 'Something went wrong.',
    }

    /** Simplified Chinese copy. */
    const zh = {
      nav: 'OpenTake（原生）',
      title: 'OpenTake',
      'status.checking': '正在检查引擎…',
      'status.checkingDetail': '正在读取进程内 Rust 引擎状态。',
      'status.ready': '引擎就绪',
      'status.engineDetail': 'v{version} · {platform}/{arch}',
      'status.engineError': '引擎加载失败',
      'status.engineErrorDetail': '原生插件不可用；iframe 编辑器也可能无法使用。',
      'status.loadErrorDetail': '加载错误：{error}',
      'status.unavailable': '引擎状态不可用',
      'common.unknown': '未知',
      'action.retry': '重试',
      'action.retryNative': '重试原生预览',
      'action.reload': '重新加载编辑器',
      'action.showNative': '原生预览',
      'action.showIframe': 'Iframe 编辑器',
      'native.loading': '正在启动原生编辑器…',
      'native.error': '原生编辑器启动失败',
      'editorTitle': 'OpenTake 编辑器（iframe）',
      'note.iframe':
        '原生外壳：标题栏、状态、主题与语言由 DSH 原生提供；编辑器内容是可用的 iframe 构建；切换到原生预览可使用有界的 ShadowRoot 挂载。',
      'note.native':
        '原生预览：主页、素材、时间线和预览在 ShadowRoot 中运行并连接实时 /engine 路由。检查器、效果、导出、Motion 等仍保留在 iframe 回退中。',
      'error.network': '无法连接 Route B 引擎路由。',
      'error.http': '引擎状态请求失败（HTTP {status}）。',
      'error.invalidResponse': '引擎状态响应不是有效的 JSON。',
      'error.generic': '出了点问题。',
    }

    // ---------------------------------------------------------------------
    // Scoped styles: `.otn-` only, DSH alias theme tokens only.
    // The iframe document keeps the editor's own dark theme; this chrome
    // follows the surrounding DSH theme.
    // ---------------------------------------------------------------------

    const STYLES = [
      '.otn-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.otn-header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}',
      '.otn-heading{display:flex;align-items:center;gap:10px;min-width:0}',
      '.otn-title{margin:0;font-size:15px;font-weight:600;line-height:22px;white-space:nowrap}',
      '.otn-badge{display:inline-flex;align-items:center;gap:6px;padding:1px 10px;border:.5px solid color-mix(in srgb,var(--otn-tone,var(--dsw-alias-label-secondary)) 28%,transparent);border-radius:999px;background:color-mix(in srgb,var(--otn-tone,var(--dsw-alias-label-secondary)) 10%,transparent);color:var(--otn-tone,var(--dsw-alias-label-secondary));font-size:12px;font-weight:500;line-height:18px;white-space:nowrap}',
      '.otn-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.otn-badge--idle{--otn-tone:var(--dsw-alias-state-idle-primary)}',
      '.otn-badge--success{--otn-tone:var(--dsw-alias-state-success-primary)}',
      '.otn-badge--warn{--otn-tone:var(--dsw-alias-state-warn-primary)}',
      '.otn-badge--error{--otn-tone:var(--dsw-alias-state-error-primary)}',
      '.otn-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.otn-button{appearance:none;padding:5px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:500;line-height:18px;cursor:pointer}',
      '.otn-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.otn-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.otn-button:disabled{opacity:.5;cursor:default}',
      '.otn-detail{margin:0;padding:8px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.otn-content{position:relative;flex:1 1 auto;min-height:0;background:var(--dsw-alias-bg-layer-2)}',
      '.otn-frame{display:block;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base)}',
      '.otn-frame--hidden{display:none}',
      '.otn-native-host{position:absolute;inset:0;display:block;min-width:0;min-height:0}',
      '.otn-native-host--hidden{display:none}',
      '.otn-native-state{position:absolute;left:14px;bottom:14px;z-index:2;display:flex;align-items:center;gap:10px;margin:0;padding:7px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;box-shadow:0 6px 20px rgba(0,0,0,.22)}',
      '.otn-native-state--error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary);max-width:min(520px,calc(100% - 28px));flex-wrap:wrap;background:var(--dsw-alias-bg-layer-1)}',
      '.otn-note{margin:0;padding:6px 14px;border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.otn-glyph{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:currentColor}',
    ].join('')

    // ---------------------------------------------------------------------
    // DSH registration
    // ---------------------------------------------------------------------

    /**
     * Register the native panel. Isolated so the Host owner can merge this
     * body into an existing client module that also keeps the iframe panel.
     */
    function registerNativeShell(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'opentake-native: dictionaries')
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const style = document.createElement('style')
        style.setAttribute('data-opentake-native', 'shell')
        style.textContent = STYLES
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, 'opentake-native: shell styles')
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_KEY,
                order: 17,
                locale: NS,
                label: () => t('nav'),
              },
              Glyph,
            ),
          ),
        'opentake-native: sidebar entry',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_KEY,
                locale: NS,
              },
              OpenTakeNativeShell,
            ),
          ),
        'opentake-native: main panel',
      )
    }

    function apply(ctx) {
      registerNativeShell(ctx)
      if (INCLUDE_IFRAME_PROTOTYPE) registerIframePrototype(ctx)
    }

    /**
     * Extra surface for the Node stub harness and for Host integration code
     * that may want the pure status helpers without mounting the component.
     * DSH itself only consumes `inject` and `apply`.
     */
    const internals = Object.freeze({
      NS,
      PANEL_KEY,
      IFRAME_PANEL_ID,
      IFRAME_APP_PATH,
      INCLUDE_IFRAME_PROTOTYPE,
      BASE,
      INFO_PATH,
      EDITOR_PATH,
      NATIVE_BUNDLE_URL,
      POLL_MS,
      requestEngineInfo,
      normalizeEngineInfo,
      statusPresentation,
      failureText,
      registerNativeShell,
      component: OpenTakeNativeShell,
      STYLES,
      dictionaries: Object.freeze({ en, zh }),
    })

    return { inject: ['slots', 'locale'], apply, internals }
  },
})
