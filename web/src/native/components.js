/**
 * Native Route B editor view for the bounded home/media/timeline/preview
 * milestone. Components are authored with `createElement` so this module has no
 * JSX build requirement and no React import: the mount caller supplies the
 * external React instance.
 */

import { createTranslator } from './locale.js';
import { clipCount, findClip, mediaItems, timelineMeta, timelineTracks, totalFrames } from './store.js';

const h = (React, type, props, ...children) => React.createElement(type, props, ...children);

function useStore(React, store) {
  if (typeof React.useSyncExternalStore === 'function') {
    return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  }
  const [snapshot, setSnapshot] = React.useState(store.getSnapshot());
  React.useEffect(() => store.subscribe(setSnapshot), [store]);
  return snapshot;
}

function button(React, label, onClick, options = {}) {
  return h(React, 'button', {
    type: 'button',
    className: `otn-btn${options.primary ? ' otn-btn--primary' : ''}`,
    onClick,
    disabled: options.disabled === true,
    title: options.title,
    'aria-label': options.ariaLabel,
  }, label);
}

function statusBadge(React, state, t) {
  const connected = state.engine?.connected === true;
  return h(React, 'span', { className: `otn-badge${connected ? '' : ' otn-badge--down'}`, title: state.engine?.error ?? undefined },
    h(React, 'span', { className: `otn-dot${connected ? '' : ' otn-dot--down'}`, 'aria-hidden': 'true' }),
    connected ? t('engineReady') : t('engineDown'),
  );
}

function ErrorBanner(React, state, store, t) {
  if (typeof state.error !== 'string' || state.error.length === 0) return null;
  return h(React, 'div', { className: 'otn-error', role: 'alert' },
    h(React, 'span', { className: 'otn-error__message' }, state.error),
    button(React, t('retry'), () => { void store.refresh(); }),
    button(React, t('dismiss'), () => store.clearError(), { ariaLabel: t('dismiss') }),
  );
}

