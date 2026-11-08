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
  return h(React, 'aside', {
    className: 'otn-media', 'aria-label': t('media'), 'data-otn-dropzone': '',
    onDragOver: (event) => event.preventDefault(),
    onDrop: (event) => {
      event.preventDefault();
      void store.uploadFiles(event.dataTransfer?.files);
    },
  },
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
      h(React, 'input', {
        type: 'file',
        className: 'otn-file-picker',
        'data-otn-file-picker': '',
        onChange: (event) => {
          void store.uploadFiles(event.target.files);
          event.target.value = '';
        },
      }),
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
  const [tab, setTab] = React.useState('properties');
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
      h(React, 'div', { className: 'otn-inspector__tabs', role: 'tablist' },
        ['properties', 'effects', 'keyframes', 'masks', 'advanced'].map((name) => h(React, 'button', {
          key: name, type: 'button', role: 'tab', className: `otn-inspector__tab${tab === name ? ' otn-inspector__tab--active' : ''}`,
          'aria-selected': tab === name, 'data-otn-inspector-tab': name,
          onClick: () => { setTab(name); if (name === 'advanced') void store.refreshLuts(); },
        }, t(name === 'properties' ? 'properties' : name))),
      ),
      h(React, 'div', { hidden: tab !== 'properties' },
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
      h(React, 'div', { hidden: tab !== 'effects' }, h(React, EffectsSection, { React, clip, store, t, disabled })),
      h(React, 'div', { hidden: tab !== 'keyframes' }, h(React, KeyframesSection, { React, state, clip, store, t, disabled })),
      h(React, 'div', { hidden: tab !== 'masks' }, h(React, MasksSection, { React, clip, store, t, disabled })),
      h(React, 'div', { hidden: tab !== 'advanced' }, h(React, AdvancedSection, { React, state, clip, store, t, disabled })),
    ),
  );
}

function LibraryPanel({ React, state, store, t }) {
  const entries = state.library;
  return h(React, 'div', { className: 'otn-overlay', 'data-otn-panel': 'library' },
    h(React, 'section', { className: 'otn-sheet', 'aria-label': t('library') },
      h(React, 'div', { className: 'otn-sheet__header' },
        h(React, 'h2', { className: 'otn-sheet__title' }, t('library')),
        button(React, t('close'), () => store.closePanel(), { ariaLabel: t('close') }),
      ),
      h(React, 'div', { className: 'otn-sheet__body' },
        h(React, 'p', { className: 'otn-sheet__hint' }, t('libraryHint')),
        state.libraryLoading ? h(React, 'p', { className: 'otn-progress', role: 'status' }, t('loading')) : null,
        entries.length === 0 ? h(React, 'p', { className: 'otn-sheet__hint' }, t('libraryEmpty')) : entries.map((entry) => h(React, 'div', { key: entry.id, className: 'otn-effect-card', 'data-otn-library-id': entry.id },
          h(React, 'div', { className: 'otn-field__row' },
            h(React, 'strong', { className: 'otn-inspector__track-name' }, entry.name ?? entry.id),
            h(React, 'span', { className: 'otn-sheet__hint' }, entry.kind ?? entry.type ?? ''),
            h(React, 'button', { type: 'button', className: 'otn-btn', 'data-otn-action': 'library-import', onClick: () => { void store.importLibraryEntry(entry.id); } }, t('importToProject')),
          ),
          typeof entry.path === 'string' ? h(React, 'span', { className: 'otn-sheet__hint' }, entry.path) : null,
        )),
        h(React, 'button', { type: 'button', className: 'otn-btn', 'data-otn-action': 'library-refresh', onClick: () => { void store.refreshLibrary(); } }, t('refresh')),
      ),
    ),
  );
}

