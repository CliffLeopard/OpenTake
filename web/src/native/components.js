/**
 * Native Route B editor view for the bounded home/media/timeline/preview
 * milestone. Components are authored with `createElement` so this module has no
 * JSX build requirement and no React import: the mount caller supplies the
 * external React instance.
 */

import { createTranslator } from './locale.js';
import { captionClips, clipCount, evaluateScalarTrack, findClip, mediaItems, timelineMeta, timelineTracks, totalFrames } from './store.js';

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
    h(React, 'form', {
      className: 'otn-media-import',
      onSubmit: (event) => {
        event.preventDefault();
        const input = event.currentTarget.elements.nativeImportPath;
        const value = typeof input?.value === 'string' ? input.value.trim() : '';
        if (value.length > 0) {
          void store.importMedia([value]);
          input.value = '';
        }
      },
    },
      h(React, 'input', { className: 'otn-input', name: 'nativeImportPath', placeholder: t('importMediaPath'), 'aria-label': t('importMediaPath'), spellCheck: false, 'data-otn-import-path': '' }),
      h(React, 'button', { type: 'submit', className: 'otn-btn', disabled: state.busy, 'data-otn-action': 'import-media' }, state.busy ? t('importing') : t('importMedia')),
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
    h(React, 'div', { className: 'otn-transport', 'data-otn-playback': state.playback.active ? (state.playback.paused ? 'paused' : 'playing') : 'idle' },
      button(React, '◀', () => { void store.seekTo(Math.max(0, frame - 1)); }, { ariaLabel: t('previousFrame'), disabled: frame <= 0, title: t('previousFrame') }),
      h(React, 'button', {
        type: 'button',
        className: 'otn-btn otn-btn--icon',
        'data-otn-action': 'playback-toggle',
        'aria-label': state.playback.active && !state.playback.paused ? t('pause') : t('play'),
        title: state.playback.active && !state.playback.paused ? t('pause') : t('play'),
        onClick: () => { if (state.playback.active && !state.playback.paused) { void store.pause(); } else { void store.play(); } },
      }, state.playback.active && !state.playback.paused ? '❚❚' : '▶'),
      h(React, 'button', { type: 'button', className: 'otn-btn otn-btn--icon', 'data-otn-action': 'playback-stop', 'aria-label': t('stop'), title: t('stop'), onClick: () => { void store.stopPlayback(); } }, '■'),
      h(React, 'input', {
        className: 'otn-scrub',
        type: 'range',
        min: 0,
        max: Math.max(0, maxFrame),
        value: frame,
        onChange: (event) => { void store.seekTo(Number(event.target.value)); },
        'aria-label': t('frame'),
      }),
      button(React, '▶', () => { void store.seekTo(Math.min(maxFrame, frame + 1)); }, { ariaLabel: t('nextFrame'), disabled: frame >= maxFrame, title: t('nextFrame') }),
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
      h(React, EffectsSection, { React, clip, store, t, disabled }),
      h(React, KeyframesSection, { React, state, clip, store, t, disabled }),
      h(React, MasksSection, { React, clip, store, t, disabled }),
    ),
  );
}

const EFFECT_KINDS = ['grayscale', 'sepia', 'invert'];
const KEYFRAME_TRACKS = [
  { property: 'opacity', field: 'opacityTrack', scalar: true, value: (clip) => Number(clip.opacity ?? 1) },
  { property: 'volume', field: 'volumeTrack', scalar: true, value: (clip) => Number(clip.volume ?? 1) },
  { property: 'rotation', field: 'rotationTrack', scalar: true, value: (clip) => Number(clip.transform?.rotation ?? 0) },
  { property: 'position', field: 'positionTrack', scalar: false },
  { property: 'scale', field: 'scaleTrack', scalar: false },
  { property: 'crop', field: 'cropTrack', scalar: false },
];