function HomeView({ React, state, store, client, t }) {
  const [path, setPath] = React.useState(state.projectPath ?? '');
  React.useEffect(() => {
    if (state.projectPath !== null && state.projectPath !== path) setPath(state.projectPath);
    // Keep the input stable after a project change unless the project path moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.projectPath]);
  const busy = state.busy || state.loading;
  function onOpen(event) {
    event.preventDefault();
    if (path.trim().length === 0) return;
    void store.openProject(path.trim());
  }
  const info = state.info;
  return h(React, 'section', { className: 'otn-home', 'aria-label': t('home') },
    h(React, 'div', null,
      h(React, 'h1', { className: 'otn-home__title' }, t('appName')),
      h(React, 'p', { className: 'otn-home__subtitle' }, t('prototypeNotice')),
    ),
    h(React, 'div', { className: 'otn-card' },
      h(React, 'div', { className: 'otn-panel-title' }, t('engine')),
      h(React, 'div', { className: 'otn-kv' },
        h(React, 'span', null, t('status')),
        h(React, 'span', { className: 'otn-kv__value' }, statusBadge(React, state, t)),
        h(React, 'span', null, t('locale')),
        h(React, 'span', { className: 'otn-kv__value' }, state.locale),
        h(React, 'span', null, 'Node'),
        h(React, 'span', { className: 'otn-kv__value' }, info?.node ?? '—'),
        h(React, 'span', null, 'N-API'),
        h(React, 'span', { className: 'otn-kv__value' }, info?.napi ?? '—'),
      ),
      info?.loadError
        ? h(React, 'p', { className: 'otn-hint' }, info.loadError)
        : null,
    ),
    h(React, 'form', { className: 'otn-card', onSubmit: onOpen },
      h(React, 'div', { className: 'otn-panel-title' }, t('openProject')),
      h(React, 'div', { className: 'otn-home__row' },
        h(React, 'input', {
          className: 'otn-input',
          value: path,
          placeholder: t('projectPath'),
          onChange: (event) => setPath(event.target.value),
          'aria-label': t('projectPath'),
          spellCheck: false,
        }),
        button(React, t('openProject'), () => { void store.openProject(path.trim()); }, { disabled: busy || path.trim().length === 0 }),
        button(React, t('newProject'), () => { void store.newProject(); }, { primary: true, disabled: busy }),
      ),
      h(React, 'p', { className: 'otn-hint' }, t('recentUnavailable')),
    ),
    h(React, 'div', { className: 'otn-card' },
      h(React, 'div', { className: 'otn-panel-title' }, t('media')),
      h(React, 'p', { className: 'otn-hint' }, t('mediaCount', { count: state.media.length })),
      h(React, 'div', { className: 'otn-home__row' },
        button(React, t('editor'), () => store.setView('editor'), { disabled: state.timeline === null }),
        button(React, t('refresh'), () => { void store.refresh(); }, { disabled: busy }),
      ),
    ),
    h(React, 'p', { className: 'otn-hint' }, t('allChanges')),
  );
}

function MediaPanel(React, { state, client, t, store }) {
  const items = state.media;
  return h(React, 'aside', { className: 'otn-media', 'aria-label': t('media') },
    h(React, 'div', { className: 'otn-panel-title' },
      h(React, 'span', null, t('media')),
      h(React, 'span', null, String(items.length)),
    ),
    items.length === 0
      ? h(React, 'p', { className: 'otn-empty' }, t('noMedia'))
      : h(React, 'ul', { className: 'otn-media-list' },
        items.map((item) => {
          const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : item.id;
          const kind = typeof item.type === 'string' ? item.type : 'media';
          const source = typeof item.path === 'string' ? client.assetUrl(item.path) : null;
          return h(React, 'li', { key: String(item.id) },
            h(React, 'button', {
              type: 'button',
              className: `otn-media-card${state.selectedMediaId === item.id ? ' otn-media-card--selected' : ''}`,
              title: name,
              'aria-pressed': state.selectedMediaId === item.id,
              onClick: () => store.selectMedia(item.id),
            },
              source
                ? h(React, 'img', { className: 'otn-media-thumb', src: source, alt: '', loading: 'lazy', onError: (event) => { event.currentTarget.style.visibility = 'hidden'; } })
                : h(React, 'span', { className: 'otn-media-thumb otn-media-thumb--empty', 'aria-hidden': 'true' }, kind.slice(0, 4).toUpperCase()),
              h(React, 'span', { className: 'otn-media-copy' },
                h(React, 'span', { className: 'otn-media-name' }, name),
                h(React, 'span', { className: 'otn-media-meta' }, `${kind}${Number.isFinite(Number(item.duration)) ? ` · ${Number(item.duration).toFixed(1)}s` : ''}`),
              ),
            ),
          );
        }),
      ),
  );
}

function PreviewPane(React, { state, client, store, t }) {
  const meta = timelineMeta(state.timeline);
  const maxFrame = Math.max(0, totalFrames(state.timeline) - 1);
  const frame = Math.min(state.frame, maxFrame);
  const hasTimeline = state.timeline !== null;
  return h(React, 'section', { className: 'otn-preview', 'aria-label': t('preview') },
    h(React, 'div', { className: 'otn-preview-stage' },
      hasTimeline
        ? h(React, 'img', {
          className: 'otn-preview-image',
          src: client.previewUrl(frame, { revision: state.revision }),
          alt: `${t('preview')} ${t('frame')} ${frame}`,
          draggable: false,
        })
        : h(React, 'div', { className: 'otn-preview-placeholder' }, t('noProject')),
    ),
    h(React, 'div', { className: 'otn-transport' },
      button(React, '◀', () => store.setFrame(Math.max(0, frame - 1)), { ariaLabel: t('previousFrame'), disabled: frame <= 0, title: t('previousFrame') }),
      h(React, 'input', {
        className: 'otn-scrub',
        type: 'range',
        min: 0,
        max: Math.max(0, maxFrame),
        value: frame,
        onChange: (event) => store.setFrame(Number(event.target.value)),
        'aria-label': t('frame'),
      }),
      button(React, '▶', () => store.setFrame(Math.min(maxFrame, frame + 1)), { ariaLabel: t('nextFrame'), disabled: frame >= maxFrame, title: t('nextFrame') }),
      h(React, 'span', { className: 'otn-frame-readout' }, `${t('frame')} ${frame} / ${maxFrame} · ${meta.fps}fps`),
    ),
  );
}

function clipName(item, clip) {
  if (typeof clip?.textContent === 'string' && clip.textContent.length > 0) return clip.textContent.slice(0, 40);
  const media = item?.name;
  if (typeof media === 'string' && media.length > 0) return media;
  return typeof clip?.id === 'string' ? clip.id.slice(0, 18) : 'clip';
}

function TimelinePane(React, { state, store, t }) {
  const tracks = timelineTracks(state.timeline);
  const total = totalFrames(state.timeline);
  const selected = findClip(state.timeline, state.selectedClipId);
  const mediaById = new Map(mediaItems(state.media).map((item) => [item.id, item]));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(ratio * total));
  return h(React, 'section', { className: 'otn-timeline', 'aria-label': t('timeline') },
    h(React, 'div', { className: 'otn-timeline-toolbar' },
      h(React, 'strong', null, t('timeline')),
      h(React, 'span', { className: 'otn-hint' }, `${tracks.length} ${t('tracks')} · ${clipCount(state.timeline)} ${t('clips')}`),
      h(React, 'span', { className: 'otn-spacer' }),
      button(React, t('undo'), () => { void store.undo(); }, { disabled: state.busy }),
      button(React, t('redo'), () => { void store.redo(); }, { disabled: state.busy }),
      button(React, t('moveLeft'), () => { void store.moveSelected(-1); }, { disabled: state.busy || selected === null, title: `${t('moveLeft')} (${t('clip')})` }),
      button(React, t('moveRight'), () => { void store.moveSelected(1); }, { disabled: state.busy || selected === null, title: `${t('moveRight')} (${t('clip')})` }),
      h(React, 'span', { className: 'otn-frame-readout' }, selected === null ? t('selectClip') : `${t('selected')}: ${clipName(mediaById.get(selected.clip.mediaRef), selected.clip)}`),
    ),
    h(React, 'div', { className: 'otn-timeline-body' },
      h(React, 'div', { className: 'otn-ruler', 'aria-hidden': 'true' },
        ticks.map((tick, index) => h(React, 'span', { key: `tick-${index}`, className: 'otn-ruler-tick', style: { left: `${(tick / total) * 100}%` } },
          h(React, 'span', { className: 'otn-ruler-label' }, String(tick)),
        )),
      ),
      tracks.length === 0
        ? h(React, 'p', { className: 'otn-empty' }, t('noTracks'))
        : tracks.map((track, trackIndex) => h(React, 'div', { key: track.id ?? `track-${trackIndex}`, className: 'otn-track-row' },
          h(React, 'div', { className: 'otn-track-head', title: track.id ?? '' },
            h(React, 'span', null, `${String(track.type ?? 'video').toLowerCase() === 'audio' ? 'A' : 'V'}${trackIndex + 1}`),
          ),
          h(React, 'div', { className: 'otn-track-lane' },
            (Array.isArray(track.clips) ? track.clips : []).map((clip, clipIndex) => {
              const start = Number(clip.startFrame) || 0;
              const duration = Math.max(1, Number(clip.durationFrames) || 1);
              const left = Math.max(0, (start / total) * 100);
              const width = Math.max(0.4, (duration / total) * 100);
              const isSelected = clip.id === state.selectedClipId;
              const label = clipName(mediaById.get(clip.mediaRef), clip);
              return h(React, 'button', {
                key: clip.id ?? `clip-${trackIndex}-${clipIndex}`,
                type: 'button',
                className: `otn-clip${isSelected ? ' otn-clip--selected' : ''}`,
                style: { left: `${left}%`, width: `${width}%` },
                onClick: () => store.selectClip(clip.id),
                title: `${label} · ${start}+${duration}`,
              }, label);
            }),
          ),
        )),
    ),
  );
}

function numberField(React, { label, value, onChange, onBlur, min, max, step, dataKey }) {
  return h(React, 'label', { className: 'otn-field' },
    h(React, 'span', { className: 'otn-field__label' }, label),
    h(React, 'input', {
      className: 'otn-field__input',
      type: 'number',
      value,
      min,
      max,
      step: step ?? 1,
      'data-otn-inspector-field': dataKey,
      onChange: (event) => onChange(event.target.value),
      onBlur,
      onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur(); },
    }),
  );
}