function MotionPanel({ React, state, store, t }) {
  const documents = state.motion;
  function create(event) {
    event.preventDefault();
    const input = event.currentTarget.elements.motionTitle;
    const title = typeof input?.value === 'string' && input.value.trim().length > 0 ? input.value.trim() : 'Untitled Motion';
    void store.createMotion(title);
    if (input) input.value = '';
  }
  return h(React, 'div', { className: 'otn-overlay', 'data-otn-panel': 'motion' },
    h(React, 'section', { className: 'otn-sheet', 'aria-label': t('motion') },
      h(React, 'div', { className: 'otn-sheet__header' },
        h(React, 'h2', { className: 'otn-sheet__title' }, t('motion')),
        button(React, t('close'), () => store.closePanel(), { ariaLabel: t('close') }),
      ),
      h(React, 'div', { className: 'otn-sheet__body' },
        h(React, 'p', { className: 'otn-sheet__hint' }, t('motionHint')),
        documents.length === 0 ? h(React, 'p', { className: 'otn-sheet__hint' }, t('motionEmpty')) : documents.map((document) => h(React, 'div', { key: document.id, className: 'otn-effect-card', 'data-otn-motion-id': document.id },
          h(React, 'strong', { className: 'otn-inspector__track-name' }, document.title ?? document.id),
          h(React, 'span', { className: 'otn-sheet__hint' }, document.revisionHash ? document.revisionHash.slice(0, 12) : ''),
        )),
        h(React, 'form', { className: 'otn-sheet__section', onSubmit: create },
          h(React, 'span', { className: 'otn-sheet__section-title' }, t('createMotion')),
          h(React, 'div', { className: 'otn-field__row' },
            h(React, 'input', { className: 'otn-input', name: 'motionTitle', placeholder: t('motionTitle'), 'data-otn-motion-title': '' }),
            h(React, 'button', { type: 'submit', className: 'otn-btn', 'data-otn-action': 'motion-create' }, t('createMotion')),
          ),
        ),
        h(React, 'button', { type: 'button', className: 'otn-btn', 'data-otn-action': 'motion-refresh', onClick: () => { void store.refreshMotion(); } }, t('refresh')),
      ),
    ),
  );
}

const GRADE_DEFAULT = {
  exposure: 0, temperature: 0, tint: 0,
  liftGammaGain: { lift: { r: 0, g: 0, b: 0 }, gamma: { r: 1, g: 1, b: 1 }, gain: { r: 1, g: 1, b: 1 } },
  contrast: 0, saturation: 1, hslSecondary: null,
};
const TEXT_STYLE_DEFAULT = {
  fontName: 'Helvetica-Bold', fontSize: 48, fontScale: 1,
  color: { r: 1, g: 1, b: 1, a: 1 }, alignment: 'center',
  shadow: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0 }, offsetX: 0, offsetY: 0, blur: 0 },
  background: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0 } },
  border: { enabled: false, color: { r: 0, g: 0, b: 0, a: 1 } },
};
const CHROMA_DEFAULT = {
  keyColor: { r: 0, g: 1, b: 0 }, similarity: 0.15, smoothness: 0.35, spill: 0.5,
};

