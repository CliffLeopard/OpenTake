/**
 * Node stub harness for the Route B DSH-native shell
 * (`plugins/opentake-studio-route-b/ui/client.js`).
 *
 * No browser: the harness stubs `window.__ModuleLoader__`, `require('react')`,
 * the document, timers, AbortController and `fetch`. It proves:
 *   1. the module format and factory contract;
 *   2. `settings`/slot registration options (native `main` panel + sidebar
 *      entry) and en/zh dictionary parity;
 *   3. scoped `.otn-` styles injected through `ctx.effect` and removed by the
 *      cleanup, using only DSH alias theme tokens;
 *   4. the exact `GET /opentake-studio-route-b/engine/info` fetch contract and
 *      its error classification;
 *   5. component polling: initial fetch, 10 s interval, hidden-document skip,
 *      visibility refresh, and full cleanup (interval, listener, abort);
 *   6. rendered states (loading / ready / engine-error / unavailable) and the
 *      interim iframe editor host.
 *
 * Run: node --test plugins/opentake-studio-route-b/test/ui-mount.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const CLIENT_PATH = path.join(PLUGIN_ROOT, 'ui', 'client.js')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

/** DSH theme tokens available to dynamic client plugins in this build. */
const DSH_ALIAS_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
])

/** Minimal English templates used by the translator stub. */
const TEMPLATES = {
  'status.engineDetail': 'v{version} · {platform}/{arch}',
  'status.loadErrorDetail': 'Load error: {error}',
  'error.http': 'Engine status request failed (HTTP {status}).',
}

function translate(key, params) {
  const template = TEMPLATES[key] !== undefined ? TEMPLATES[key] : key
  if (params === undefined || params === null) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

// ---------------------------------------------------------------------------
// DOM / React / VM stubs
// ---------------------------------------------------------------------------

function createDocumentStub() {
  const head = {
    children: [],
    appendChild(element) {
      this.children.push(element)
    },
    removeChild(element) {
      const index = this.children.indexOf(element)
      if (index !== -1) this.children.splice(index, 1)
    },
  }
  const listeners = new Map()
  const document = {
    visibilityState: 'visible',
    head,
    createElement(tag) {
      const element = {
        tagName: String(tag).toUpperCase(),
        textContent: '',
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        remove() {
          const index = head.children.indexOf(element)
          if (index !== -1) head.children.splice(index, 1)
        },
      }
      return element
    },
    addEventListener(name, handler) {
      const list = listeners.get(name)
      if (list === undefined) listeners.set(name, [handler])
      else list.push(handler)
    },
    removeEventListener(name, handler) {
      const list = listeners.get(name)
      if (list === undefined) return
      const index = list.indexOf(handler)
      if (index !== -1) list.splice(index, 1)
    },
  }
  return { document, head, listeners }
}

function flattenChildren(children) {
  return children
    .flat(Infinity)
    .filter((child) => child !== null && child !== undefined && child !== false)
}

function createReactStub(options = {}) {
  const overrides = options.overrides || {}
  const runEffects = options.runEffects === true
  const updates = []
  const effectCleanups = []
  let state = []
  let cursor = 0
  const react = {
    updates,
    effectCleanups,
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: flattenChildren(children) }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      const value =
        Object.prototype.hasOwnProperty.call(overrides, index)
          ? overrides[index]
          : typeof initial === 'function'
            ? initial()
            : initial
      state[index] = value
      const setState = (next) => {
        const current = state[index]
        const resolved = typeof next === 'function' ? next(current) : next
        state[index] = resolved
        updates.push({ index, value: resolved })
      }
      return [value, setState]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (!Object.prototype.hasOwnProperty.call(state, index)) {
        state[index] = { current: initial }
      }
      return state[index]
    },
    useId() {
      cursor += 1
      return ':otn:'
    },
    useEffect(effect) {
      cursor += 1
      if (!runEffects) return
      const cleanup = effect()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    },
    useCallback(callback) {
      cursor += 1
      return callback
    },
    /** Reset hook cursor and state between renders. */
    reset() {
      cursor = 0
      state = []
    },
  }
  return react
}

function createClientHarness(options = {}) {
  let registration = null
  const dom = createDocumentStub()
  const intervals = []
  const clearedIntervals = []
  const controllers = []
  const timers = { intervals, clearedIntervals }

  class FakeAbortController {
    constructor() {
      this.signal = { aborted: false }
      controllers.push(this)
    }
    abort() {
      this.signal.aborted = true
    }
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value
        },
      },
    },
    document: dom.document,
    console,
    fetch: options.fetch,
    setInterval(handler, delay) {
      const id = intervals.length + 1
      intervals.push({ id, handler, delay })
      return id
    },
    clearInterval(id) {
      clearedIntervals.push(id)
    },
    AbortController: FakeAbortController,
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: CLIENT_PATH })

  const requireStub = (id) => {
    assert.equal(id, 'react', 'factory may only require react')
    return options.react
  }
  const module = registration.factory(requireStub)
  return { registration, module, dom, intervals, clearedIntervals, controllers, sandbox }
}