function InspectorPanel({ React, state, store, t }) {
  const selected = findClip(state.timeline, state.selectedClipId);
  const clip = selected?.clip ?? null;
  const clipId = clip?.id ?? '';
  const transform = clip?.transform ?? {};
  const [draft, setDraft] = React.useState({
    opacity: '', volume: '', centerX: '', centerY: '', width: '', height: '', rotation: '', textContent: '',
  });
  React.useEffect(() => {
    if (clip === null) {
      setDraft({ opacity: '', volume: '', centerX: '', centerY: '', width: '', height: '', rotation: '', textContent: '' });
      return;
    }
    setDraft({
      opacity: String(clip.opacity ?? 1),
      volume: String(clip.volume ?? 1),
      centerX: String(clip.transform?.centerX ?? 0.5),
      centerY: String(clip.transform?.centerY ?? 0.5),
      width: String(clip.transform?.width ?? 1),
      height: String(clip.transform?.height ?? 1),
      rotation: String(clip.transform?.rotation ?? 0),
      textContent: typeof clip.textContent === 'string' ? clip.textContent : '',
    });
  }, [clipId, clip?.opacity, clip?.volume, clip?.transform?.centerX, clip?.transform?.centerY, clip?.transform?.width, clip?.transform?.height, clip?.transform?.rotation, clip?.textContent]);

  if (selected === null || clip === null) {
    return h(React, 'aside', { className: 'otn-inspector', 'aria-label': t('inspector') },
      h(React, 'div', { className: 'otn-panel-title' }, t('inspector')),
      h(React, 'p', { className: 'otn-empty' }, t('inspectorEmpty')),
    );
  }

  const track = selected.track;
  const trackIndex = selected.trackIndex;
  const disabled = state.busy;
  function setDraftValue(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  function commitNumber(key, patchKey) {
    const value = Number(draft[key]);
    if (!Number.isFinite(value)) return;
    const clamped = key === 'opacity' || key === 'volume' ? Math.min(1, Math.max(0, value)) : value;
    if (clamped === Number(clip[patchKey])) return;
    void store.setClipProperties(clip.id, { [patchKey]: clamped });
  }
  function commitTransform(key) {
    const value = Number(draft[key]);
    if (!Number.isFinite(value)) return;
    const next = Number(transform[key] ?? 0);
    if (value === next) return;
    void store.setClipProperties(clip.id, { transform: { ...transform, [key]: value } });
  }
  function commitText() {
    if (typeof clip.textContent !== 'string') return;
    if (draft.textContent === clip.textContent) return;
    void store.setClipProperties(clip.id, { textContent: draft.textContent });
  }
  return h(React, 'aside', { className: 'otn-inspector', 'aria-label': t('inspector') },
    h(React, 'div', { className: 'otn-panel-title' }, t('inspector'), h(React, 'span', null, clipName(null, clip))),
    h(React, 'div', { className: 'otn-inspector__body' },
      h(React, 'div', { className: 'otn-inspector__group' },
        h(React, 'span', { className: 'otn-inspector__title' }, t('properties')),
        numberField(React, { label: t('opacity'), value: draft.opacity, dataKey: 'opacity', min: 0, max: 1, step: 0.01, onChange: (value) => setDraftValue('opacity', value), onBlur: () => commitNumber('opacity', 'opacity') }),
        numberField(React, { label: t('volume'), value: draft.volume, dataKey: 'volume', min: 0, max: 1, step: 0.01, onChange: (value) => setDraftValue('volume', value), onBlur: () => commitNumber('volume', 'volume') }),
      ),
      h(React, 'div', { className: 'otn-inspector__group' },
        h(React, 'span', { className: 'otn-inspector__title' }, `${t('positionX')} / ${t('positionY')}`),
        h(React, 'div', { className: 'otn-field__row' },
          numberField(React, { label: t('positionX'), value: draft.centerX, dataKey: 'centerX', min: 0, max: 1, step: 0.01, onChange: (value) => setDraftValue('centerX', value), onBlur: () => commitTransform('centerX') }),
          numberField(React, { label: t('positionY'), value: draft.centerY, dataKey: 'centerY', min: 0, max: 1, step: 0.01, onChange: (value) => setDraftValue('centerY', value), onBlur: () => commitTransform('centerY') }),
        ),
        h(React, 'div', { className: 'otn-field__row' },
          numberField(React, { label: t('scaleWidth'), value: draft.width, dataKey: 'width', min: 0.01, max: 8, step: 0.01, onChange: (value) => setDraftValue('width', value), onBlur: () => commitTransform('width') }),
          numberField(React, { label: t('scaleHeight'), value: draft.height, dataKey: 'height', min: 0.01, max: 8, step: 0.01, onChange: (value) => setDraftValue('height', value), onBlur: () => commitTransform('height') }),
        ),
        numberField(React, { label: t('rotation'), value: draft.rotation, dataKey: 'rotation', min: -360, max: 360, step: 1, onChange: (value) => setDraftValue('rotation', value), onBlur: () => commitTransform('rotation') }),
      ),
      typeof clip.textContent === 'string'
        ? h(React, 'div', { className: 'otn-inspector__group' },
          h(React, 'span', { className: 'otn-inspector__title' }, t('textContent')),
          h(React, 'textarea', {
            className: 'otn-field__input',
            rows: 3,
            value: draft.textContent,
            'data-otn-inspector-field': 'textContent',
            onChange: (event) => setDraftValue('textContent', event.target.value),
            onBlur: commitText,
          }),
        )
        : null,
      h(React, 'div', { className: 'otn-inspector__group' },
        h(React, 'span', { className: 'otn-inspector__title' }, t('trackProperties')),
        h(React, 'span', { className: 'otn-inspector__track-name' }, `${t('track')} ${trackIndex + 1} · ${String(track.type ?? 'video')}`),
        h(React, 'div', { className: 'otn-field__row' },
          h(React, 'button', { type: 'button', className: 'otn-toggle', disabled, 'aria-pressed': track.muted === true, 'data-otn-track-prop': 'muted', onClick: () => { void store.setTrackProperties(trackIndex, { muted: track.muted !== true }); } }, t('mute')),
          h(React, 'button', { type: 'button', className: 'otn-toggle', disabled, 'aria-pressed': track.hidden === true, 'data-otn-track-prop': 'hidden', onClick: () => { void store.setTrackProperties(trackIndex, { hidden: track.hidden !== true }); } }, t('hide')),
          h(React, 'button', { type: 'button', className: 'otn-toggle', disabled, 'aria-pressed': track.syncLocked === true, 'data-otn-track-prop': 'syncLocked', onClick: () => { void store.setTrackProperties(trackIndex, { syncLocked: track.syncLocked !== true }); } }, t('syncLock')),
        ),
      ),
    ),
  );
}

const CODECS = ['h264', 'h265', 'prores', 'prores4444'];
const QUALITIES = ['720p', '1080p', '4k'];

function ExportPanel({ React, state, store, t }) {
  const [form, setForm] = React.useState({
    outPath: '/tmp/opentake-export.mp4',
    codec: 'h264',
    quality: '1080p',
    bitDepth: 8,
    rangeStartFrame: 0,
    rangeEndFrame: '',
    duckMusic: false,
    hdr10: false,
  });
  const es = state.exportState;
  function update(key, value) { setForm((current) => ({ ...current, [key]: value })); }
  function submit(event) {
    event.preventDefault();
    if (es.active) return;
    void store.exportVideo({
      outPath: form.outPath.trim(),
      codec: form.codec,
      quality: form.quality,
      bitDepth: form.bitDepth === 10 ? 10 : 8,
      rangeStartFrame: form.rangeStartFrame === '' ? null : Number(form.rangeStartFrame),
      rangeEndFrame: form.rangeEndFrame === '' ? null : Number(form.rangeEndFrame),
      duckMusic: form.duckMusic,
      hdr10: form.hdr10,
    });
  }
  const progress = es.total > 0 ? Math.min(100, Math.round((es.done / es.total) * 100)) : 0;
  return h(React, 'div', { className: 'otn-overlay', 'data-otn-panel': 'export' },
    h(React, 'form', { className: 'otn-sheet', onSubmit: submit, 'aria-label': t('exportTitle') },
      h(React, 'div', { className: 'otn-sheet__header' },
        h(React, 'h2', { className: 'otn-sheet__title' }, t('exportTitle')),
        button(React, t('close'), () => store.closePanel(), { ariaLabel: t('close') }),
      ),
      h(React, 'div', { className: 'otn-sheet__body' },
        h(React, 'label', { className: 'otn-field' },
          h(React, 'span', { className: 'otn-field__label' }, t('outputPath')),
          h(React, 'input', {
            className: 'otn-field__input',
            value: form.outPath,
            'data-otn-export-field': 'outPath',
            onChange: (event) => update('outPath', event.target.value),
            spellCheck: false,
          }),
        ),
        h(React, 'div', { className: 'otn-field__row' },
          h(React, 'label', { className: 'otn-field' },
            h(React, 'span', { className: 'otn-field__label' }, t('codec')),
            h(React, 'select', { className: 'otn-field__input', value: form.codec, 'data-otn-export-field': 'codec', onChange: (event) => update('codec', event.target.value) },
              CODECS.map((codec) => h(React, 'option', { key: codec, value: codec }, codec))),
          ),
          h(React, 'label', { className: 'otn-field' },
            h(React, 'span', { className: 'otn-field__label' }, t('quality')),
            h(React, 'select', { className: 'otn-field__input', value: form.quality, 'data-otn-export-field': 'quality', onChange: (event) => update('quality', event.target.value) },
              QUALITIES.map((quality) => h(React, 'option', { key: quality, value: quality }, quality))),
          ),
          h(React, 'label', { className: 'otn-field' },
            h(React, 'span', { className: 'otn-field__label' }, t('bitDepth')),
            h(React, 'select', { className: 'otn-field__input', value: form.bitDepth, 'data-otn-export-field': 'bitDepth', onChange: (event) => update('bitDepth', Number(event.target.value)) },
              h(React, 'option', { value: 8 }, '8-bit'),
              h(React, 'option', { value: 10 }, '10-bit')),
          ),
        ),
        h(React, 'div', { className: 'otn-field__row' },
          h(React, 'label', { className: 'otn-field' },
            h(React, 'span', { className: 'otn-field__label' }, `${t('range')} · ${t('rangeStart')}`),
            h(React, 'input', { className: 'otn-field__input', type: 'number', min: 0, value: form.rangeStartFrame, 'data-otn-export-field': 'rangeStartFrame', onChange: (event) => update('rangeStartFrame', event.target.value) }),
          ),
          h(React, 'label', { className: 'otn-field' },
            h(React, 'span', { className: 'otn-field__label' }, `${t('range')} · ${t('rangeEnd')}`),
            h(React, 'input', { className: 'otn-field__input', type: 'number', min: 0, value: form.rangeEndFrame, placeholder: t('notAvailable'), 'data-otn-export-field': 'rangeEndFrame', onChange: (event) => update('rangeEndFrame', event.target.value) }),
          ),
        ),
        h(React, 'div', { className: 'otn-field__row' },
          h(React, 'button', { type: 'button', className: 'otn-toggle', 'aria-pressed': form.duckMusic, 'data-otn-export-field': 'duckMusic', onClick: () => update('duckMusic', !form.duckMusic) }, t('duckMusic')),
          h(React, 'button', { type: 'button', className: 'otn-toggle', 'aria-pressed': form.hdr10, 'data-otn-export-field': 'hdr10', onClick: () => update('hdr10', !form.hdr10) }, t('hdr10')),
        ),
        h(React, 'p', { className: 'otn-sheet__hint' }, t('exportHint')),
        h(React, 'div', { className: 'otn-field__row' },
          h(React, 'button', { type: 'submit', className: 'otn-btn otn-btn--primary', 'data-otn-action': 'export-submit', disabled: es.active }, es.active ? t('exporting') : t('exportNow')),
          es.active ? button(React, t('cancel'), () => { void store.cancelExport(); }) : null,
        ),
        h(React, 'div', { className: 'otn-field', 'data-otn-export-status': es.phase, role: 'status' },
          h(React, 'span', { className: 'otn-field__label' }, es.phase === 'error' ? t('exportFailed') : es.phase === 'complete' ? t('exportComplete') : es.active ? t('exporting') : t('exportIdle')),
          es.active ? h(React, 'div', { className: 'otn-progress-bar' }, h(React, 'div', { className: 'otn-progress-bar__fill', style: { inlineSize: `${progress}%` } })) : null,
          es.active ? h(React, 'span', { className: 'otn-sheet__hint' }, `${es.done} / ${es.total || '?'}`) : null,
          es.error !== null ? h(React, 'span', { className: 'otn-sheet__hint' }, es.error) : null,
          es.summary !== null ? h(React, 'span', { className: 'otn-sheet__hint' }, JSON.stringify(es.summary).slice(0, 500)) : null,
        ),
      ),
    ),
  );
}

function SettingsPanel({ React, state, store, t }) {
  React.useEffect(() => { void store.refreshSettings(); }, []);
  const settings = state.settings;
  const storage = settings?.storage;
  const categories = Array.isArray(storage?.categories) ? storage.categories : [];
  const search = settings?.search ?? null;
  const transcribe = settings?.transcribe ?? null;
  return h(React, 'div', { className: 'otn-overlay', 'data-otn-panel': 'settings' },
    h(React, 'section', { className: 'otn-sheet', 'aria-label': t('settingsTitle') },
      h(React, 'div', { className: 'otn-sheet__header' },
        h(React, 'h2', { className: 'otn-sheet__title' }, t('settingsTitle')),
        button(React, t('close'), () => store.closePanel(), { ariaLabel: t('close') }),
      ),
      h(React, 'div', { className: 'otn-sheet__body' },
        h(React, 'p', { className: 'otn-sheet__hint' }, t('settingsHint')),
        h(React, 'div', { className: 'otn-sheet__section' },
          h(React, 'span', { className: 'otn-sheet__section-title' }, t('storage')),
          h(React, 'div', { className: 'otn-storage-row' },
            h(React, 'span', { className: 'otn-storage-row__name' }, t('total')),
            h(React, 'span', null, `${Math.round(Number(storage?.totalBytes ?? 0) / 1024)} KB`),
          ),
          categories.map((category) => h(React, 'div', { key: category.id, className: 'otn-storage-row' },
            h(React, 'span', { className: 'otn-storage-row__name' }, String(category.id)),
            h(React, 'span', null, `${Math.round(Number(category.bytes ?? 0) / 1024)} KB`),
            ['thumbnails', 'other', 'searchIndex'].includes(category.id)
              ? button(React, t('clearCache'), () => { void store.clearStorage([category.id]); }, { disabled: state.settingsLoading })
              : null,
          )),
        ),
        h(React, 'div', { className: 'otn-sheet__section' },
          h(React, 'span', { className: 'otn-sheet__section-title' }, t('modelStatus')),
          h(React, 'div', { className: 'otn-kv' },
            h(React, 'span', null, t('searchModel')),
            h(React, 'span', { className: 'otn-kv__value' }, search === null ? t('notAvailable') : `${search.visualAvailable === true ? 'ready' : 'missing'}${search.model ? ` · ${search.model}` : ''}`),
            h(React, 'span', null, t('transcribeModel')),
            h(React, 'span', { className: 'otn-kv__value' }, transcribe === null ? t('notAvailable') : `${transcribe.installed === true ? 'ready' : 'not configured'}${transcribe.model ? ` · ${transcribe.model}` : ''}`),
            h(React, 'span', null, t('searchIndex')),
            h(React, 'span', { className: 'otn-kv__value' }, settings?.searchIndex === null || settings?.searchIndex === undefined ? t('notAvailable') : JSON.stringify(settings.searchIndex).slice(0, 180)),
          ),
        ),
        settings?.error !== null && settings?.error !== undefined
          ? h(React, 'p', { className: 'otn-error__message' }, settings.error)
          : null,
        h(React, 'div', { className: 'otn-field__row' },
          button(React, t('refresh'), () => { void store.refreshSettings(); }, { disabled: state.settingsLoading }),
          state.settingsLoading ? h(React, 'span', { className: 'otn-progress', role: 'status' }, t('loading')) : null,
        ),
      ),
    ),
  );
}

function EditorView(React, { state, store, client, t }) {
  return h(React, 'div', { className: 'otn-body' },
    MediaPanel(React, { state, client, t, store }),
    h(React, 'div', { className: 'otn-main' },
      PreviewPane(React, { state, client, store, t }),
      TimelinePane(React, { state, store, t }),
    ),
    h(React, InspectorPanel, { React, state, store, t }),
  );
}

/**
 * Root view. Pass `React` as a prop rather than importing it, so a native
 * client bundle can externalize React and this module can be contract-tested
 * with a stub.
 */
export function NativeEditorView({ React, store, client, theme = 'system' }) {
  if (React === null || typeof React.createElement !== 'function') throw new TypeError('React is required');
  if (client === null || typeof client !== 'object') throw new TypeError('client is required');
  const state = useStore(React, store);
  const t = createTranslator(state.locale).t;
  const resolvedTheme = theme === 'light' || theme === 'dark' ? theme : (state.theme === 'light' || state.theme === 'dark' ? state.theme : 'system');
  const busy = state.loading || state.busy;
  return h(React, 'div', { className: 'otn-root', 'data-theme': resolvedTheme, 'data-otn-panel': state.panel, lang: state.locale },
    h(React, 'header', { className: 'otn-header' },
      h(React, 'div', { className: 'otn-brand' },
        h(React, 'span', { className: 'otn-brand__name' }, t('appName')),
        h(React, 'span', { className: 'otn-brand__note' }, t('nativePreview')),
      ),
      statusBadge(React, state, t),
      h(React, 'span', { className: 'otn-project-path', title: state.projectPath ?? '' }, state.projectPath ?? t('noProject')),
      h(React, 'span', { className: 'otn-spacer' }),
      h(React, 'div', { className: 'otn-actions' },
        state.view === 'editor' ? button(React, t('home'), () => store.setView('home')) : null,
        state.view === 'editor' ? h(React, 'button', { type: 'button', className: 'otn-btn', 'data-otn-action': 'open-inspector', onClick: () => { store.setView('editor'); store.closePanel(); } }, t('inspector')) : null,
        h(React, 'button', {
          type: 'button',
          className: 'otn-btn',
          'data-otn-action': 'open-export',
          'aria-pressed': state.panel === 'export',
          onClick: () => store.openPanel(state.panel === 'export' ? 'editor' : 'export'),
        }, t('export')),
        h(React, 'button', {
          type: 'button',
          className: 'otn-btn',
          'data-otn-action': 'open-settings',
          'aria-pressed': state.panel === 'settings',
          onClick: () => store.openPanel(state.panel === 'settings' ? 'editor' : 'settings'),
        }, t('settings')),
        state.view === 'editor' ? button(React, t('saveProject'), () => { void store.saveProject(); }, { disabled: busy }) : null,
        button(React, t('refresh'), () => { void store.refresh(); }, { disabled: busy }),
        busy ? h(React, 'span', { className: 'otn-progress', role: 'status' }, t('busy')) : null,
      ),
    ),
    ErrorBanner(React, state, store, t),
    state.view === 'home'
      ? h(React, HomeView, { React, state, store, client, t })
      : EditorView(React, { state, store, client, t }),
    state.panel === 'export' ? h(React, ExportPanel, { React, state, store, t }) : null,
    state.panel === 'settings' ? h(React, SettingsPanel, { React, state, store, t }) : null,
    h(React, 'footer', { className: 'otn-status' },
      h(React, 'span', null, `${t('projectVersion', { version: state.timeline?.version ?? 0 })}`),
      h(React, 'span', { className: 'otn-spacer' }),
      h(React, 'span', null, `${t('media')}: ${state.media.length}`),
      h(React, 'span', null, `${t('timeline')}: ${clipCount(state.timeline)}`),
    ),
  );
}

export function createNativeEditorElement({ React, store, client, theme = 'system' }) {
  return h(React, NativeEditorView, { React, store, client, theme });
}

export { h as createElement };
