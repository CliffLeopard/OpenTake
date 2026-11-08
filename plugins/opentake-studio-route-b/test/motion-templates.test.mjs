import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MotionTemplateError,
  OFFLINE_DOCUMENT_CSP,
  TEMPLATE_ALIASES,
  TEMPLATE_IDS,
  TEMPLATES,
  escapeHtml,
  getTemplate,
  listTemplates,
  resolveTemplateId,
  templateToDocument,
  templateToHtmlCss,
  validateTemplateParams,
} from '../lib/motion-templates.js';

const CANONICAL = ['title-card', 'lower-third.glass', 'callout'];

function assertSafeTemplate(result) {
  assert.doesNotMatch(result.html, /<script\b/i);
  assert.doesNotMatch(result.html, /<iframe\b/i);
  assert.doesNotMatch(result.html, /javascript:/i);
  assert.doesNotMatch(result.html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(result.css, /@import/i);
  assert.doesNotMatch(result.css, /url\s*\(/i);
  assert.doesNotMatch(result.css, /expression\s*\(/i);
  assert.match(result.css, /--otm-duration/);
}

test('exports the three canonical templates in stable order', () => {
  assert.deepEqual(TEMPLATE_IDS, CANONICAL);
  assert.deepEqual(
    listTemplates().map((template) => template.id),
    CANONICAL,
  );
  assert.equal(TEMPLATES['title-card'].label, 'Title card');
  assert.equal(TEMPLATES['lower-third.glass'].label, 'Lower third');
  assert.equal(TEMPLATES.callout.label, 'Callout');
  for (const id of CANONICAL) {
    assert.equal(getTemplate(id).id, id);
    assert.equal(typeof getTemplate(id).durationSeconds, 'number');
    assert.equal(getTemplate(id).transparent, true);
  }
});

test('accepted aliases resolve to canonical ids', () => {
  assert.equal(resolveTemplateId('title'), 'title-card');
  assert.equal(resolveTemplateId('titleCard'), 'title-card');
  assert.equal(resolveTemplateId('lower-third'), 'lower-third.glass');
  assert.equal(resolveTemplateId('lowerThird'), 'lower-third.glass');
  assert.equal(resolveTemplateId('lowerThirdGlass'), 'lower-third.glass');
  assert.equal(resolveTemplateId('callout.card'), 'callout');
  assert.equal(resolveTemplateId(TEMPLATES.callout), 'callout');
  for (const [alias, canonical] of Object.entries(TEMPLATE_ALIASES)) {
    assert.equal(resolveTemplateId(alias), canonical, alias);
  }
});

test('defaults are normalized and deterministic', () => {
  for (const id of CANONICAL) {
    const first = templateToHtmlCss(id);
    const second = templateToHtmlCss(id);
    assert.deepEqual(first, second);
    assert.equal(first.templateId, id);
    assert.equal(first.params.title.length > 0, true);
    assert.match(first.params.accent, /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/);
    assert.match(first.params.background, /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/);
    assert.match(first.html, /data-template=/);
    assertSafeTemplate(first);
  }
  assert.match(templateToHtmlCss('title-card').html, /otm-rule/);
  assert.match(templateToHtmlCss('lower-third.glass').html, /otm-stage--lower/);
  assert.match(templateToHtmlCss('callout').html, /otm-stage--callout/);
  assert.match(templateToHtmlCss('callout').css, /@keyframes otm-callout-cycle/);
});

test('custom title/subtitle/accent/background reach the output', () => {
  const result = templateToHtmlCss('title', {
    title: 'Launch',
    subtitle: 'Today',
    accent: '#22AA66',
    background: '#101418',
  });
  assert.equal(result.templateId, 'title-card');
  assert.match(result.html, /Launch/);
  assert.match(result.html, /Today/);
  assert.match(result.html, /--otm-accent:#22aa66/);
  assert.match(result.css, /background:#101418/);
  assert.match(result.html, /otm-rule/);
});

test('transparent background is accepted and emitted literally', () => {
  for (const id of CANONICAL) {
    const result = templateToHtmlCss(id, { background: 'transparent' });
    assert.equal(result.params.background, 'transparent');
    assert.match(result.css, /background:transparent/);
    assert.doesNotMatch(result.css, /background:#11131a/);
  }
});

test('text is escaped, including HTML and attribute breakouts', () => {
  const result = templateToHtmlCss('callout', {
    title: '<script>alert(1)</script>',
    subtitle: '" onmouseover="alert(2)" & <img src=x onerror=alert(3)>',
  });
  assert.doesNotMatch(result.html, /<script/i);
  assert.doesNotMatch(result.html, /onmouseover="/i);
  assert.doesNotMatch(result.html, /<img/i);
  assert.match(result.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(result.html, /&quot; onmouseover=&quot;alert\(2\)&quot; &amp; &lt;img/);
  assert.equal(
    escapeHtml('<b>"x" & \'y\'</b>'),
    '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;',
  );
});

test('newlines in title/subtitle become <br> after escaping', () => {
  const result = templateToHtmlCss('title-card', { title: 'A\nB', subtitle: 'C\nD' });
  assert.match(result.html, /A<br>B/);
  assert.match(result.html, /C<br>D/);
});

test('validation rejects unknown templates and parameters with stable errors', () => {
  assert.throws(
    () => templateToHtmlCss('no-such-template'),
    (error) => error instanceof MotionTemplateError && error.code === 'unknown-template' && error.field === 'templateId',
  );
  assert.throws(
    () => templateToHtmlCss('callout', { title: 'x', nope: 'y' }),
    (error) => error instanceof MotionTemplateError && error.code === 'unknown-param' && error.field === 'nope',
  );
  assert.throws(
    () => templateToHtmlCss('callout', { title: 42 }),
    (error) => error instanceof MotionTemplateError && error.code === 'invalid-param-type' && error.field === 'title',
  );
  assert.throws(
    () => templateToHtmlCss('callout', { title: '' }),
    (error) => error instanceof MotionTemplateError && error.code === 'invalid-param-value',
  );
  assert.throws(
    () => validateTemplateParams('title-card', []),
    (error) => error instanceof MotionTemplateError && error.code === 'invalid-params',
  );
  assert.doesNotThrow(() => validateTemplateParams('title-card', null));
});

test('colors, lengths and control characters are validated', () => {
  for (const bad of ['red', '#fff', '#12345', 'rgb(0,0,0)', '#1234567', '#1234567z']) {
    assert.throws(
      () => templateToHtmlCss('title-card', { accent: bad }),
      (error) => error instanceof MotionTemplateError && error.code === 'invalid-param-value',
      bad,
    );
  }
  assert.match(templateToHtmlCss('title-card', { accent: '#aabbccdd' }).html, /--otm-accent:#aabbccdd/);
  assert.throws(
    () => templateToHtmlCss('title-card', { title: 'x'.repeat(161) }),
    (error) => error instanceof MotionTemplateError && error.code === 'param-too-long',
  );
  assert.throws(
    () => templateToHtmlCss('title-card', { title: 'bad\u0000title' }),
    (error) => error instanceof MotionTemplateError && error.code === 'invalid-param-value',
  );
  assert.doesNotThrow(() => templateToHtmlCss('title-card', { title: 'x'.repeat(160) }));
  assert.doesNotThrow(() => templateToHtmlCss('title-card', { title: 'Line one\nLine two' }));
});

test('standalone document includes CSP, dimensions and duration variable', () => {
  const result = templateToDocument('lower-third.glass', { title: 'Hello' }, {
    width: 1920,
    height: 1080,
    durationSeconds: 4.5,
    fps: 30,
    frame: 45,
  });
  assert.equal(result.templateId, 'lower-third.glass');
  assert.equal(result.durationSeconds, 4.5);
  assert.equal(result.frame, 45);
  assert.match(result.document, /--otm-time:1\.5s/);
  assert.match(result.document, /animation-play-state:paused/);
  assert.match(result.document, /animation-delay:calc\(-1 \* var\(--otm-time\)\)/);
  assert.match(result.document, /^<!doctype html>/i);
  assert.match(result.document, /http-equiv="Content-Security-Policy"/);
  assert.ok(result.document.includes(OFFLINE_DOCUMENT_CSP));
  assert.match(result.document, /--otm-duration:4\.5s/);
  assert.match(result.document, /width:1920px;height:1080px/);
  assert.match(result.document, /otm-stage--lower/);
  assert.doesNotMatch(result.document, /<script\b/i);
  assert.throws(
    () => templateToDocument('callout', {}, { width: 1 }),
    (error) => error instanceof MotionTemplateError && error.code === 'invalid-dimension',
  );
  assert.throws(
    () => templateToDocument('callout', {}, { durationSeconds: 0 }),
    (error) => error instanceof MotionTemplateError && error.code === 'invalid-duration',
  );
});

test('unknown properties are not mutated and caller params stay untouched', () => {
  const params = Object.freeze({ title: 'Frozen', accent: '#AABBCC' });
  const result = templateToHtmlCss('title-card', params);
  assert.equal(params.accent, '#AABBCC');
  assert.equal(result.params.accent, '#aabbcc');
  assert.notEqual(result.params, params);
});
