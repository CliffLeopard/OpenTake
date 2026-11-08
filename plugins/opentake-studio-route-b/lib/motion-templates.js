/**
 * Route B Motion template library.
 *
 * Pure, dependency-free builders for the built-in Motion templates used by the
 * Route B `motion_add`/`motion_preview` template path. This module deliberately
 * has no Node, filesystem, DOM or Chrome dependency: it validates parameters and
 * turns them into a self-contained HTML fragment + CSS stylesheet. The Host
 * renders the result through its existing headless-Chrome preview path.
 *
 * Canonical template ids:
 *   - `title-card`       — centred title/subtitle with an accent underline.
 *   - `lower-third.glass` — bottom-left glass card with an accent bar.
 *   - `callout`          — rounded translucent callout card.
 *
 * Compatibility aliases are accepted for the first two ids so the module can be
 * wired to both the existing Rust/agent template ids and the shorter UI names.
 *
 * Templates are pure HTML/CSS: no scripts, no external URLs, no inline event
 * handlers. All user text is HTML-escaped and all colours are validated before
 * they reach CSS.
 */

/** The exact offline CSP used for the generated standalone document. */
export const OFFLINE_DOCUMENT_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'";

const HEX_COLOR = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MAX_TITLE_CHARS = 160;
const MAX_SUBTITLE_CHARS = 240;
const TEMPLATE_DURATION_SECONDS = 3;
const MIN_DIMENSION = 2;
const MAX_DIMENSION = 4096;
const MAX_DURATION_SECONDS = 60;

/** Error type with a stable code and optional parameter field. */
export class MotionTemplateError extends Error {
  constructor(message, code = 'invalid-template', field = null) {
    super(message);
    this.name = 'MotionTemplateError';
    this.code = code;
    this.field = field;
  }
}

function paramString(defaultValue, maxLength) {
  return { type: 'string', default: defaultValue, maxLength, required: true };
}

function paramSubtitle(defaultValue) {
  return { type: 'string', default: defaultValue, maxLength: MAX_SUBTITLE_CHARS, required: false };
}

function paramColor(defaultValue, allowTransparent = false) {
  return { type: 'color', default: defaultValue, allowTransparent };
}

const SHARED_PARAMS = Object.freeze({
  title: Object.freeze(paramString('OpenTake', MAX_TITLE_CHARS)),
  subtitle: Object.freeze(paramSubtitle('')),
  accent: Object.freeze(paramColor('#7C5CFF')),
  background: Object.freeze(paramColor('#11131A', true)),
});

function definition(id, label, description, subtitleDefault) {
  return Object.freeze({
    id,
    label,
    description,
    durationSeconds: TEMPLATE_DURATION_SECONDS,
    transparent: true,
    params: Object.freeze({
      ...SHARED_PARAMS,
      subtitle: Object.freeze(paramSubtitle(subtitleDefault)),
    }),
  });
}

/** Canonical template definitions, keyed by canonical id. */
export const TEMPLATES = Object.freeze({
  'title-card': definition(
    'title-card',
    'Title card',
    'Centred title and optional subtitle with an accent underline.',
    'Motion Canvas',
  ),
  'lower-third.glass': definition(
    'lower-third.glass',
    'Lower third',
    'Bottom-left glass card with an accent bar and slide-in.',
    'Motion Graphic',
  ),
  callout: definition(
    'callout',
    'Callout',
    'Rounded translucent callout card with a pop-in and accent edge.',
    '',
  ),
});

/** Canonical ids in stable order. */
export const TEMPLATE_IDS = Object.freeze(['title-card', 'lower-third.glass', 'callout']);