function EffectsSection({ React, clip, store, t, disabled }) {
  const effects = Array.isArray(clip.effects) ? clip.effects : [];
  function setEffects(next) { void store.setClipEffects(clip.id, next); }
  function addEffect(name) {
    if (effects.length >= 8) return;
    setEffects([...effects, { name, params: { amount: 1 }, enabled: true }]);
  }
  function updateEffect(index, patch) {
    setEffects(effects.map((effect, effectIndex) => (effectIndex === index ? { ...effect, ...patch } : effect)));
  }
  return h(React, 'div', { className: 'otn-inspector__group', 'data-otn-effects': '' },
    h(React, 'span', { className: 'otn-inspector__title' }, t('effects')),
    h(React, 'div', { className: 'otn-field__row' },
      EFFECT_KINDS.map((name) => h(React, 'button', {
        key: name,
        type: 'button',
        className: 'otn-toggle',
        'data-otn-effect-add': name,
        disabled: disabled || effects.length >= 8,
        onClick: () => addEffect(name),
      }, name)),
    ),
    effects.length === 0 ? h(React, 'p', { className: 'otn-sheet__hint' }, t('noEffects')) : null,
    effects.map((effect, index) => h(React, 'div', { key: `${effect.name}-${index}`, className: 'otn-effect-card', 'data-otn-effect-index': index, 'data-otn-effect-name': effect.name },
      h(React, 'div', { className: 'otn-field__row' },
        h(React, 'strong', { className: 'otn-inspector__track-name' }, effect.name),
        h(React, 'button', { type: 'button', className: 'otn-toggle', 'aria-pressed': effect.enabled !== false, 'data-otn-effect-enabled': index, onClick: () => updateEffect(index, { enabled: effect.enabled === false }) }, t('effectEnabled')),
        h(React, 'button', { type: 'button', className: 'otn-toggle', 'data-otn-effect-remove': index, onClick: () => setEffects(effects.filter((_, effectIndex) => effectIndex !== index)) }, t('removeEffect')),
      ),
      h(React, 'label', { className: 'otn-field' },
        h(React, 'span', { className: 'otn-field__label' }, t('amount')),
        h(React, 'input', {
          className: 'otn-field__input', type: 'number', min: 0, max: 1, step: 0.01,
          defaultValue: String(effect.params?.amount ?? 1),
          'data-otn-effect-amount': index,
          onBlur: (event) => {
            const value = Math.min(1, Math.max(0, Number(event.target.value)));
            if (Number.isFinite(value)) updateEffect(index, { params: { ...(effect.params ?? {}), amount: value } });
          },
        }),
      ),
    )),
    h(React, 'p', { className: 'otn-sheet__hint' }, t('effectsHint')),
  );
}

function KeyframesSection({ React, state, clip, store, t, disabled }) {
  return h(React, 'div', { className: 'otn-inspector__group', 'data-otn-keyframes': '' },
    h(React, 'span', { className: 'otn-inspector__title' }, t('keyframes')),
    KEYFRAME_TRACKS.map(({ property, field, scalar, value }) => {
      const track = clip[field];
      const keyframes = Array.isArray(track?.keyframes) ? track.keyframes : [];
      const evaluated = scalar && track !== undefined ? evaluateScalarTrack(track, state.frame) : null;
      return h(React, 'div', { key: property, className: 'otn-keyframe-track', 'data-otn-keyframe-track': property },
        h(React, 'div', { className: 'otn-field__row' },
          h(React, 'strong', { className: 'otn-inspector__track-name' }, property),
          h(React, 'span', { className: 'otn-sheet__hint' }, `${keyframes.length}`),
          scalar ? h(React, 'button', {
            type: 'button', className: 'otn-toggle', 'data-otn-keyframe-add': property, disabled,
            onClick: () => { void store.upsertKeyframe(clip.id, property, state.frame, Number(value(clip))); },
          }, t('addKeyframe')) : null,
        ),
        keyframes.length === 0 ? null : h(React, 'div', { className: 'otn-keyframe-list' },
          keyframes.map((keyframe) => h(React, 'div', { key: `${property}-${keyframe.frame}`, className: 'otn-keyframe-row', 'data-otn-keyframe-frame': keyframe.frame },
            h(React, 'span', null, `${t('frame')} ${keyframe.frame}`),
            h(React, 'span', { className: 'otn-sheet__hint' }, typeof keyframe.value === 'object' ? JSON.stringify(keyframe.value) : String(keyframe.value)),
            h(React, 'button', {
              type: 'button', className: 'otn-toggle', disabled,
              'data-otn-keyframe-remove': `${property}:${keyframe.frame}`,
              onClick: () => { void store.removeKeyframe(clip.id, property, keyframe.frame); },
            }, t('removeKeyframe')),
          )),
        ),
        evaluated !== null ? h(React, 'span', { className: 'otn-sheet__hint' }, `${t('evaluate')} ${state.frame}: ${evaluated.toFixed(3)}`) : null,
      );
    }),
    h(React, 'p', { className: 'otn-sheet__hint' }, t('keyframesHint')),
  );
}

