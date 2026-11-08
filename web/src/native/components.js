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

function EditorView(React, { state, store, client, t }) {
  return h(React, 'div', { className: 'otn-body' },
    MediaPanel(React, { state, client, t, store }),
    h(React, 'div', { className: 'otn-main' },
      PreviewPane(React, { state, client, store, t }),
      TimelinePane(React, { state, store, t }),
    ),
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
  return h(React, 'div', { className: 'otn-root', 'data-theme': resolvedTheme, lang: state.locale },
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
        state.view === 'editor' ? button(React, t('saveProject'), () => { void store.saveProject(); }, { disabled: busy }) : null,
        button(React, t('refresh'), () => { void store.refresh(); }, { disabled: busy }),
        busy ? h(React, 'span', { className: 'otn-progress', role: 'status' }, t('busy')) : null,
      ),
    ),
    ErrorBanner(React, state, store, t),
    state.view === 'home'
      ? h(React, HomeView, { React, state, store, client, t })
      : EditorView(React, { state, store, client, t }),
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