function createCtx() {
  const bound = { namespace: null, translator: null }
  const dictionaries = []
  const injections = []
  const registrations = []
  const effects = []
  const ctx = {
    locale: {
      bind(namespace) {
        bound.namespace = namespace
        bound.translator = translate
        return translate
      },
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
    },
    slots: {
      inject(name, factory) {
        injections.push(name)
        return factory()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect(effect, label) {
      const cleanup = effect()
      effects.push({ label, cleanup })
      return () => {}
    },
  }
  return { ctx, bound, dictionaries, injections, registrations, effects }
}

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

function collect(root) {
  const elements = []
  walk(root, (node) => elements.push(node))
  return elements
}

function textContent(root) {
  const texts = []
  walk(root, (node) => {
    for (const child of node.children || []) {
      if (typeof child === 'string') texts.push(child)
    }
  })
  return texts.join(' ')
}

/** Let the shell's async fetch chain settle (fetch -> json -> state updates). */
async function flushMicrotasks(count = 24) {
  for (let index = 0; index < count; index += 1) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// 1. Module format + registration
// ---------------------------------------------------------------------------

test('bundle id, factory contract and source constraints', () => {
  assert.ok(SOURCE.includes('window.__ModuleLoader__.load('), 'module loader wrapper')
  assert.ok(SOURCE.includes("id: '@opentake/studio-route-b'"), 'bundle id equals package name')
  const required = [...SOURCE.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2])
  assert.ok(required.length > 0)
  for (const id of required) assert.equal(id, 'react')
  assert.ok(!/^\s*import\s/m.test(SOURCE), 'no ESM imports')
  assert.ok(!/\bdocument\.body\b/.test(SOURCE), 'no document.body portals')
  assert.ok(!/\blocalStorage\b/.test(SOURCE), 'no localStorage')
  assert.ok(!/@tauri-apps/.test(SOURCE), 'no Tauri imports in the native shell')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(SOURCE), 'no hard-coded hex colors')
})

test('apply registers native main panel and sidebar entry', () => {
  const react = createReactStub()
  const harness = createClientHarness({ react })
  assert.ok(harness.registration, 'loader captured the registration')
  assert.equal(harness.registration.id, '@opentake/studio-route-b')
  assert.deepEqual([...harness.module.inject], ['slots', 'locale'])
  assert.equal(typeof harness.module.apply, 'function')

  const { ctx, bound, dictionaries, injections, registrations, effects } = createCtx()
  harness.module.apply(ctx)

  assert.equal(bound.namespace, 'opentake-native')

  // Dictionaries
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'opentake-native')
  const { en, zh } = dictionaries[0].dicts
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'en/zh key sets differ')
  for (const key of Object.keys(en)) {
    assert.equal(typeof en[key], 'string', 'en ' + key)
    assert.equal(typeof zh[key], 'string', 'zh ' + key)
    const enParams = [...en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    const zhParams = [...zh[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    assert.deepEqual(zhParams, enParams, 'placeholder mismatch for ' + key)
  }
  for (const key of [
    'nav',
    'title',
    'status.checking',
    'status.checkingDetail',
    'status.ready',
    'status.engineDetail',
    'status.engineError',
    'status.engineErrorDetail',
    'status.loadErrorDetail',
    'status.unavailable',
    'common.unknown',
    'action.retry',
    'action.reload',
    'editorTitle',
    'note.iframe',
    'error.network',
    'error.http',
    'error.invalidResponse',
    'error.generic',
  ]) {
    assert.ok(key in en, 'missing dictionary key ' + key)
  }

  // Slot registrations: native panel only (the old iframe entry is not mirrored).
  assert.deepEqual(injections, ['sidebar.panellist', 'main'])
  assert.equal(registrations.length, 2)
  assert.equal(harness.module.internals.INCLUDE_IFRAME_PROTOTYPE, false)

  const nativeSidebar = registrations[0]
  const nativeMain = registrations[1]

  assert.equal(nativeSidebar.options.name, 'sidebar.panellist')
  assert.equal(nativeSidebar.options.id, 'opentake-native')
  assert.equal(nativeSidebar.options.order, 17)
  assert.equal(nativeSidebar.options.locale, 'opentake-native')
  assert.equal(typeof nativeSidebar.options.label, 'function')
  assert.equal(nativeSidebar.options.label(), 'nav')
  assert.equal(typeof nativeSidebar.component, 'function')

  assert.equal(nativeMain.options.name, 'main')
  assert.equal(nativeMain.options.key, 'opentake-native')
  assert.equal(nativeMain.options.locale, 'opentake-native')
  assert.equal(nativeMain.component, harness.module.internals.component)

  // Effects: dictionary, native styles, sidebar and main slots.
  assert.equal(effects.length, 4)
  for (const effect of effects) {
    assert.equal(typeof effect.cleanup, 'function', 'effect cleanup for ' + effect.label)
    assert.ok(String(effect.label).includes('opentake-native'))
  }
})

test('scoped style effects insert .otn-/ .otsb- styles and remove them on cleanup', () => {
  const harness = createClientHarness({ react: createReactStub() })
  const { ctx, effects } = createCtx()
  harness.module.apply(ctx)

  assert.equal(harness.dom.head.children.length, 1, 'native style element')
  const nativeStyle = harness.dom.head.children.find(
    (element) => element.attributes['data-opentake-native'] === 'shell',
  )
  assert.ok(nativeStyle, 'native style element')
  assert.equal(nativeStyle.tagName, 'STYLE')
  assert.ok(nativeStyle.textContent.includes('.otn-root'), 'root class')
  assert.ok(nativeStyle.textContent.includes('.otn-badge--success'), 'state classes')

  // Scoped: every selector uses the plugin prefix; no global element/root selectors.
  for (const [css, prefix] of [
    [nativeStyle.textContent, 'otn-'],
  ]) {
    assert.ok(!/:root|(^|[,{}])\s*(html|body)\s*[,{]/m.test(css), 'no global selectors')
    const selectors = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])
    assert.ok(selectors.length > 0)
    for (const selector of selectors) {
      assert.ok(selector.startsWith(prefix), 'unscoped class ' + selector)
    }
    // Theme tokens must come from the live DSH alias catalog.
    const tokens = [...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0])
    assert.ok(tokens.length > 0)
    for (const token of tokens) {
      assert.ok(DSH_ALIAS_TOKENS.has(token), 'token outside catalog: ' + token)
    }
  }

  // Native style cleanup removes the style; all cleanups are safe.
  const nativeStyleEffect = effects.find(
    (entry) => String(entry.label).includes('shell styles'),
  )
  nativeStyleEffect.cleanup()
  assert.equal(harness.dom.head.children.length, 0)
})

