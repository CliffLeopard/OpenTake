/**
 * Native-editor locale adapter.
 *
 * Locale is explicit state passed through the mount contract; nothing here
 * writes `document.documentElement.lang` or touches the DSH page. The iframe's
 * app locale remains independent while the native shell is in prototype.
 */

export const TRANSLATIONS = Object.freeze({
  en: Object.freeze({
    appName: 'OpenTake',
    nativePreview: 'Native editor prototype',
    home: 'Home',
    editor: 'Editor',
    media: 'Media',
    timeline: 'Timeline',
    preview: 'Preview',
    engine: 'Engine',
    project: 'Project',
    noProject: 'No project opened',
    newProject: 'New project',
    openProject: 'Open project',
    saveProject: 'Save project',
    saveAs: 'Save as',
    projectPath: 'Project path',
    recentUnavailable: 'Recent projects are not exposed by a Host route yet.',
    loading: 'Loading…',
    retry: 'Retry',
    dismiss: 'Dismiss',
    noMedia: 'No media imported.',
    noTracks: 'No tracks yet.',
    selectClip: 'Select a clip',
    selected: 'Selected',
    frame: 'Frame',
    previousFrame: 'Previous frame',
    nextFrame: 'Next frame',
    moveLeft: 'Move left',
    moveRight: 'Move right',
    undo: 'Undo',
    redo: 'Redo',
    refresh: 'Refresh',
    unavailable: 'Engine unavailable',
    tracks: 'tracks',
    clips: 'clips',
    duration: 'Duration',
    status: 'Status',
    locale: 'Language',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
    clip: 'Clip',
    track: 'Track',
    start: 'Start',
    engineReady: 'Connected',
    engineDown: 'Not connected',
    importMedia: 'Import media',
    mediaCount: '{count} items',
    projectVersion: 'Version {version}',
    busy: 'Working…',
    allChanges: 'All changes are engine-backed.',
    prototypeNotice: 'Bounded native mount: home, media, timeline and preview. The full editor remains in the iframe fallback.',
  }),
  zh: Object.freeze({
    appName: 'OpenTake',
    nativePreview: '原生编辑器原型',
    home: '主页',
    editor: '编辑器',
    media: '素材',
    timeline: '时间线',
    preview: '预览',
    engine: '引擎',
    project: '项目',
    noProject: '尚未打开项目',
    newProject: '新建项目',
    openProject: '打开项目',
    saveProject: '保存项目',
    saveAs: '另存为',
    projectPath: '项目路径',
    recentUnavailable: 'Host 尚未提供最近项目路由。',
    loading: '加载中…',
    retry: '重试',
    dismiss: '关闭',
    noMedia: '尚未导入素材。',
    noTracks: '暂无轨道。',
    selectClip: '选择一个片段',
    selected: '已选中',
    frame: '帧',
    previousFrame: '上一帧',
    nextFrame: '下一帧',
    moveLeft: '左移',
    moveRight: '右移',
    undo: '撤销',
    redo: '重做',
    refresh: '刷新',
    unavailable: '引擎不可用',
    tracks: '条轨道',
    clips: '个片段',
    duration: '时长',
    status: '状态',
    locale: '语言',
    theme: '主题',
    light: '浅色',
    dark: '深色',
    system: '跟随系统',
    clip: '片段',
    track: '轨道',
    start: '起点',
    engineReady: '已连接',
    engineDown: '未连接',
    importMedia: '导入素材',
    mediaCount: '{count} 个素材',
    projectVersion: '版本 {version}',
    busy: '处理中…',
    allChanges: '所有改动均由引擎持久化。',
    prototypeNotice: '有界的原生挂载：主页、素材、时间线和预览。完整编辑器仍保留在 iframe 回退中。',
  }),
});

/** Map a DSH locale tag to one of the native shell's dictionaries. */
export function normalizeLocale(locale) {
  return typeof locale === 'string' && /^zh(?:-|$)/i.test(locale) ? 'zh' : 'en';
}

/**
 * Create a pure translator. `t` replaces `{name}` placeholders; missing keys
 * fall back to English and then to the key itself, so a missing translation
 * never blanks the UI.
 */
export function createTranslator(locale = 'en') {
  const code = normalizeLocale(locale);
  const dict = TRANSLATIONS[code];
  const fallback = TRANSLATIONS.en;
  function t(key, values = undefined) {
    const template = dict[key] ?? fallback[key] ?? key;
    if (values === null || values === undefined) return template;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    ));
  }
  return { locale: code, t };
}