function maskLabel(mask) {
  const kind = mask?.shape?.kind;
  return kind === 'circle' ? 'ellipse' : kind === 'poly' ? 'rectangle / poly' : kind === 'linear' ? 'linear' : 'mask';
}

function MasksSection({ React, clip, store, t, disabled }) {
  const masks = Array.isArray(clip.masks) ? clip.masks : [];
  function setMasks(next) { void store.setClipMasks(clip.id, next); }
  function updateMask(index, patch) {
    setMasks(masks.map((mask, maskIndex) => (maskIndex === index ? { ...mask, ...patch } : mask)));
  }
  function addMask(kind) {
    const mask = kind === 'ellipse'
      ? { shape: { kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: { x: 0.3, y: 0.3 } }, feather: 0, invert: false }
      : { shape: { kind: 'poly', points: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 }] }, feather: 0, invert: false };
    setMasks([...masks, mask]);
  }
  return h(React, 'div', { className: 'otn-inspector__group', 'data-otn-masks': '' },
    h(React, 'span', { className: 'otn-inspector__title' }, t('masks')),
    h(React, 'div', { className: 'otn-field__row' },
      h(React, 'button', { type: 'button', className: 'otn-toggle', disabled, 'data-otn-mask-add': 'rect', onClick: () => addMask('rect') }, t('addRectMask')),
      h(React, 'button', { type: 'button', className: 'otn-toggle', disabled, 'data-otn-mask-add': 'ellipse', onClick: () => addMask('ellipse') }, t('addEllipseMask')),
    ),
    masks.length === 0 ? h(React, 'p', { className: 'otn-sheet__hint' }, t('noMasks')) : masks.map((mask, index) => h(React, 'div', { key: index, className: 'otn-effect-card', 'data-otn-mask-index': index },
      h(React, 'div', { className: 'otn-field__row' },
        h(React, 'strong', { className: 'otn-inspector__track-name' }, maskLabel(mask)),
        h(React, 'button', { type: 'button', className: 'otn-toggle', 'aria-pressed': mask.invert === true, 'data-otn-mask-invert': index, onClick: () => updateMask(index, { invert: mask.invert !== true }) }, t('invertMask')),
        h(React, 'button', { type: 'button', className: 'otn-toggle', 'data-otn-mask-remove': index, onClick: () => setMasks(masks.filter((_, maskIndex) => maskIndex !== index)) }, t('removeMask')),
      ),
      h(React, 'label', { className: 'otn-field' },
        h(React, 'span', { className: 'otn-field__label' }, t('feather')),
        h(React, 'input', {
          className: 'otn-field__input', type: 'number', min: 0, max: 1, step: 0.01,
          defaultValue: String(mask.feather ?? 0),
          'data-otn-mask-feather': index,
          onBlur: (event) => {
            const value = Math.max(0, Number(event.target.value));
            if (Number.isFinite(value)) updateMask(index, { feather: value });
          },
        }),
      ),
    )),
    h(React, 'p', { className: 'otn-sheet__hint' }, t('masksHint')),
  );
}