// ---------------------------------------------------------------------------
// 2. Fetch contract
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

test('engine status fetch uses the exact route and request shape', async () => {
  const harness = createClientHarness({ react: createReactStub() })
  const { requestEngineInfo } = harness.module.internals
  const calls = []
  const body = {
    pluginVersion: '0.1.0',
    platform: 'darwin',
    arch: 'arm64',
    node: '26.13.0',
    napi: '8',
    addonPath: '/tmp/opentake_engine_v2.node',
    loaded: true,
    loadError: null,
  }
  const info = await requestEngineInfo((url, init) => {
    calls.push({ url, init })
    return Promise.resolve(jsonResponse(body))
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/opentake-studio-route-b/engine/info')
  assert.equal(calls[0].init.cache, 'no-store')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(info.loaded, true)
  assert.equal(info.pluginVersion, '0.1.0')
  assert.equal(info.platform, 'darwin')
  assert.equal(info.arch, 'arm64')
  assert.equal(info.loadError, null)
})

test('engine status fetch classifies failures without leaking bodies', async () => {
  const harness = createClientHarness({ react: createReactStub() })
  const { requestEngineInfo, normalizeEngineInfo } = harness.module.internals

  await assert.rejects(
    requestEngineInfo(() => Promise.reject(new TypeError('fetch failed'))),
    (error) => error.code === 'network',
  )

  await assert.rejects(
    requestEngineInfo(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: 'connection-untrusted', message: 'no request fence' } },
          503,
        ),
      ),
    ),
    (error) => error.code === 'http-503' && error.message === 'no request fence',
  )

  await assert.rejects(
    requestEngineInfo(() => Promise.resolve(jsonResponse({ not: 'engine info' }))),
    (error) => error.code === 'invalid-response',
  )

  await assert.rejects(
    requestEngineInfo(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json() {
          return Promise.reject(new SyntaxError('bad json'))
        },
      }),
    ),
    (error) => error.code === 'invalid-response',
  )

  const abort = new Error('aborted')
  abort.name = 'AbortError'
  await assert.rejects(
    requestEngineInfo(() => Promise.reject(abort)),
    (error) => error.name === 'AbortError',
  )

  assert.equal(normalizeEngineInfo(null), null)
  assert.equal(normalizeEngineInfo({}), null)
  assert.equal(normalizeEngineInfo({ loaded: 'yes' }), null)
  const partial = normalizeEngineInfo({ loaded: false })
  assert.deepEqual(
    { loaded: partial.loaded, pluginVersion: partial.pluginVersion, loadError: partial.loadError },
    { loaded: false, pluginVersion: null, loadError: null },
  )
})

