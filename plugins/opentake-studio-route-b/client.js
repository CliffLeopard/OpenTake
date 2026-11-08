/**
 * OpenTake Studio Route B — DSH client shell.
 *
 * The first milestone hosts the migrated OpenTake React UI in a same-origin
 * iframe served by the Host plugin. The iframe gets a small Tauri IPC shim that
 * forwards `invoke` calls to the in-process Rust engine. A later milestone can
 * replace the iframe with a bundled React mount without changing the engine
 * boundary.
 */
window.__ModuleLoader__.load({
  id: '@opentake/studio-route-b',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'opentake-studio-route-b';
    const APP_URL = '/opentake-studio-route-b/app/';

    function EditorPage() {
      return h('div', { className: 'otsb-root' }, [
        h('iframe', {
          key: 'frame',
          className: 'otsb-frame',
          src: APP_URL,
          title: 'OpenTake Studio',
          allow: 'clipboard-read; clipboard-write; fullscreen',
        }),
      ]);
    }

    function Glyph() {
      return h(
        'span',
        { className: 'otsb-glyph', 'aria-hidden': 'true' },
        h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none' }, [
          h('rect', { key: 'a', x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
          h('path', { key: 'b', d: 'M5 2.5v11M11 2.5v11', stroke: 'currentColor', strokeWidth: 1.2 }),
        ]),
      );
    }

    function apply(ctx) {
      ctx.effect(() => {
        const dispose = ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: PANEL_ID },
            EditorPage,
          ),
        );
        return dispose;
      }, 'opentake-studio-route-b: main');
      ctx.effect(() => {
        const dispose = ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 16,
              locale: PANEL_ID,
              label: () => 'OpenTake (Rust)',
            },
            Glyph,
          ),
        );
        return dispose;
      }, 'opentake-studio-route-b: sidebar');
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = PANEL_ID;
        style.textContent = `
.otsb-root{position:relative;display:flex;flex:1 1 auto;min-width:0;min-height:0;height:100%;background:var(--dsw-alias-bg-base)}
.otsb-frame{display:block;flex:1 1 auto;width:100%;height:100%;min-width:0;min-height:0;border:0;background:var(--dsw-alias-bg-base)}
.otsb-glyph{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:currentColor}
`;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'opentake-studio-route-b: styles');
    }

    return { inject: ['slots'], apply };
  },
});
