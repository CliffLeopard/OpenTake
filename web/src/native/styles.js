/**
 * ShadowRoot-scoped native-editor CSS.
 *
 * Every rule is scoped to `:host` or `.otn-*`; there is no `html`, `body`,
 * `#root`, `*` reset or DSH selector. Theme tokens are consumed from the host
 * page and fall back locally, so the iframe's app CSS and the DSH page cannot
 * leak into this tree and vice versa.
 */

export const NATIVE_EDITOR_CSS = `
:host {
  all: initial;
  display: block;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  color-scheme: dark;
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
*, *::before, *::after { box-sizing: border-box; }
.otn-root {
  position: relative;
  --otn-bg: var(--dsw-alias-bg-base, #0f1115);
  --otn-panel: var(--dsw-alias-bg-elevated, #171a21);
  --otn-panel-2: var(--dsw-alias-bg-subtle, #1e222b);
  --otn-text: var(--dsw-alias-text-primary, #f4f5f7);
  --otn-muted: var(--dsw-alias-text-secondary, #a6acb8);
  --otn-border: var(--dsw-alias-border-default, rgba(255, 255, 255, .13));
  --otn-accent: var(--dsw-alias-accent-primary, #7c5cff);
  --otn-accent-soft: color-mix(in srgb, var(--otn-accent) 20%, transparent);
  --otn-danger: var(--dsw-alias-status-error, #ff6b6b);
  --otn-radius: 10px;
  display: flex;
  flex-direction: column;
  inline-size: 100%;
  block-size: 100%;
  min-block-size: 0;
  overflow: hidden;
  background: var(--otn-bg);
  color: var(--otn-text);
  font-size: 13px;
  line-height: 1.35;
}
.otn-root[data-theme="light"] {
  color-scheme: light;
  --otn-bg: var(--dsw-alias-bg-base, #f7f7f8);
  --otn-panel: var(--dsw-alias-bg-elevated, #ffffff);
  --otn-panel-2: var(--dsw-alias-bg-subtle, #eef0f3);
  --otn-text: var(--dsw-alias-text-primary, #171a20);
  --otn-muted: var(--dsw-alias-text-secondary, #5d6470);
  --otn-border: var(--dsw-alias-border-default, rgba(20, 24, 32, .16));
}
.otn-root[data-theme="dark"] { color-scheme: dark; }
.otn-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  min-block-size: 44px;
  padding: 0 14px;
  border-block-end: 1px solid var(--otn-border);
  background: var(--otn-panel);
}
.otn-brand { display: flex; align-items: baseline; gap: 8px; min-inline-size: 0; }
.otn-brand__name { font-weight: 700; letter-spacing: -.02em; font-size: 14px; }
.otn-brand__note { color: var(--otn-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.otn-spacer { flex: 1 1 auto; }
.otn-project-path {
  max-inline-size: 34%;
  color: var(--otn-muted);
  font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.otn-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.otn-btn {
  appearance: none;
  border: 1px solid var(--otn-border);
  border-radius: 7px;
  background: var(--otn-panel-2);
  color: var(--otn-text);
  font: inherit;
  font-size: 12px;
  padding: 5px 9px;
  cursor: pointer;
  min-block-size: 28px;
}
.otn-btn:hover:not(:disabled) { border-color: var(--otn-accent); }
.otn-btn:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }
.otn-btn:disabled { opacity: .5; cursor: default; }
.otn-btn--primary { background: var(--otn-accent); border-color: var(--otn-accent); color: #fff; }
.otn-btn--icon { inline-size: 28px; padding: 4px; display: inline-grid; place-items: center; }
.otn-badge {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  border: 1px solid var(--otn-border);
  border-radius: 999px;
  padding: 3px 8px;
  color: var(--otn-muted);
  font-size: 11px;
  white-space: nowrap;
}
.otn-dot { inline-size: 6px; block-size: 6px; border-radius: 50%; background: var(--otn-accent); }
.otn-dot--down { background: var(--otn-danger); }
.otn-body { display: flex; flex: 1 1 auto; min-block-size: 0; }
.otn-main { display: flex; flex: 1 1 auto; flex-direction: column; min-inline-size: 0; min-block-size: 0; }
.otn-media {
  inline-size: clamp(180px, 22%, 270px);
  flex: 0 0 auto;
  border-inline-end: 1px solid var(--otn-border);
  background: var(--otn-panel);
  min-block-size: 0;
  display: flex;
  flex-direction: column;
}
.otn-panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
  padding: 10px 12px;
  border-block-end: 1px solid var(--otn-border);
  color: var(--otn-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .06em;
  text-transform: uppercase;
}
.otn-media-list { list-style: none; margin: 0; padding: 8px; overflow: auto; display: grid; gap: 6px; min-block-size: 0; }
.otn-media-card {
  appearance: none;
  inline-size: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--otn-panel-2);
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.otn-media-card:hover { border-color: var(--otn-border); }
.otn-media-card--selected { border-color: var(--otn-accent); background: var(--otn-accent-soft); }
.otn-media-card:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }
.otn-media-thumb {
  inline-size: 42px;
  block-size: 30px;
  border-radius: 5px;
  background: var(--otn-bg);
  object-fit: cover;
  flex: 0 0 auto;
}
.otn-media-thumb--empty { display: grid; place-items: center; color: var(--otn-muted); font-size: 10px; }
.otn-media-copy { min-inline-size: 0; display: grid; gap: 2px; }
.otn-media-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; }
.otn-media-meta { color: var(--otn-muted); font-size: 10px; }
.otn-empty { color: var(--otn-muted); font-size: 12px; padding: 16px; }
.otn-preview {
  flex: 1 1 auto;
  min-block-size: 0;
  display: flex;
  flex-direction: column;
  background: var(--otn-bg);
}
.otn-preview-stage {
  flex: 1 1 auto;
  min-block-size: 0;
  display: grid;
  place-items: center;
  padding: 14px;
  overflow: hidden;
  background: radial-gradient(circle at 50% 40%, var(--otn-panel-2), var(--otn-bg) 70%);
}
.otn-preview-image {
  display: block;
  max-inline-size: 100%;
  max-block-size: 100%;
  inline-size: auto;
  block-size: auto;
  border-radius: 4px;
  background: #000;
  box-shadow: 0 8px 28px rgba(0, 0, 0, .35);
}
.otn-preview-placeholder {
  display: grid;
  place-items: center;
  inline-size: min(100%, 480px);
  aspect-ratio: 16 / 9;
  border: 1px dashed var(--otn-border);
  border-radius: var(--otn-radius);
  color: var(--otn-muted);
  font-size: 12px;
}
.otn-transport {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-block-start: 1px solid var(--otn-border);
  background: var(--otn-panel);
}
.otn-scrub { flex: 1 1 auto; accent-color: var(--otn-accent); min-inline-size: 60px; }
.otn-frame-readout { color: var(--otn-muted); font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.otn-inspector {
  inline-size: clamp(220px, 24%, 300px);
  flex: 0 0 auto;
  border-inline-start: 1px solid var(--otn-border);
  background: var(--otn-panel);
  min-block-size: 0;
  overflow: auto;
  padding-block-end: 10px;
}
.otn-inspector .otn-panel-title { border-block-end: 1px solid var(--otn-border); }
.otn-inspector__body { display: grid; gap: 12px; padding: 10px 12px; }
.otn-field { display: grid; gap: 4px; }
.otn-field__label { color: var(--otn-muted); font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
.otn-field__input {
  inline-size: 100%;
  min-block-size: 28px;
  border: 1px solid var(--otn-border);
  border-radius: 6px;
  background: var(--otn-bg);
  color: var(--otn-text);
  font: inherit;
  font-size: 12px;
  padding: 5px 7px;
}
.otn-field__input:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }
.otn-field__row { display: flex; gap: 6px; align-items: center; }
.otn-field__row .otn-field__input { min-inline-size: 0; }
.otn-toggle {
  appearance: none;
  border: 1px solid var(--otn-border);
  border-radius: 6px;
  background: var(--otn-panel-2);
  color: var(--otn-text);
  font: inherit;
  font-size: 11px;
  padding: 4px 7px;
  cursor: pointer;
}
.otn-toggle[aria-pressed="true"] { border-color: var(--otn-accent); background: var(--otn-accent-soft); }
.otn-toggle:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }
.otn-inspector__group { display: grid; gap: 7px; padding-block-start: 10px; border-block-start: 1px solid var(--otn-border); }
.otn-inspector__group:first-child { border-block-start: 0; padding-block-start: 0; }
.otn-inspector__title { color: var(--otn-muted); font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.otn-inspector__track-name { font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.otn-overlay {
  position: absolute;
  inset: 0;
  z-index: 8;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, .4);
  padding: 12px;
}
.otn-sheet {
  inline-size: min(480px, 100%);
  block-size: 100%;
  overflow: auto;
  border: 1px solid var(--otn-border);
  border-radius: var(--otn-radius);
  background: var(--otn-panel);
  box-shadow: 0 18px 60px rgba(0, 0, 0, .4);
}
.otn-sheet__header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-block-end: 1px solid var(--otn-border); }
.otn-sheet__title { flex: 1 1 auto; margin: 0; font-size: 14px; }
.otn-sheet__body { display: grid; gap: 12px; padding: 14px; }
.otn-sheet__section { display: grid; gap: 8px; }
.otn-sheet__section-title { color: var(--otn-muted); font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.otn-sheet__row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.otn-sheet__hint { color: var(--otn-muted); font-size: 11px; margin: 0; }
.otn-progress-bar { inline-size: 100%; block-size: 5px; border-radius: 999px; background: var(--otn-panel-2); overflow: hidden; }
.otn-progress-bar__fill { block-size: 100%; background: var(--otn-accent); transition: inline-size .2s ease; }
.otn-storage-row { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--otn-muted); }
.otn-storage-row__name { flex: 1 1 auto; color: var(--otn-text); }
.otn-status-ok { color: var(--otn-accent); }
.otn-status-bad { color: var(--otn-danger); }
.otn-timeline {
  flex: 0 0 38%;
  min-block-size: 150px;
  display: flex;
  flex-direction: column;
  border-block-start: 1px solid var(--otn-border);
  background: var(--otn-panel);
}
.otn-timeline-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px; }
.otn-timeline-body { overflow: auto; padding: 0 10px 10px; min-block-size: 0; }
.otn-ruler {
  position: relative;
  block-size: 18px;
  margin-inline-start: 72px;
  border-block-end: 1px solid var(--otn-border);
  color: var(--otn-muted);
  font: 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.otn-ruler-tick { position: absolute; inset-block-end: 0; inline-size: 1px; block-size: 6px; background: var(--otn-border); }
.otn-ruler-label { position: absolute; inset-block-start: 2px; transform: translateX(-50%); white-space: nowrap; }
.otn-track-row { display: flex; align-items: stretch; min-block-size: 34px; border-block-end: 1px solid var(--otn-border); }
.otn-track-head {
  inline-size: 72px;
  flex: 0 0 72px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding-inline-end: 6px;
  color: var(--otn-muted);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
}
.otn-track-lane { position: relative; flex: 1 1 auto; min-inline-size: 0; margin-block: 4px; border-radius: 4px; background: var(--otn-panel-2); }
.otn-clip {
  position: absolute;
  inset-block: 3px;
  min-inline-size: 8px;
  border: 1px solid color-mix(in srgb, var(--otn-accent) 55%, var(--otn-border));
  border-radius: 4px;
  background: color-mix(in srgb, var(--otn-accent) 24%, var(--otn-panel-2));
  color: var(--otn-text);
  font: 10px/1.2 inherit;
  padding: 2px 5px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: start;
  cursor: pointer;
}
.otn-clip--selected { outline: 2px solid var(--otn-accent); outline-offset: -1px; background: color-mix(in srgb, var(--otn-accent) 38%, var(--otn-panel-2)); }
.otn-clip:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }
.otn-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-block-start: 1px solid var(--otn-border);
  color: var(--otn-muted);
  font-size: 11px;
  flex: 0 0 auto;
}
.otn-error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 12px 0;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--otn-danger) 55%, var(--otn-border));
  border-radius: 7px;
  background: color-mix(in srgb, var(--otn-danger) 12%, transparent);
  color: var(--otn-text);
  font-size: 12px;
}
.otn-error__message { flex: 1 1 auto; overflow-wrap: anywhere; }
.otn-home {
  flex: 1 1 auto;
  min-block-size: 0;
  overflow: auto;
  display: grid;
  align-content: start;
  gap: 14px;
  padding: clamp(18px, 4vw, 44px);
  max-inline-size: 900px;
  inline-size: 100%;
  margin-inline: auto;
}
.otn-home__title { margin: 0; font-size: clamp(24px, 4vw, 38px); line-height: 1.05; letter-spacing: -.04em; }
.otn-home__subtitle { margin: 0; color: var(--otn-muted); max-inline-size: 66ch; }
.otn-card { border: 1px solid var(--otn-border); border-radius: var(--otn-radius); background: var(--otn-panel); padding: 14px; }
.otn-home__row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.otn-input {
  flex: 1 1 260px;
  min-inline-size: 160px;
  border: 1px solid var(--otn-border);
  border-radius: 7px;
  background: var(--otn-bg);
  color: var(--otn-text);
  font: inherit;
  font-size: 12px;
  padding: 6px 8px;
  min-block-size: 30px;
}
.otn-input:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }
.otn-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; color: var(--otn-muted); font-size: 12px; }
.otn-kv__value { color: var(--otn-text); overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.otn-hint { color: var(--otn-muted); font-size: 11px; margin: 0; }
.otn-progress { color: var(--otn-muted); font-size: 11px; }
@media (max-width: 900px) {
  .otn-inspector { inline-size: 220px; }
}
@media (max-width: 720px) {
  .otn-media { inline-size: 170px; }
  .otn-inspector { display: none; }
  .otn-brand__note, .otn-project-path { display: none; }
  .otn-timeline { flex-basis: 42%; }
  .otn-home { padding: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .otn-root *, .otn-root *::before, .otn-root *::after { transition: none !important; animation: none !important; }
}
`;