// ---------------------------------------------------------------------------
// 3. Polling lifecycle
// ---------------------------------------------------------------------------

test('component polls once, on interval, on visibility, and cleans everything up', async () => {
  const calls = []
  const fetchStub = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve(
      jsonResponse({
        pluginVersion: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        node: '26.13.0',
        napi: '8',
        addonPath: '/tmp/opentake_engine_v2.node',
        loaded: true,
        loadError: null,
      }),
    )
  }
  const react = createReactStub({ runEffects: true })
  const harness = createClientHarness({ react, fetch: fetchStub })
  const { component } = harness.module.internals

  component({ t: translate })
  assert.equal(calls.length, 1, 'initial fetch on mount')
  assert.equal(calls[0].url, '/opentake-studio-route-b/engine/info')
  assert.equal(react.effectCleanups.length, 1, 'polling effect registered')
  assert.equal(harness.intervals.length, 1)
  assert.equal(harness.intervals[0].delay, 10000, '10 s poll interval')

  // Flush the initial promise; the shell stores "ready".
  await flushMicrotasks()
  assert.ok(
    react.updates.some((update) => update.index === 0 && update.value === 'ready'),
    'phase becomes ready',
  )

  // Hidden documents do no work.
  harness.dom.document.visibilityState = 'hidden'
  harness.intervals[0].handler()
  await flushMicrotasks()
  assert.equal(calls.length, 1, 'hidden tab skipped')

  // Visible interval and visibilitychange both refresh.
  harness.dom.document.visibilityState = 'visible'
  harness.intervals[0].handler()
  await flushMicrotasks()
  assert.equal(calls.length, 2, 'visible interval refresh')

  const visibilityListeners = harness.dom.listeners.get('visibilitychange') || []
  assert.equal(visibilityListeners.length, 1)
  visibilityListeners[0]()
  await flushMicrotasks()
  assert.equal(calls.length, 3, 'visibilitychange refresh')

  // Cleanup releases the interval, listener and in-flight request.
  react.effectCleanups[0]()
  assert.deepEqual(harness.clearedIntervals, [1], 'interval cleared')
  assert.equal(harness.controllers.length, 1)
  assert.equal(harness.controllers[0].signal.aborted, true, 'in-flight request aborted')
  assert.equal(harness.dom.listeners.get('visibilitychange').length, 0, 'listener removed')
})

test('failed status fetch surfaces a localized unavailable state', async () => {
  const react = createReactStub({ runEffects: true })
  const harness = createClientHarness({
    react,
    fetch: () => Promise.reject(new TypeError('offline')),
  })
  harness.module.internals.component({ t: translate })
  await flushMicrotasks()
  assert.ok(
    react.updates.some((update) => update.index === 0 && update.value === 'unavailable'),
    'phase becomes unavailable',
  )
  assert.ok(
    react.updates.some(
      (update) => update.index === 2 && update.value && update.value.code === 'network',
    ),
    'network failure recorded',
  )
  react.effectCleanups[0]()
})

// ---------------------------------------------------------------------------
// 4. Rendered states
// ---------------------------------------------------------------------------

function renderState(overrides) {
  const react = createReactStub({ overrides })
  const harness = createClientHarness({ react })
  const tree = harness.module.internals.component({ t: translate })
  return { tree, elements: collect(tree), text: textContent(tree), react }
}

const READY_ENGINE = {
  loaded: true,
  pluginVersion: '0.1.0',
  platform: 'darwin',
  arch: 'arm64',
  node: '26.13.0',
  napi: '8',
  addonPath: '/tmp/opentake_engine_v2.node',
  loadError: null,
}