function formNumber(form, name, fallback) {
  const raw = form.elements[name]?.value;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function AdvancedSection({ React, state, clip, store, t, disabled }) {
  const grade = clip.colorGrade ?? GRADE_DEFAULT;
  const textStyle = clip.textStyle ?? TEXT_STYLE_DEFAULT;
  const chroma = clip.chromaKey ?? null;
  const lut = clip.lut ?? null;
  return h(React, 'div', { className: 'otn-inspector__group', 'data-otn-advanced': '' },
    h(React, 'span', { className: 'otn-inspector__title' }, t('advanced')),

    h(React, 'form', {
      className: 'otn-advanced-card', 'data-otn-advanced-section': 'colorGrade',
      onSubmit: (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        void store.setColorGrade(clip.id, {
          ...GRADE_DEFAULT,
          ...grade,
          exposure: formNumber(form, 'exposure', grade.exposure ?? 0),
          temperature: formNumber(form, 'temperature', grade.temperature ?? 0),
          tint: formNumber(form, 'tint', grade.tint ?? 0),
          contrast: formNumber(form, 'contrast', grade.contrast ?? 0),
          saturation: formNumber(form, 'saturation', grade.saturation ?? 1),
          liftGammaGain: grade.liftGammaGain ?? GRADE_DEFAULT.liftGammaGain,
          hslSecondary: grade.hslSecondary ?? null,
        });
      },
    },
      h(React, 'span', { className: 'otn-inspector__title' }, t('colorGrade')),
      h(React, 'div', { className: 'otn-field__row' },
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('exposure')), h(React, 'input', { className: 'otn-field__input', name: 'exposure', type: 'number', step: 0.1, min: -5, max: 5, defaultValue: String(grade.exposure ?? 0), 'data-otn-grade-field': 'exposure' })),
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('contrast')), h(React, 'input', { className: 'otn-field__input', name: 'contrast', type: 'number', step: 0.05, min: -1, max: 2, defaultValue: String(grade.contrast ?? 0), 'data-otn-grade-field': 'contrast' })),
      ),
      h(React, 'div', { className: 'otn-field__row' },
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('temperature')), h(React, 'input', { className: 'otn-field__input', name: 'temperature', type: 'number', step: 0.05, min: -1, max: 1, defaultValue: String(grade.temperature ?? 0), 'data-otn-grade-field': 'temperature' })),
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('tint')), h(React, 'input', { className: 'otn-field__input', name: 'tint', type: 'number', step: 0.05, min: -1, max: 1, defaultValue: String(grade.tint ?? 0), 'data-otn-grade-field': 'tint' })),
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('saturation')), h(React, 'input', { className: 'otn-field__input', name: 'saturation', type: 'number', step: 0.05, min: 0, max: 3, defaultValue: String(grade.saturation ?? 1), 'data-otn-grade-field': 'saturation' })),
      ),
      h(React, 'div', { className: 'otn-field__row' },
        h(React, 'button', { type: 'submit', className: 'otn-btn', disabled, 'data-otn-action': 'grade-apply' }, t('apply')),
        clip.colorGrade !== null && clip.colorGrade !== undefined ? h(React, 'button', { type: 'button', className: 'otn-toggle', disabled, 'data-otn-action': 'grade-remove', onClick: () => { void store.setColorGrade(clip.id, null); } }, t('remove')) : null,
      ),
    ),

    h(React, 'form', {
      className: 'otn-advanced-card', 'data-otn-advanced-section': 'textStyle',
      onSubmit: (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        void store.setTextStyle(clip.id, {
          ...TEXT_STYLE_DEFAULT,
          ...textStyle,
          fontName: String(form.elements.fontName?.value ?? textStyle.fontName ?? 'Helvetica-Bold'),
          fontSize: formNumber(form, 'fontSize', textStyle.fontSize ?? 48),
          fontScale: formNumber(form, 'fontScale', textStyle.fontScale ?? 1),
          alignment: String(form.elements.alignment?.value ?? textStyle.alignment ?? 'center'),
          color: {
            r: formNumber(form, 'colorR', textStyle.color?.r ?? 1),
            g: formNumber(form, 'colorG', textStyle.color?.g ?? 1),
            b: formNumber(form, 'colorB', textStyle.color?.b ?? 1),
            a: formNumber(form, 'colorA', textStyle.color?.a ?? 1),
          },
        });
      },
    },
      h(React, 'span', { className: 'otn-inspector__title' }, t('textStyle')),
      h(React, 'div', { className: 'otn-field__row' },
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('fontName')), h(React, 'input', { className: 'otn-field__input', name: 'fontName', defaultValue: textStyle.fontName ?? 'Helvetica-Bold', 'data-otn-text-field': 'fontName' })),
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('fontSize')), h(React, 'input', { className: 'otn-field__input', name: 'fontSize', type: 'number', min: 4, max: 400, defaultValue: String(textStyle.fontSize ?? 48), 'data-otn-text-field': 'fontSize' })),
      ),
      h(React, 'div', { className: 'otn-field__row' },
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('alignment')), h(React, 'select', { className: 'otn-field__input', name: 'alignment', defaultValue: textStyle.alignment ?? 'center', 'data-otn-text-field': 'alignment' }, ['left', 'center', 'right'].map((value) => h(React, 'option', { key: value, value }, value)))),
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('textColor')), h(React, 'div', { className: 'otn-field__row' },
          h(React, 'input', { className: 'otn-field__input', name: 'colorR', type: 'number', min: 0, max: 1, step: 0.05, defaultValue: String(textStyle.color?.r ?? 1), 'aria-label': 'R' }),
          h(React, 'input', { className: 'otn-field__input', name: 'colorG', type: 'number', min: 0, max: 1, step: 0.05, defaultValue: String(textStyle.color?.g ?? 1), 'aria-label': 'G' }),
          h(React, 'input', { className: 'otn-field__input', name: 'colorB', type: 'number', min: 0, max: 1, step: 0.05, defaultValue: String(textStyle.color?.b ?? 1), 'aria-label': 'B' }),
        )),
      ),
      h(React, 'button', { type: 'submit', className: 'otn-btn', disabled, 'data-otn-action': 'text-style-apply' }, t('apply')),
    ),

    h(React, 'form', {
      className: 'otn-advanced-card', 'data-otn-advanced-section': 'chromaKey',
      onSubmit: (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        void store.setChromaKey(clip.id, {
          keyColor: {
            r: formNumber(form, 'keyR', chroma?.keyColor?.r ?? 0),
            g: formNumber(form, 'keyG', chroma?.keyColor?.g ?? 1),
            b: formNumber(form, 'keyB', chroma?.keyColor?.b ?? 0),
          },
          similarity: formNumber(form, 'similarity', chroma?.similarity ?? 0.15),
          smoothness: formNumber(form, 'smoothness', chroma?.smoothness ?? 0.35),
          spill: formNumber(form, 'spill', chroma?.spill ?? 0.5),
        });
      },
    },
      h(React, 'span', { className: 'otn-inspector__title' }, t('chromaKey')),
      h(React, 'div', { className: 'otn-field__row' },
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('keyColor')), h(React, 'div', { className: 'otn-field__row' },
          h(React, 'input', { className: 'otn-field__input', name: 'keyR', type: 'number', min: 0, max: 1, step: 0.05, defaultValue: String(chroma?.keyColor?.r ?? 0), 'aria-label': 'R' }),
          h(React, 'input', { className: 'otn-field__input', name: 'keyG', type: 'number', min: 0, max: 1, step: 0.05, defaultValue: String(chroma?.keyColor?.g ?? 1), 'aria-label': 'G' }),
          h(React, 'input', { className: 'otn-field__input', name: 'keyB', type: 'number', min: 0, max: 1, step: 0.05, defaultValue: String(chroma?.keyColor?.b ?? 0), 'aria-label': 'B' }),
        )),
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('similarity')), h(React, 'input', { className: 'otn-field__input', name: 'similarity', type: 'number', min: 0, max: 1, step: 0.01, defaultValue: String(chroma?.similarity ?? 0.15), 'data-otn-chroma-field': 'similarity' })),
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('spill')), h(React, 'input', { className: 'otn-field__input', name: 'spill', type: 'number', min: 0, max: 1, step: 0.01, defaultValue: String(chroma?.spill ?? 0.5), 'data-otn-chroma-field': 'spill' })),
      ),
      h(React, 'div', { className: 'otn-field__row' },
        h(React, 'button', { type: 'submit', className: 'otn-btn', disabled, 'data-otn-action': 'chroma-apply' }, t('apply')),
        chroma !== null ? h(React, 'button', { type: 'button', className: 'otn-toggle', disabled, 'data-otn-action': 'chroma-remove', onClick: () => { void store.setChromaKey(clip.id, null); } }, t('remove')) : null,
      ),
    ),

    h(React, 'form', {
      className: 'otn-advanced-card', 'data-otn-advanced-section': 'lut',
      onSubmit: (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const selectedId = String(form.elements.lutSelect?.value ?? '');
        const selected = state.luts.find((entry) => entry.id === selectedId) ?? null;
        const id = selected?.id ?? String(form.elements.lutId?.value ?? '').trim();
        const name = selected?.name ?? String(form.elements.lutName?.value ?? '').trim();
        if (id.length !== 64 || name.length === 0) {
          store.setError(t('lutInvalid'));
          return;
        }
        void store.setLut(clip.id, { id, name, intensity: formNumber(form, 'lutIntensity', selected?.intensity ?? 1) });
      },
    },
      h(React, 'span', { className: 'otn-inspector__title' }, t('lut')),
      h(React, 'p', { className: 'otn-sheet__hint' }, lut === null ? t('noLut') : `${lut.name ?? ''} · ${lut.intensity ?? ''}`),
      h(React, 'div', { className: 'otn-field__row' },
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('lutSelect')), h(React, 'select', { className: 'otn-field__input', name: 'lutSelect', defaultValue: lut?.id ?? '', 'data-otn-lut-select': '' },
          h(React, 'option', { value: '' }, t('lutSelectPlaceholder')),
          state.luts.map((entry) => h(React, 'option', { key: entry.id, value: entry.id }, `${entry.name ?? entry.id.slice(0, 12)} (${Math.round((entry.bytes ?? 0) / 1024)} KB)`)),
        )),
        h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('lutIntensity')), h(React, 'input', { className: 'otn-field__input', name: 'lutIntensity', type: 'number', min: 0, max: 1, step: 0.05, defaultValue: String(lut?.intensity ?? 1), 'data-otn-lut-field': 'intensity' })),
      ),
      h(React, 'div', { className: 'otn-field__row' },
        h(React, 'button', { type: 'submit', className: 'otn-btn', disabled, 'data-otn-action': 'lut-apply' }, t('applySelectedLut')),
        h(React, 'button', { type: 'button', className: 'otn-toggle', disabled: state.lutsLoading, 'data-otn-action': 'lut-refresh', onClick: () => { void store.refreshLuts(); } }, t('refresh')),
        lut !== null ? h(React, 'button', { type: 'button', className: 'otn-toggle', disabled, 'data-otn-action': 'lut-remove', onClick: () => { void store.setLut(clip.id, null); } }, t('remove')) : null,
      ),
      h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('lutUpload')), h(React, 'input', { type: 'file', accept: '.cube', className: 'otn-file-picker', 'data-otn-lut-upload': '', onChange: (event) => {
        const file = event.target.files?.[0] ?? null;
        event.target.value = '';
        if (file === null) return;
        void store.uploadFile(file, { kind: 'lut' }).then((result) => {
          const reference = result?.lut ?? null;
          if (reference !== null) void store.setLut(clip.id, reference);
        });
      } })),
      h(React, 'details', { className: 'otn-advanced-manual' },
        h(React, 'summary', null, t('lutManual')),
        h(React, 'div', { className: 'otn-field__row' },
          h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('lutId')), h(React, 'input', { className: 'otn-field__input', name: 'lutId', defaultValue: lut?.id ?? '', 'data-otn-lut-field': 'id', spellCheck: false })),
          h(React, 'label', { className: 'otn-field' }, h(React, 'span', { className: 'otn-field__label' }, t('lutName')), h(React, 'input', { className: 'otn-field__input', name: 'lutName', defaultValue: lut?.name ?? '', 'data-otn-lut-field': 'name' })),
        ),
      ),
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
      (() => {
        const transform = mask.transform ?? { offset: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDegrees: 0 };
        const updateTransform = (patch) => updateMask(index, { transform: { ...transform, ...patch } });
        return h(React, 'div', { className: 'otn-mask-advanced', 'data-otn-mask-transform': index },
          h(React, 'span', { className: 'otn-field__label' }, t('maskTransform')),
          h(React, 'div', { className: 'otn-field__row' },
            h(React, 'input', { className: 'otn-field__input', type: 'number', step: 0.01, defaultValue: String(transform.offset?.x ?? 0), 'aria-label': 'offsetX', 'data-otn-mask-offset-x': index, onBlur: (event) => updateTransform({ offset: { ...(transform.offset ?? { x: 0, y: 0 }), x: Number(event.target.value) } }) }),
            h(React, 'input', { className: 'otn-field__input', type: 'number', step: 0.01, defaultValue: String(transform.offset?.y ?? 0), 'aria-label': 'offsetY', 'data-otn-mask-offset-y': index, onBlur: (event) => updateTransform({ offset: { ...(transform.offset ?? { x: 0, y: 0 }), y: Number(event.target.value) } }) }),
            h(React, 'input', { className: 'otn-field__input', type: 'number', step: 0.01, defaultValue: String(transform.scale?.x ?? 1), 'aria-label': 'scaleX', 'data-otn-mask-scale-x': index, onBlur: (event) => updateTransform({ scale: { ...(transform.scale ?? { x: 1, y: 1 }), x: Number(event.target.value) } }) }),
            h(React, 'input', { className: 'otn-field__input', type: 'number', step: 0.01, defaultValue: String(transform.scale?.y ?? 1), 'aria-label': 'scaleY', 'data-otn-mask-scale-y': index, onBlur: (event) => updateTransform({ scale: { ...(transform.scale ?? { x: 1, y: 1 }), y: Number(event.target.value) } }) }),
            h(React, 'input', { className: 'otn-field__input', type: 'number', step: 1, defaultValue: String(transform.rotationDegrees ?? 0), 'aria-label': 'rotation', 'data-otn-mask-rotation': index, onBlur: (event) => updateTransform({ rotationDegrees: Number(event.target.value) }) }),
          ),
          mask.shape?.kind === 'poly'
            ? h(React, 'div', { className: 'otn-field' },
              h(React, 'span', { className: 'otn-field__label' }, t('maskPoints')),
              h(React, 'textarea', { className: 'otn-field__input', rows: 2, defaultValue: JSON.stringify(mask.shape.points ?? []), 'data-otn-mask-points': index }),
              h(React, 'button', {
                type: 'button', className: 'otn-btn', 'data-otn-mask-points-apply': index,
                onClick: (event) => {
                  try {
                    const points = JSON.parse(event.currentTarget.previousSibling.value);
                    if (!Array.isArray(points) || points.length < 3) throw new Error('need 3+ points');
                    updateMask(index, { shape: { ...mask.shape, points } });
                  } catch {
                    store.setError(t('maskPointsInvalid'));
                  }
                },
              }, t('apply')),
            )
            : null,
        );
      })(),
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
  const rootRef = React.useRef(null);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  function onKeyDown(event) {
    const target = event.target;
    const tag = typeof target?.tagName === 'string' ? target.tagName.toLowerCase() : '';
    const editable = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true;
    if (editable) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    if (key === ' ') {
      event.preventDefault();
      if (state.playback.active && !state.playback.paused) void store.pause();
      else void store.play();
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      const delta = key === 'ArrowLeft' ? -1 : 1;
      if (event.shiftKey) void store.moveSelected(delta);
      else void store.seekTo(state.frame + delta);
      return;
    }
    if (mod && (key === 'z' || key === 'Z')) {
      event.preventDefault();
      if (event.shiftKey) void store.redo();
      else void store.undo();
      return;
    }
    if (mod && (key === 'y' || key === 'Y')) {
      event.preventDefault();
      void store.redo();
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      void store.removeSelected();
      return;
    }
    if (mod && (key === 's' || key === 'S')) {
      event.preventDefault();
      void store.saveProject();
      return;
    }
    if (mod && (key === 'e' || key === 'E')) {
      event.preventDefault();
      store.openPanel('export');
      return;
    }
    if (key === '?' || (key === '/' && event.shiftKey)) {
      event.preventDefault();
      setShortcutsOpen((value) => !value);
      return;
    }
    if (key === 'Escape') {
      setShortcutsOpen(false);
      if (state.panel !== 'editor') store.closePanel();
    }
  }
  const shortcutRows = [
    ['shortcutPlay'], ['shortcutSeek'], ['shortcutNudge'], ['shortcutUndo'],
    ['shortcutRedo'], ['shortcutDelete'], ['shortcutSave'], ['shortcutExport'], ['shortcutHelp'],
  ];
  return h(React, 'div', {
    ref: rootRef,
    tabIndex: 0,
    onKeyDown,
    onPointerDown: (event) => { if (event.currentTarget === event.target) event.currentTarget.focus(); },
    className: 'otn-root', 'data-theme': resolvedTheme, 'data-otn-panel': state.panel, lang: state.locale,
  },
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
          'data-otn-action': 'open-library',
          'aria-pressed': state.panel === 'library',
          onClick: () => store.openPanel(state.panel === 'library' ? 'editor' : 'library'),
        }, t('library')),
        h(React, 'button', {
          type: 'button',
          className: 'otn-btn',
          'data-otn-action': 'open-motion',
          'aria-pressed': state.panel === 'motion',
          onClick: () => store.openPanel(state.panel === 'motion' ? 'editor' : 'motion'),
        }, t('motion')),
        h(React, 'button', {
          type: 'button',
          className: 'otn-btn',
          'data-otn-action': 'open-settings',
          'aria-pressed': state.panel === 'settings',
          onClick: () => store.openPanel(state.panel === 'settings' ? 'editor' : 'settings'),
        }, t('settings')),
        h(React, 'button', {
          type: 'button',
          className: 'otn-btn',
          'data-otn-action': 'open-shortcuts',
          'aria-pressed': shortcutsOpen,
          title: t('shortcuts'),
          onClick: () => setShortcutsOpen((value) => !value),
        }, '?'),
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
    state.panel === 'library' ? h(React, LibraryPanel, { React, state, store, t }) : null,
    state.panel === 'motion' ? h(React, MotionPanel, { React, state, store, t }) : null,
    shortcutsOpen ? h(React, 'div', { className: 'otn-overlay', 'data-otn-panel': 'shortcuts' },
      h(React, 'section', { className: 'otn-sheet', 'aria-label': t('shortcutsHelp') },
        h(React, 'div', { className: 'otn-sheet__header' },
          h(React, 'h2', { className: 'otn-sheet__title' }, t('shortcutsHelp')),
          button(React, t('close'), () => setShortcutsOpen(false), { ariaLabel: t('close') }),
        ),
        h(React, 'div', { className: 'otn-sheet__body' },
          h(React, 'ul', { className: 'otn-shortcut-list' }, shortcutRows.map(([key]) => h(React, 'li', { key }, h(React, 'span', null, t(key))))),
        ),
      ),
    ) : null,
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