function CaptionsPanel({ React, state, store, t }) {
  const captions = captionClips(state.timeline);
  const [selectedId, setSelectedId] = React.useState('');
  const [draft, setDraft] = React.useState({ content: '', startFrame: 0, durationFrames: 60 });
  const selected = captions.find((entry) => entry.clip.id === selectedId)?.clip ?? null;
  function selectCaption(clip) {
    setSelectedId(clip.id);
    setDraft({ content: typeof clip.textContent === 'string' ? clip.textContent : '', startFrame: clip.startFrame, durationFrames: clip.durationFrames });
  }
  function create(event) {
    event.preventDefault();
    const content = draft.content.trim();
    if (content.length === 0) return;
    void store.addCaption({ content, startFrame: Number(draft.startFrame), durationFrames: Number(draft.durationFrames) });
    setDraft({ content: '', startFrame: 0, durationFrames: 60 });
  }
  function save() {
    if (selected === null) return;
    void store.updateCaption(selected.id, {
      content: draft.content,
      startFrame: Number(draft.startFrame),
      durationFrames: Number(draft.durationFrames),
    });
  }
  return h(React, 'div', { className: 'otn-overlay', 'data-otn-panel': 'captions' },
    h(React, 'section', { className: 'otn-sheet', 'aria-label': t('captions') },
      h(React, 'div', { className: 'otn-sheet__header' },
        h(React, 'h2', { className: 'otn-sheet__title' }, t('captions')),
        button(React, t('close'), () => store.closePanel(), { ariaLabel: t('close') }),
      ),
      h(React, 'div', { className: 'otn-sheet__body' },
        h(React, 'div', { className: 'otn-sheet__section' },
          h(React, 'span', { className: 'otn-sheet__section-title' }, t('captions')),
          captions.length === 0 ? h(React, 'p', { className: 'otn-sheet__hint' }, t('captionsEmpty')) : captions.map((entry) => h(React, 'button', {
            key: entry.clip.id,
            type: 'button',
            className: `otn-toggle${entry.clip.id === selectedId ? ' otn-toggle--active' : ''}`,
            'data-otn-caption-id': entry.clip.id,
            onClick: () => selectCaption(entry.clip),
          }, `${entry.clip.startFrame}+${entry.clip.durationFrames} · ${entry.clip.textContent ?? ''}`)),
        ),
        h(React, 'form', { className: 'otn-sheet__section', onSubmit: create },
          h(React, 'span', { className: 'otn-sheet__section-title' }, t('addCaption')),
          h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('captionText')), h(React, 'textarea', { className: 'otn-field__input', rows: 2, value: draft.content, 'data-otn-caption-content': 'new', onChange: (event) => setDraft((current) => ({ ...current, content: event.target.value })) })),
          h(React, 'div', { className: 'otn-field__row' },
            h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('rangeStart')), h(React, 'input', { className: 'otn-field__input', type: 'number', min: 0, value: draft.startFrame, 'data-otn-caption-start': 'new', onChange: (event) => setDraft((current) => ({ ...current, startFrame: event.target.value })) })),
            h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('duration')), h(React, 'input', { className: 'otn-field__input', type: 'number', min: 1, value: draft.durationFrames, 'data-otn-caption-duration': 'new', onChange: (event) => setDraft((current) => ({ ...current, durationFrames: event.target.value })) })),
          ),
          h(React, 'div', { className: 'otn-field__row' }, h(React, 'button', { type: 'submit', className: 'otn-btn otn-btn--primary', 'data-otn-action': 'caption-create' }, t('addCaption'))),
        ),
        selected === null ? null : h(React, 'div', { className: 'otn-sheet__section', 'data-otn-caption-edit': selected.id },
          h(React, 'span', { className: 'otn-sheet__section-title' }, `${t('saveCaption')} · ${selected.captionGroupId}`),
          h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('captionText')), h(React, 'textarea', { className: 'otn-field__input', rows: 2, value: draft.content, 'data-otn-caption-content': 'selected', onChange: (event) => setDraft((current) => ({ ...current, content: event.target.value })) })),
          h(React, 'div', { className: 'otn-field__row' },
            h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('rangeStart')), h(React, 'input', { className: 'otn-field__input', type: 'number', min: 0, value: draft.startFrame, 'data-otn-caption-start': 'selected', onChange: (event) => setDraft((current) => ({ ...current, startFrame: event.target.value })) })),
            h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('duration')), h(React, 'input', { className: 'otn-field__input', type: 'number', min: 1, value: draft.durationFrames, 'data-otn-caption-duration': 'selected', onChange: (event) => setDraft((current) => ({ ...current, durationFrames: event.target.value })) })),
          ),
          h(React, 'div', { className: 'otn-field__row' }, h(React, 'button', { type: 'button', className: 'otn-btn otn-btn--primary', 'data-otn-action': 'caption-save', onClick: save }, t('saveCaption'))),
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
          'data-otn-action': 'open-captions',
          'aria-pressed': state.panel === 'captions',
          onClick: () => store.openPanel(state.panel === 'captions' ? 'editor' : 'captions'),
        }, t('captions')),
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
    state.panel === 'captions' ? h(React, CaptionsPanel, { React, state, store, t }) : null,
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