/** Accepted aliases -> canonical id. */
export const TEMPLATE_ALIASES = Object.freeze({
  'title-card': 'title-card',
  title: 'title-card',
  titlecard: 'title-card',
  titleCard: 'title-card',
  'lower-third.glass': 'lower-third.glass',
  'lower-third': 'lower-third.glass',
  lowerthird: 'lower-third.glass',
  lowerThird: 'lower-third.glass',
  lowerThirdGlass: 'lower-third.glass',
  callout: 'callout',
  'callout.card': 'callout',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertTemplateId(templateId) {
  const value =
    templateId !== null && typeof templateId === 'object' && typeof templateId.id === 'string'
      ? templateId.id
      : templateId;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MotionTemplateError('templateId must be a non-empty string', 'invalid-template-id', 'templateId');
  }
  return value.trim();
}

/** Resolve a canonical id or alias; throws for an unknown template. */
export function resolveTemplateId(templateId) {
  const id = assertTemplateId(templateId);
  const canonical = TEMPLATE_ALIASES[id];
  if (canonical === undefined) {
    throw new MotionTemplateError(
      `unknown Motion template: ${id}`,
      'unknown-template',
      'templateId',
    );
  }
  return canonical;
}

/** Return a template definition by canonical id or alias. */
export function getTemplate(templateId) {
  return TEMPLATES[resolveTemplateId(templateId)];
}

/** List canonical templates (definitions are frozen). */
export function listTemplates() {
  return TEMPLATE_IDS.map((id) => TEMPLATES[id]);
}

function codePointLength(value) {
  return [...value].length;
}

function validateText(name, value, spec) {
  if (typeof value !== 'string') {
    throw new MotionTemplateError(`template parameter ${name} must be a string`, 'invalid-param-type', name);
  }
  if (UNSAFE_CONTROL.test(value)) {
    throw new MotionTemplateError(
      `template parameter ${name} contains a control character`,
      'invalid-param-value',
      name,
    );
  }
  if (codePointLength(value) > spec.maxLength) {
    throw new MotionTemplateError(
      `template parameter ${name} must be at most ${spec.maxLength} characters`,
      'param-too-long',
      name,
    );
  }
  if (spec.required && value.trim().length === 0) {
    throw new MotionTemplateError(`template parameter ${name} must not be empty`, 'invalid-param-value', name);
  }
}

function validateColor(name, value, spec) {
  if (typeof value !== 'string') {
    throw new MotionTemplateError(`template parameter ${name} must be a color string`, 'invalid-param-type', name);
  }
  if (spec.allowTransparent === true && value === 'transparent') return;
  if (!HEX_COLOR.test(value)) {
    throw new MotionTemplateError(
      `template parameter ${name} must be #RRGGBB or #RRGGBBAA${spec.allowTransparent ? " or 'transparent'" : ''}`,
      'invalid-param-value',
      name,
    );
  }
}

/**
 * Validate and normalize template parameters.
 * Unknown params are rejected; omitted params receive definition defaults.
 *
 * @returns {Record<string, string>} normalized parameters in schema order
 */
export function validateTemplateParams(templateId, params = {}) {
  const template = getTemplate(templateId);
  if (params === null || params === undefined) params = {};
  if (!isPlainObject(params)) {
    throw new MotionTemplateError('template params must be an object', 'invalid-params', 'params');
  }
  const unknown = Object.keys(params).filter((name) => !(name in template.params));
  if (unknown.length > 0) {
    throw new MotionTemplateError(
      `unknown template parameter: ${unknown[0]}`,
      'unknown-param',
      unknown[0],
    );
  }
  const normalized = {};
  for (const [name, spec] of Object.entries(template.params)) {
    const value = Object.prototype.hasOwnProperty.call(params, name) ? params[name] : spec.default;
    if (spec.type === 'string') {
      validateText(name, value, spec);
      normalized[name] = value;
    } else if (spec.type === 'color') {
      validateColor(name, value, spec);
      normalized[name] = value.toLowerCase();
    }
  }
  return normalized;
}

/** Escape text for use in HTML text nodes. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function textHtml(value) {
  return escapeHtml(value).replaceAll('\n', '<br>');
}

function commonCss(background) {
  return `html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}
.otm-stage{position:absolute;inset:0;box-sizing:border-box;display:flex;overflow:hidden;background:${background};color:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.otm-title{margin:0;font-weight:700;line-height:1.04;letter-spacing:-.03em;white-space:pre-line}
.otm-subtitle{margin:0;font-weight:400;line-height:1.25;opacity:.78;white-space:pre-line}
.otm-rule,.otm-bar{background:var(--otm-accent)}
@media (prefers-reduced-motion:reduce){.otm-stage *{animation:none!important}}`;
}

function titleHtml(params) {
  return `<main class="otm-stage otm-stage--title" data-template="title-card" style="--otm-accent:${params.accent}">
  <div class="otm-title-wrap">
    <h1 class="otm-title">${textHtml(params.title)}</h1>
    ${params.subtitle.length > 0 ? `<p class="otm-subtitle">${textHtml(params.subtitle)}</p>` : ''}
    <div class="otm-rule" aria-hidden="true"></div>
  </div>
</main>`;
}

function titleCss(params) {
  return `${commonCss(params.background)}
.otm-stage--title{align-items:center;justify-content:center;padding:8%;text-align:center}
.otm-title-wrap{display:flex;flex-direction:column;align-items:center;gap:clamp(14px,1.8vw,28px);max-width:86%}
.otm-stage--title .otm-title{font-size:clamp(48px,8vw,132px);animation:otm-title-cycle var(--otm-duration,3s) cubic-bezier(.2,.8,.2,1) both}
.otm-stage--title .otm-subtitle{font-size:clamp(20px,2.4vw,42px);animation:otm-subtitle-cycle var(--otm-duration,3s) cubic-bezier(.2,.8,.2,1) both}
.otm-rule{width:min(28%,320px);height:clamp(4px,.5vw,8px);border-radius:999px;transform-origin:center;animation:otm-rule-cycle var(--otm-duration,3s) cubic-bezier(.2,.8,.2,1) both}
@keyframes otm-title-cycle{0%{opacity:0;transform:translateY(6%) scale(.94)}18%,82%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-2%) scale(.99)}}
@keyframes otm-subtitle-cycle{0%,8%{opacity:0;transform:translateY(14px)}24%,82%{opacity:.78;transform:none}100%{opacity:0;transform:translateY(-6px)}}
@keyframes otm-rule-cycle{0%,10%{opacity:0;transform:scaleX(.2)}30%,82%{opacity:1;transform:scaleX(1)}100%{opacity:0;transform:scaleX(.65)}}`;
}

function lowerThirdHtml(params) {
  return `<main class="otm-stage otm-stage--lower" data-template="lower-third.glass" style="--otm-accent:${params.accent}">
  <section class="otm-card">
    <div class="otm-bar" aria-hidden="true"></div>
    <div class="otm-copy">
      <h1 class="otm-title">${textHtml(params.title)}</h1>
      ${params.subtitle.length > 0 ? `<p class="otm-subtitle">${textHtml(params.subtitle)}</p>` : ''}
    </div>
  </section>
</main>`;
}

function lowerThirdCss(params) {
  return `${commonCss(params.background)}
.otm-stage--lower{align-items:flex-end;justify-content:flex-start;padding:7% 8%}
.otm-card{display:flex;align-items:stretch;gap:clamp(12px,1.4vw,22px);max-width:min(76%,760px);padding:clamp(18px,2.4vw,36px);border:1px solid rgba(255,255,255,.22);border-radius:clamp(14px,1.5vw,28px);background:rgba(10,14,24,.62);box-shadow:0 22px 70px rgba(0,0,0,.35);transform-origin:left center;animation:otm-lower-cycle var(--otm-duration,3s) cubic-bezier(.2,.8,.2,1) both}
.otm-bar{flex:0 0 auto;width:clamp(4px,.45vw,8px);border-radius:999px;animation:otm-bar-cycle var(--otm-duration,3s) cubic-bezier(.2,.8,.2,1) both}
.otm-copy{display:flex;flex-direction:column;gap:clamp(6px,.7vw,12px);min-width:0}
.otm-stage--lower .otm-title{font-size:clamp(28px,4.6vw,72px);overflow-wrap:anywhere}
.otm-stage--lower .otm-subtitle{font-size:clamp(16px,1.8vw,32px);overflow-wrap:anywhere}
@keyframes otm-lower-cycle{0%{opacity:0;transform:translateX(-8%)}18%,82%{opacity:1;transform:none}100%{opacity:0;transform:translateX(-4%)}}
@keyframes otm-bar-cycle{0%,10%{opacity:0;transform:scaleY(.2)}28%,82%{opacity:1;transform:none}100%{opacity:0;transform:scaleY(.7)}}`;
}

function calloutHtml(params) {
  return `<main class="otm-stage otm-stage--callout" data-template="callout" style="--otm-accent:${params.accent}">
  <section class="otm-card">
    <div class="otm-bar" aria-hidden="true"></div>
    <div class="otm-copy">
      <h1 class="otm-title">${textHtml(params.title)}</h1>
      ${params.subtitle.length > 0 ? `<p class="otm-subtitle">${textHtml(params.subtitle)}</p>` : ''}
    </div>
  </section>
</main>`;
}

function calloutCss(params) {
  return `${commonCss(params.background)}
.otm-stage--callout{align-items:center;justify-content:center;padding:8%}
.otm-card{display:flex;align-items:stretch;gap:clamp(12px,1.4vw,22px);max-width:min(68%,720px);padding:clamp(20px,2.8vw,44px);border:1px solid rgba(255,255,255,.2);border-radius:clamp(18px,2vw,34px);background:rgba(10,14,24,.74);box-shadow:0 26px 80px rgba(0,0,0,.4);animation:otm-callout-cycle var(--otm-duration,3s) cubic-bezier(.2,.8,.2,1) both}
.otm-bar{flex:0 0 auto;width:clamp(4px,.45vw,8px);border-radius:999px}
.otm-copy{display:flex;flex-direction:column;gap:clamp(6px,.7vw,12px);min-width:0}
.otm-stage--callout .otm-title{font-size:clamp(24px,3.8vw,56px);overflow-wrap:anywhere}
.otm-stage--callout .otm-subtitle{font-size:clamp(16px,1.8vw,30px);overflow-wrap:anywhere}
@keyframes otm-callout-cycle{0%{opacity:0;transform:scale(.86)}22%,82%{opacity:1;transform:none}100%{opacity:0;transform:scale(.97)}}`;
}

/**
 * Convert a template + parameters into a self-contained HTML fragment and CSS
 * stylesheet. The result contains no scripts, external URLs or event handlers.
 *
 * @param {string} templateId canonical id or accepted alias
 * @param {Record<string, string>} params template parameters
 * @returns {{templateId: string, html: string, css: string, params: Record<string,string>}}
 */
export function templateToHtmlCss(templateId, params = {}) {
  const canonicalId = resolveTemplateId(templateId);
  const normalized = validateTemplateParams(canonicalId, params);
  if (canonicalId === 'title-card') {
    return {
      templateId: canonicalId,
      html: titleHtml(normalized),
      css: titleCss(normalized),
      params: normalized,
    };
  }
  if (canonicalId === 'lower-third.glass') {
    return {
      templateId: canonicalId,
      html: lowerThirdHtml(normalized),
      css: lowerThirdCss(normalized),
      params: normalized,
    };
  }
  return {
    templateId: canonicalId,
    html: calloutHtml(normalized),
    css: calloutCss(normalized),
    params: normalized,
  };
}

function assertDimension(name, value) {
  if (!Number.isInteger(value) || value < MIN_DIMENSION || value > MAX_DIMENSION) {
    throw new MotionTemplateError(
      `${name} must be an integer in ${MIN_DIMENSION}..${MAX_DIMENSION}`,
      'invalid-dimension',
      name,
    );
  }
  return value;
}

/**
 * Build a complete, CSP-guarded document for the existing Chrome preview path.
 * `durationSeconds` is exposed as the `--otm-duration` CSS variable so the CSS
 * in/out cycle spans the requested clip rather than the 3s fallback.
 */
export function templateToDocument(templateId, params = {}, options = {}) {
  const content = templateToHtmlCss(templateId, params);
  const width = assertDimension('width', options.width === undefined ? 1280 : options.width);
  const height = assertDimension('height', options.height === undefined ? 720 : options.height);
  const durationSeconds =
    options.durationSeconds === undefined ? TEMPLATE_DURATION_SECONDS : Number(options.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
    throw new MotionTemplateError(
      `durationSeconds must be > 0 and <= ${MAX_DURATION_SECONDS}`,
      'invalid-duration',
      'durationSeconds',
    );
  }
  const fps = options.fps === undefined ? 30 : Number(options.fps);
  const frame = options.frame === undefined ? null : Number(options.frame);
  let seekCss = '';
  if (frame !== null) {
    if (!Number.isFinite(fps) || fps <= 0 || !Number.isInteger(frame) || frame < 0) {
      throw new MotionTemplateError(
        'frame must be a non-negative integer and fps must be positive',
        'invalid-frame',
        'frame',
      );
    }
    const timeSeconds = frame / fps;
    seekCss = `<style>:root{--otm-time:${timeSeconds}s}.otm-stage *{animation-delay:calc(-1 * var(--otm-time))!important;animation-play-state:paused!important}</style>`;
  }
  return {
    templateId: content.templateId,
    durationSeconds,
    frame,
    document: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${OFFLINE_DOCUMENT_CSP}"><style>:root{--otm-duration:${durationSeconds}s}html,body{width:${width}px;height:${height}px;margin:0;overflow:hidden}${content.css}</style>${seekCss}</head><body>${content.html}</body></html>`,
  };
}