test('renders the native shell + interim iframe editor when ready', () => {
  const { tree, elements, text } = renderState({ 0: 'ready', 1: READY_ENGINE })

  assert.equal(tree.type, 'section')
  assert.equal(tree.props.className, 'otn-root')
  assert.equal(tree.props['data-otn-shell'], 'native')
  const heading = elements.find((node) => node.type === 'h2')
  assert.ok(heading, 'heading')
  assert.equal(tree.props['aria-labelledby'], heading.props.id)

  const badge = elements.find((node) => String(node.props.className || '').includes('otn-badge'))
  assert.ok(badge, 'status badge')
  assert.ok(String(badge.props.className).includes('otn-badge--success'))
  assert.equal(badge.props['data-otn-phase'], 'ready')
  assert.deepEqual(badge.children, ['status.ready'])

  assert.ok(text.includes('v0.1.0 · darwin/arm64'), 'engine detail rendered')

  const iframe = elements.find((node) => node.type === 'iframe')
  assert.ok(iframe, 'iframe editor host')
  assert.equal(iframe.props.src, '/opentake-studio-route-b/app/')
  assert.equal(iframe.props.title, 'editorTitle')
  assert.equal(iframe.props['data-otn-editor'], 'iframe')

  const live = elements.find((node) => node.props['aria-live'] === 'polite')
  assert.ok(live, 'aria-live status line')

  const buttons = elements.filter((node) => node.type === 'button')
  assert.equal(buttons.length, 2)
  for (const button of buttons) assert.equal(button.props.type, 'button')
  assert.ok(buttons.every((button) => typeof button.props.onClick === 'function'))

  const note = elements.find((node) => String(node.props.className || '') === 'otn-note')
  assert.ok(note && note.children[0] === 'note.iframe')
})

test('renders the failed-engine and unreachable-engine states', () => {
  const engineError = renderState({
    0: 'engine-error',
    1: { ...READY_ENGINE, loaded: false, loadError: 'addon missing at /tmp/x.node' },
  })
  const errorBadge = engineError.elements.find((node) =>
    String(node.props.className || '').includes('otn-badge'),
  )
  assert.ok(String(errorBadge.props.className).includes('otn-badge--error'))
  assert.ok(engineError.text.includes('addon missing at /tmp/x.node'))
  assert.ok(engineError.text.includes('status.engineError'))

  const unreachable = renderState({ 0: 'unavailable', 2: { code: 'network', message: null } })
  const warnBadge = unreachable.elements.find((node) =>
    String(node.props.className || '').includes('otn-badge'),
  )
  assert.ok(String(warnBadge.props.className).includes('otn-badge--warn'))
  assert.ok(unreachable.text.includes('error.network'))

  const httpFailure = renderState({ 0: 'unavailable', 2: { code: 'http-500', message: null } })
  assert.ok(httpFailure.text.includes('HTTP 500'))

  const loading = renderState({})
  const idleBadge = loading.elements.find((node) =>
    String(node.props.className || '').includes('otn-badge'),
  )
  assert.ok(String(idleBadge.props.className).includes('otn-badge--idle'))
  assert.ok(loading.text.includes('status.checking'))
  const retry = loading.elements.find((node) => node.props['data-otn-action'] === 'retry')
  assert.equal(retry.props.disabled, true, 'retry disabled while checking')
  const reload = loading.elements.find((node) => node.props['data-otn-action'] === 'reload')
  assert.equal(reload.props.disabled, undefined, 'reload always available')
})

test('shell actions update retry/reload state through the stub setters', () => {
  const { elements, react } = renderState({ 0: 'ready', 1: READY_ENGINE })
  const retry = elements.find((node) => node.props['data-otn-action'] === 'retry')
  const reload = elements.find((node) => node.props['data-otn-action'] === 'reload')
  retry.props.onClick()
  reload.props.onClick()
  assert.ok(react.updates.some((update) => update.index === 3 && update.value === 1), 'retry nonce')
  assert.ok(react.updates.some((update) => update.index === 4 && update.value === 1), 'reload nonce')
})

// ---------------------------------------------------------------------------
// 5. Pure helper coverage
// ---------------------------------------------------------------------------

test('status helper maps every phase and failure code', () => {
  const { statusPresentation } = createClientHarness({ react: createReactStub() }).module.internals
  const t = translate
  assert.equal(statusPresentation('loading', null, null, t).tone, 'idle')
  assert.equal(statusPresentation('ready', READY_ENGINE, null, t).tone, 'success')
  assert.equal(
    statusPresentation('engine-error', { ...READY_ENGINE, loaded: false }, null, t).tone,
    'error',
  )
  assert.equal(statusPresentation('unavailable', null, { code: 'network' }, t).tone, 'warn')
  assert.equal(
    statusPresentation('unavailable', null, { code: 'invalid-response' }, t).detail,
    'error.invalidResponse',
  )
  assert.equal(
    statusPresentation('unavailable', null, { code: 'internal', message: 'boom' }, t).detail,
    'boom',
  )
})
