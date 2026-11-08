# Route B — DSH-native shell source

`client.js` is the **native panel source** for Route B. It is a plain DSH
client module (`window.__ModuleLoader__.load`) with no build step and no local
imports:

- registers a DSH-native **`main`** panel (`key: 'opentake-native'`) whose
  header, engine-status badge, actions and note are rendered by DSH React and
  inherit the DSH theme/locale services;
- polls the existing Host route `GET /opentake-studio-route-b/engine/info`
  every 10 s (skipped while hidden) and shows loaded / engine-error /
  unreachable states;
- still hosts the **existing built editor** in the content region as a
  same-origin iframe (`/opentake-studio-route-b/app/`) — this is the part that
  is still iframe in this slice;
- mirrors the iframe prototype panel registrations from `../client.js`
  (`INCLUDE_IFRAME_PROTOTYPE`, default `true`) so the file can replace the
  package's client entry without dropping the working panel. Set it to `false`
  when merging only the native pieces into the existing `client.js`.

It does not touch the Host plugin, `../client.js`, `../web/**`, or the existing
routes; it is additive and disposable.

## Verify

```bash
node --check plugins/opentake-studio-route-b/ui/client.js
node --test plugins/opentake-studio-route-b/test/ui-mount.test.mjs
```

The stub harness covers registration, locale dictionaries, scoped token-only
styles, the engine-status fetch contract, polling/visibility cleanup and the
rendered states.

## Integrate (Lead-owned)

See [`docs/architecture/route-b-native-ui.md`](../../../docs/architecture/route-b-native-ui.md)
for slot options, theme/locale/CSP notes, integration options and the migration
sequence.
