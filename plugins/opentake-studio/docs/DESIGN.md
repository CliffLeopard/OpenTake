# OpenTake Studio — DSH 原生编辑器插件设计（开发契约）

状态：实现中 · 分支 `feat/dsh-native-studio` · 目标包 `plugins/opentake-studio/`

本文是并行开发的唯一接口契约。实现、测试、文档都以本文为准；改契约先改本文并通知所有写者。

## 1. 目标与非目标

目标：把 OpenTake 的视频编辑能力改造成**纯 DeepSeek Harness 插件**。插件自身是 Cordis bundle：

- Host 半在 DSH Host 进程里跑 Node：工程/时间线模型、媒体探测与导入、预览媒体流、ffmpeg 导出、原生 Agent 工具。
- Client 半是 DSH Web UI 里的编辑器页面：媒体库、预览画布、时间线、检查器、工具栏，所有操作都在 DSH 内完成。
- **不启动 OpenTake/Tauri 进程，不经过 MCP，不依赖任何 OpenTake 已有二进制。**

非目标（本版）：
- 不追求与 Rust/Tauri 版 100% 功能对齐。首版交付可验证的剪辑闭环：建工程、导入媒体、时间线编辑、预览播放、撤销/重做、基础导出、Agent 工具。
- 不实现转场、关键帧动画、Lottie/Motion、AI 生成、whisper 转写、语义搜索、复杂调色。它们作为后续里程碑，UI 保留扩展位或明确置灰。
- 不引入前端构建链：`client.js` 是手写浏览器 bundle（`window.__ModuleLoader__.load` 格式），只 `require('react')`。
- Host 依赖系统 `ffmpeg` / `ffprobe`（PATH 或环境变量 `OPENTAKE_STUDIO_FFMPEG` / `OPENTAKE_STUDIO_FFPROBE`）；缺失时 UI 明确报不可用，不伪装成功。

## 2. 目录与写者边界

| 文件 | 写者 | 说明 |
|---|---|---|
| `package.json`, `cordis.patch.yml`, `icon.svg`, `locale/*.json`, `README.md`, `docs/DESIGN.md` | Lead | 清单、展示元数据、文档 |
| `lib/model.js`, `test/model.test.mjs` | model-dev | 纯时间线模型与操作 |
| `lib/media.js`, `lib/export.js`, `test/media.test.mjs`, `test/export.test.mjs` | media-dev | ffprobe/ffmpeg、导入、缩略图、导出 |
| `index.js` | Lead | Host 入口：工程服务、路由、工具、生命周期 |
| `client.js` | editor-ui | 完整编辑器 UI（单文件浏览器 bundle） |
| docs-writer / verifier | 后续 | README、集成文档、独立测试与审查 |

不要跨写。需要改契约先通知 Lead。

## 3. 数据模型（`lib/model.js`）

```js
Project = {
  version: 1,
  name: string,
  fps: number,          // 默认 30；只允许 24/25/30/50/60
  width: number,        // 默认 1920
  height: number,       // 默认 1080
  createdAt: number,
  updatedAt: number,
  media: Media[],
  tracks: Track[],
}

Media = {
  id: string,
  name: string,
  kind: 'video' | 'audio' | 'image',
  fileName: string,     // 相对 <projectRoot>/media/ 的文件名
  durationFrames: number, // 以 project.fps 计；图片为 null
  sourceDurationSeconds: number | null,
  width: number | null,
  height: number | null,
  hasAudio: boolean,
  sizeBytes: number,
  importedAt: number,
}

Track = {
  id: string,
  type: 'video' | 'audio',
  name: string,
  muted: boolean,
  hidden: boolean,
  clips: Clip[],        // 按 startFrame 升序
}

Clip = {
  id: string,
  type: 'video' | 'image' | 'audio' | 'text',
  mediaId: string | null,     // text 为 null
  startFrame: number,         // timeline 帧，>=0
  durationFrames: number,     // >=1
  trimStartFrame: number,     // 源媒体帧偏移，>=0（text 恒 0）
  speed: 1,                   // 本版固定 1
  volume: number,             // 0..1
  opacity: number,            // 0..1
  transform: { x: number, y: number, width: number, height: number, rotation: number },
  // x/y/width/height 为 0..1 归一化，x/y 是左上角；rotation 为角度
  text: null | { content: string, fontSize: number, color: string, fontWeight: '400'|'600'|'700', align: 'left'|'center'|'right' },
}
```

不变量：
- 同一 track 内 clips 不重叠（applyOperation 负责裁剪/拆分/删除旧 clip）。
- `startFrame + durationFrames` 不超过任何上限；媒体 clip 的 `trimStartFrame + durationFrames` 不超过媒体时长（图片除外）。
- 所有 id 由调用方传入（服务用 `crypto.randomUUID()`）；model 不生成随机数。
- `updatedAt` 由 model 在变更时设为 `Date.now()`。

导出 `lib/model.js`：
- `createProject({ name?, fps?, width?, height? })` → 新 Project（含默认 video/audio 两条空轨？本版**不预建轨道**，首次导入/添加时按需建）。
- `normalizeProject(value)` → 校验/迁移/填默认；坏数据抛 `ModelError`。
- `cloneProject(project)`
- `timelineDurationFrames(project)` → 最大 `startFrame+durationFrames`，空工程为 0。
- `findMedia(project, mediaId)`, `findTrack(project, trackId)`, `findClip(project, clipId)`（返回 `{ track, clip }` 或 null）。
- `applyOperation(project, operation)` → **新 Project**（深拷贝变更），非法操作抛 `ModelError`。
- `ModelError`（带 `code`）。

操作（`operation = { type, ... }`）：
- `add-track { trackId, trackType, name? }`
- `remove-track { trackId }`
- `add-media { media }`
- `remove-media { mediaId }`（同时删除引用它的 clips）
- `add-clip { clipId, mediaId, trackId, startFrame, durationFrames?, trimStartFrame? }`（duration 默认媒体剩余时长；按重叠规则处理同轨旧 clips）
- `move-clip { clipId, trackId?, startFrame }`
- `trim-clip { clipId, durationFrames?, trimStartFrame? }`
- `split-clip { clipId, atFrame }`（atFrame 为项目帧，必须严格在 clip 内部；生成两个新 clipId，由操作传入 `leftClipId`,`rightClipId`）
- `remove-clips { clipIds }`
- `set-clip-properties { clipIds, volume?, opacity?, transform? }`（transform 部分合并）
- `add-text { clipId, trackId?, startFrame, durationFrames, text, transform? }`（没有合适 video track 时自动建一条）
- `update-text { clipId, content?, fontSize?, color?, fontWeight?, align? }`
- `reorder-tracks { trackId, toIndex }`

重叠规则（同 track）：
- 新区间 `[s,e)` 覆盖旧 clip 全部 → 删除旧 clip。
- 旧 clip 右侧越界：`old.start >= s` 且 `old.end <= e` → 删除。
- 左侧重叠：`old.start < s < old.end` → old.duration = s - old.start。
- 右侧重叠：`old.start < e < old.end` → old.trimStart += e - old.start；old.start = e；old.duration -= 裁剪量。
- 新区间完全在旧 clip 内 → 把旧 clip 拆成左右两段（keep 旧 id 作左段，新 id 由操作传入 `splitRightClipId`）。
- 视觉/音频规则相同。

时间工具：`secondsToFrames`, `framesToSeconds`, `snapFrame`（可选）。

## 4. 媒体（`lib/media.js`）

工程目录结构（由 `lib/project.js` 管理）：

```
<projectRoot>/
  opentake-studio.json      # Project JSON
  media/                    # 导入后的媒体文件
  thumbnails/               # <mediaId>.jpg
  exports/                  # 默认导出目录
```

导出 `lib/media.js`：
- `resolveTools()` → `{ ffmpeg, ffprobe, available, version }`（检查 env 与 PATH；缓存结果）。
- `probeMedia(filePath)` → `{ kind, durationSeconds, width, height, fps, hasAudio, sizeBytes }`（ffprobe JSON；视频/音频/图片）。
- `mediaExtensions()` / `isMediaFile(name)`。
- `scanMediaFolder(folderPath)` → 递归文件路径列表（跳过隐藏目录、media/thumbnails/exports）。
- `importToProject({ projectRoot, folderPath, project })` → `{ media: Media[], imported: string[], skipped: string[] }`：
  - 为每个媒体文件生成 `id`、复制/硬链接到 `<root>/media/<id>-<safeName>`（优先 `link`，`EXDEV` 时 `copyFile`）；
  - probe；生成 `Media`（durationFrames 按 project.fps 四舍五入）；
  - 重复导入同一源路径/文件名+size 时跳过（服务层用 source path 去重，media 里不存源路径；MVP 按目标文件名不存在判断）。
  - 返回的 Media 由调用方用 `add-media` 操作加入 project。
- `ensureThumbnail({ projectRoot, media, atFrame? })` → 返回 JPEG 绝对路径；视频取 `min(1s, duration/2)`，图片直接缩放；缓存存在则复用。
- `mediaFilePath(projectRoot, media)` → `<root>/media/<fileName>`（校验 resolve 后仍在 media 目录内；非法抛错）。
- `mediaMimeType(fileName)`。
- `runFfmpeg(args, { onProgress?, signal? })` / `runFfprobe(args)` 基础封装（`node:child_process`，无 shell）。
- `resetToolCache()`（测试用）。

## 5. 导出（`lib/export.js`）

- `buildExportArgs({ project, projectRoot, outputPath })` → `{ args: string[], durationFrames: number }`（纯函数，便于测试）。
- `runExport({ project, projectRoot, outputPath, onProgress, signal })` → Promise，`onProgress(0..1)`。
- 算法（首版）：
  - 输入 0：`-f lavfi -i color=c=black:s=<w>x<h>:r=<fps>:d=<timelineSeconds>` 作为底。
  - 每个视觉 clip（video/image/text）按轨道顺序叠加：
    - video：`-ss <trimStart/fps> -t <sourceSeconds> -i <file>`；`scale=w:h`、`setpts=PTS-STARTPTS+<startSec>/TB`；overlay `x=...:y=...:enable='between(t,<startSec>,<endSec>)'`。
    - image：`-loop 1 -t <durationSeconds> -i <file>`，其余同上。
    - text：优先使用浏览器预渲染的透明 PNG `<root>/renders/<clipId>.png`（见 §8），作为图片输入按 transform 框 overlay；没有 PNG 时回退到 `drawtext`（fontfile 自动探测 macOS/Linux/Windows，`enable='between(t,...)'`，按 transform 定位，内容转义）。这使没有 libfreetype/drawtext 的 ffmpeg 也能导出文本。
    - opacity：用 `format=rgba,colorchannelmixer=aa=<opacity>` 或 `geq`；MVP 可用 `format=rgba,colorchannelmixer=aa=...`。
  - 音频：每个 `type=audio` 的 clip，以及每个 `media.hasAudio=true` 的 video clip 的源音频：
    - 复用该 clip 已加载的输入（audio clip 单独输入；video clip 用它的 `[i:a]`）→ `atrim=...,asetpts=PTS-STARTPTS,volume=<v>,adelay=<startMs>|<startMs>[aN]`；
    - 全部 `amix=inputs=N:normalize=0`，再 aresample/aac。
  - 音频时间窗与视频一致：`startSec = startFrame/fps`，`sourceStartSec = trimStartFrame/fps`，`durationSec = durationFrames/fps`。
  - 视频编码：`-c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 20 -movflags +faststart`；音频 `-c:a aac -b:a 192k`；`-t <durationSeconds>`。
  - 无视觉 clip 时输出黑底 + 音频；无音频时 `-an`。
  - `-progress pipe:1 -nostats` 解析 `out_time_us/out_time_ms` 计算进度。
  - 失败返回 stderr 末尾（截断、脱敏路径可保留）。

限制（文档必须写）：无转场/关键帧/特效/速度变化；文本导出依赖系统字体；video clip 的源音频按整段导出（不单独做音频裁剪之外的混音自动化）。

## 6. 工程存储（`lib/project.js`，Lead）

- `projectPaths(root)` → `{ root, projectFile, mediaDir, thumbDir, exportsDir, name }`
- `createProjectAt(root, { name, fps, width, height })` → `{ project, paths }`（目录不存在则 mkdir -p；已存在 project file 抛 `project-exists`）
- `openProjectAt(root)` → `{ project, paths }`（读 JSON + normalize；不存在抛 `project-not-found`）
- `saveProjectAt(root, project)` → 原子写（`tmp` + rename），返回 paths
- `projectRootExists` / `ensurePaths`
- 所有路径必须 `path.resolve` 后校验在目标目录内（media 文件读取用 media.js 的校验）。

## 7. Host 插件（`index.js`）

### 7.1 导出

```js
export const name = 'opentake-studio'
export const inject = ['tools', 'webServer', 'connection']
export function apply(ctx) { ... }
```

无 `Config`。不因 ffmpeg 缺失或未开工程而抛错；状态里报告。

### 7.2 状态

```ts
type StateResponse = {
  version: 1,
  project: Project | null,
  projectRoot: string | null,
  ffmpeg: { available: boolean, ffmpeg: string | null, ffprobe: string | null, version: string | null },
  export: { state: 'idle'|'running'|'done'|'error', progress: number, output: string | null, error: string | null },
  canUndo: boolean,
  canRedo: boolean,
}
```

- 未打开工程：`project=null`。
- 服务内部：`active = { root, paths, project, undo: Project[], redo: Project[] }`。
- 每次变更后自动保存（原子写）；`undo`/`redo` 也保存。
- 撤销栈最多 100。

### 7.3 路由（全部先过 `connection.requestRejection`，fail-closed）

单一 prefix 路由 `/opentake-studio`，在 handler 内按 pathname 分发；JSON body 上限 1 MiB（上传除外）。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/opentake-studio/state` | — | StateResponse |
| POST | `/opentake-studio/project/new` | `{ path, name?, fps?, width?, height? }` | StateResponse；错误 400 + `{error:{code,message}}` |
| POST | `/opentake-studio/project/open` | `{ path }` | StateResponse |
| POST | `/opentake-studio/project/save` | — | StateResponse |
| POST | `/opentake-studio/media/import` | `{ path }`（文件夹） | StateResponse |
| POST | `/opentake-studio/media/upload?name=<encoded>` | raw bytes body | StateResponse（可选实现，最大 2 GiB） |
| GET | `/opentake-studio/media/file/<mediaId>` | Range 支持 | 206/200 字节流 |
| GET | `/opentake-studio/media/thumb/<mediaId>` | — | JPEG |
| POST | `/opentake-studio/edit` | `{ operations: Operation[] }` | StateResponse（原子：全部成功才提交） |
| POST | `/opentake-studio/undo` / `/redo` | — | StateResponse |
| POST | `/opentake-studio/text/render` | `{ clipId, dataUrl }`（base64 PNG ≤8 MiB） | `{ ok: true }` |
| POST | `/opentake-studio/export` | `{ path? }` | StateResponse（启动异步；202/200） |
| GET | `/opentake-studio/export/status` | — | StateResponse |
| POST | `/opentake-studio/export/cancel` | — | StateResponse |

错误 code：`no-project`、`project-exists`、`project-not-found`、`invalid-input`、`invalid-project`、`ffmpeg-unavailable`、`export-running`、`output-exists`、`model-error`、`media-error`、`io-error`。

### 7.4 Agent 工具（原生 `ctx.tools.register`，无 MCP）

工具名与参数（描述里写清帧/秒口径）：

- `opentake_studio_get_state` — 返回工程摘要（fps/分辨率/总帧数/tracks/clips/media）。
- `opentake_studio_list_media` — 返回媒体列表。
- `opentake_studio_new_project` `{ path, name?, fps?, width?, height? }`
- `opentake_studio_open_project` `{ path }`
- `opentake_studio_import_media` `{ path }`（文件夹；返回导入数量/名称）
- `opentake_studio_list_media` — 返回媒体列表。
- `opentake_studio_add_clip` `{ mediaId, startFrame, trackId?, durationFrames?, trimStartFrame? }`
- `opentake_studio_move_clip` `{ clipId, startFrame, trackId? }`
- `opentake_studio_trim_clip` `{ clipId, durationFrames?, trimStartFrame? }`
- `opentake_studio_split_clip` `{ clipId, atFrame }`
- `opentake_studio_remove_clips` `{ clipIds }`
- `opentake_studio_set_clip_properties` `{ clipIds, volume?, opacity?, transform? }`
- `opentake_studio_add_text` `{ content, startFrame, durationFrames, trackId?, fontSize?, color?, x?, y? }`
- `opentake_studio_undo` / `opentake_studio_redo`
- `opentake_studio_export` `{ path?, overwrite? }`（异步启动，返回输出路径/进度提示；已存在输出默认拒绝，`overwrite:true` 才覆盖）

工具与 UI 操作走**同一个服务函数**（不要两套逻辑）。返回文本要简洁、可供模型继续操作（含新 clipId/trackId/总帧数）。

## 8. Client 编辑器（`client.js`）

- 注册 `main` key `opentake-studio` 与 `sidebar.panellist` id `opentake-studio`（order 15），左栏显示 “OpenTake Studio”；可选地也注册 `settings.section`（展示键位与依赖说明）。
- 只 `require('react')`；无 JSX；一个 `<style>` 通过 `ctx.effect` 注入，`.ots-` 前缀，chrome 只用 `--dsw-alias-*` token。
- 数据：`GET opentake-studio/state` 每 1000ms 轮询（页面隐藏时暂停），每次编辑动作后立即刷新。
- 目录选择：`ctx.remote.directoryPicker.pick(signal)`（无该命名空间时回退到文本输入路径 + 提示）。打开/新建工程、导入媒体文件夹、选择导出目录都用它。
- 页面布局（单页全高）：
  1. 顶栏：工程名/路径、打开/新建、保存、撤销/重做、导出、ffmpeg 状态。
  2. 左栏媒体库：缩略图网格/列表，显示名称/时长/kind；导入文件夹；拖拽到时间线；双击追加到当前轨道。
  3. 中栏预览：16:9 画布（项目分辨率等比），黑色底；播放/暂停、当前帧/总帧/时间码、音量、循环；用 Canvas 合成当前帧。
  4. 右栏检查器：选中 clip 的属性（音量、不透明度、位置/大小/旋转；text 的文案/字号/颜色/对齐）；无选中时显示工程设置（分辨率/fps 只读或可改）。
  5. 底栏时间线：帧标尺、播放头、轨道（视频/音频）、clip 块；水平缩放/滚动；拖拽移动 clip、拖拽两端 trim、点击选中、双击播放头定位；删除键删除选中；Split 按钮在播放头分割。
- 预览播放：
  - 每个媒体建隐藏 `<video>`/`<audio>` 元素，src = `/opentake-studio/media/file/<id>`；视频元素 `muted=true` 只用于取帧绘制，音频用 `<audio>` 播放 active audio/video clip 的声音（按 clip volume）。
  - rAF 时钟驱动 currentFrame；每帧绘制 active visual clips（video/image/text），按 track 顺序，应用 transform/opacity；到总时长停止。
  - 播放时同步各 active clip 的媒体 `currentTime = (trimStartFrame + frame - startFrame)/fps`；seek 时 likewise。
  - 预览不追求与导出逐帧一致；文档说明预览是近似合成。
- 时间线交互至少：选择、移动（拖拽，吸附到整帧）、trim（左右手柄）、拆分、删除、撤销/重做、缩放、播放头定位。
- 媒体导入后默认：无选中轨道时自动建 video/audio 轨（视频放 video、音频放 audio），从 0 帧开始；冲突按服务端模型规则裁剪/拆分。
- 导出文本：点击导出（打开导出对话框的路径）时，先收集所有 `type=text` clip，按 transform 框尺寸在离屏 canvas 上以透明背景渲染文本，`toDataURL('image/png')` 后逐个 `POST /opentake-studio/text/render {clipId,dataUrl}`，再 `POST /export`；渲染失败则显示错误且不导出。
- 所有用户可见文案走 en/zh locale 字典；错误就地显示（`role="alert"`），加载/导出进度 `aria-live`。
- 未实现功能（转场/关键帧/特效/生成等）不要放可点击的假按钮；可在 UI 中明确标注“后续版本”。

## 9. 测试与验收

- `node --check` 所有 JS；`node --test plugins/opentake-studio/test/` 全绿（当前 241 项）。
- model 测试：建工程、add/move/trim/split/remove、重叠裁剪/拆分、撤销快照服务（服务层测试可选）。
- media 测试：生成测试媒体（ffmpeg `testsrc`/`sine`）在临时目录，probe/import/thumb。
- export 测试：`buildExportArgs` 断言 filter graph，真实 ffmpeg 导出 2 秒 MP4 并用 ffprobe 校验时长/流。
- Host 集成：临时 fake ctx + 临时工程目录，走路由/工具完成：新建工程 → 导入生成媒体 → add clip → split → export → 校验文件。
- 安装：`plugin_manager install_bundle plugins/opentake-studio` → applied；Client Slots 显示 `main`/`sidebar.panellist`；左栏 OpenTake Studio 面板渲染；无 MCP 依赖。
- GUI：用真实 DSH 页面截图验收编辑器面板；交互（拖拽等）尽量用 CDP 或人工确认，未验证项明确记录。

## 10. 里程碑

1. Host 模型 + 工程存储 + 媒体导入 + 路由 + 工具（Lead/model-dev/media-dev）。
2. Client 编辑器 UI（editor-ui）。
3. 导出（media-dev）+ 集成测试。
4. 安装、E2E、截图、文档。

## 11. Phase 1 扩展契约（完整复刻路线 A，已实现）

路线 A（纯 TS/JS）下，下一阶段扩展以下数据与行为。实现顺序：model → export → UI → Host 路由/工具 → 测试。

### 11.1 Project/Clip 新字段

```js
Project.markers = [{ id, frame, label, color }]        // 时间线标记，默认 []
Project.transitions = [Transition]                      // 相邻片段转场，默认 []

Clip.speed = 1                 // 0.25..4；video/audio 有效，image/text 必须 1
Clip.fadeInFrames = 0          // 视觉 fade from black / 音频 fade in，0..durationFrames
Clip.fadeOutFrames = 0
Clip.keyframes = {             // 每个属性独立，默认 {}；frame 为 clip 内相对帧，升序不重复
  volume: Keyframe[], opacity: Keyframe[],
  x: Keyframe[], y: Keyframe[], width: Keyframe[], height: Keyframe[], rotation: Keyframe[],
}
Clip.effects = Effect[]        // 有序，默认 []

Keyframe = { frame: number, value: number, easing: 'linear'|'ease-in'|'ease-out'|'ease-in-out' }
Effect = {
  id: string,
  type: 'brightness'|'contrast'|'saturation'|'temperature'|'blur'|'sharpen'|'chromaKey'|'lut',
  enabled: boolean,
  params: object,              // 按 type 校验：
  // brightness/contrast/saturation: { amount: 0..2, 默认 1 }
  // temperature: { amount: -1..1, 默认 0 }
  // blur: { radius: 0..30, 默认 0 }
  // sharpen: { amount: 0..2, 默认 0 }
  // chromaKey: { keyColor:'#rrggbb', similarity:0.01..0.5, blend:0..0.5 }
  // lut: { file: string }      // 相对 <projectRoot>/luts/ 的 .cube 文件
}

Transition = {
  id: string,
  trackId: string,
  fromClipId: string,
  toClipId: string,
  type: 'dissolve'|'fadeToBlack'|'wipeLeft'|'wipeRight',
  durationFrames: number,      // >=1，且 <= 两侧片段时长
}
```

- 速度语义：`durationFrames` 始终是**时间线时长**；源消耗 = `durationFrames * speed`。
  设置 speed 时用 `durationFrames = round(durationFrames * oldSpeed / newSpeed)` 保持源区间不变；
  校验 `trimStartFrame + durationFrames*speed <= media.durationFrames`。
- 预览/导出时间映射：源时间 = `(trimStartFrame + (frame-startFrame)*speed) / fps`。
- keyframe 相对 clip 起点；`evaluateKeyframes(list, frame, fallback)` 在 [0,durationFrames] 内插值，无 keyframe 时用属性静态值。
- 同属性 keyframe 覆盖静态值；`set-clip-properties` 只改静态值，不改 keyframe。
- 转场只允许同一 video track 上首尾相邻（`a.start+a.duration == b.start`）的两个非 text clip；
  `durationFrames` 从 `fromClip` 末尾与 `toClip` 开头各取一半（四舍五入），总时长不超过两者较短者。
- 标记不参与导出。

### 11.2 新 model 操作

- `set-speed { clipId, speed }`
- `set-keyframes { clipId, property, keyframes }`（替换；空数组清除）
- `add-effect { clipId, effect }`
- `update-effect { clipId, effectId, patch }`
- `remove-effect { clipId, effectId }`
- `reorder-effects { clipId, effectIds }`
- `set-fades { clipId, fadeInFrames?, fadeOutFrames? }`
- `add-marker { marker }` / `update-marker { markerId, frame?, label?, color? }` / `remove-marker { markerId }`
- `add-transition { transition }` / `update-transition { transitionId, type?, durationFrames? }` / `remove-transition { transitionId }`
- `add-caption { clipId, trackId?, startFrame, durationFrames, segments, style? }`
  - Caption 以 `type:'caption'` 的 clip 存储；`caption = { segments: [{ startFrame, durationFrames, text }], style: {fontSize,color,fontWeight,align,background?} }`
  - segments 的帧相对 caption clip；覆盖整个 clip 时长，允许空档。
- `update-caption { clipId, segments?, style? }`

### 11.3 导出扩展（media-dev）

- speed：视频 `setpts=(PTS-STARTPTS)/speed`；音频用 `atempo` 链（每级 0.5..2）。
- fades：视频 `fade=t=in/out:st=...:d=...`；音频 `afade`。
- keyframes：volume 用 `volume=eval=frame:'expr'`；opacity 用 `fade` 近似或 `colorchannelmixer` 表达式受限；x/y 用 overlay 的 `x/y` 表达式；width/height/rotation 的 keyframe 导出标记为不支持（文档化）。
- effects：按 clip.effects 顺序生成 filter 链（eq、colorbalance、gblur、unsharp、chromakey、lut3d）；LUT 从 `<projectRoot>/luts/<file>` 读取。
- 转场：`dissolve` 用两侧片段 alpha/fade 近似或 xfade（若实现）；`fadeToBlack` 用 fade。先实现 `fadeToBlack`，`dissolve` 待定。
- 字幕：caption clip 按 segments 生成文本/PNG 叠加；SRT/VTT 导入导出走 Host 路由 `POST /captions/import`、`GET /captions/export.srt|.vtt`。

### 11.4 UI 扩展（editor-ui）

- 检查器：速度滑块（0.25–4）；fade in/out；keyframe 编辑（在播放头为 volume/opacity/x/y/width/height/rotation 添加/删除 keyframe，列表显示）；
- 效果面板：添加/删除/启用/排序 brightness/contrast/saturation/temperature/blur/sharpen/chromaKey/lut；
- 转场：在相邻片段边界添加/删除 dissolve/fadeToBlack/wipe，时长编辑；
- 字幕面板：创建/编辑 caption segments、导入 SRT/VTT、导出 SRT/VTT；
- 时间线：标记添加/删除/跳转；多选、复制/粘贴、ripple delete；吸附；
- Agent 工具同步暴露上述操作（Host）。

### 11.5 验收

- model 单测覆盖新字段/操作/不变量；
- export 测试覆盖 speed/fades/effects/（可实现的）keyframe/transition；
- Host 测试覆盖新路由/工具；
- UI 截图 + 交互验证；
- 文档更新。

## 12. Phase 7 扩展契约：遮罩、混合模式、轨道音量

### 12.1 字段

```js
Clip.mask = null | {
  shape: 'rect' | 'ellipse',
  x: number, y: number, width: number, height: number, // 0..1，相对 clip 的 transform 框，x+w<=1
  feather: number,   // 0..1，默认 0；矩形边缘/椭圆边缘的羽化比例
  invert: boolean,   // 默认 false
}
Clip.blendMode = 'normal'|'screen'|'multiply'|'overlay'|'darken'|'lighten'|'add'|'difference'
Track.volume = 1     // 0..2，默认 1；与 clip.volume、clip 音量关键帧相乘
```

- `mask` 在 clip 的 transform 框内应用（先 crop/scale，再 mask，再 overlay）。
- `mask` 支持 video/image/text/caption；drawtext 回退无法应用 mask，浏览器 PNG 可以。
- `blendMode` 仅在片段覆盖整个项目帧（transform 0,0,1,1，无 rotation/crop/mask）时尝试真实 `blend` 滤镜；其他情况回退普通 overlay（文档化）。
- `Track.volume` 参与所有该轨道音频（audio clip 与 video-clip audio）的最终音量；`muted` 优先级更高。

### 12.2 操作

- `set-mask { clipId, mask: object|null }`
- `set-blend-mode { clipId, blendMode }`
- `update-track` 增加可选 `volume`（0..2）；已有 name/muted/hidden。

### 12.3 导出/预览

- mask：在缩放后的 RGBA 层上用 `geq` 的 alpha 表达式实现矩形/椭圆+feather；`invert` 反转 alpha。
- blend：全帧+无变换的片段的合成层用 `blend=all_mode=<mode>`；其余回退 `overlay`。
- 轨道音量：音频链在 clip 音量之后乘 `track.volume`；预览音频同样乘。
- 预览：Canvas clip path（rect/ellipse，feather 用 shadow/gradient 或近似）；blend 用 Canvas `globalCompositeOperation` 近似。

### 12.4 验收

- model 单测：默认值、mask 校验、blend 枚举、track volume、trim/split/move 保留、purity。
- export 测试：mask alpha 滤镜、blend 全帧与回退、track volume 音频链；真实导出/像素抽样。
- Host 测试：新操作/工具/状态字段。
- UI：检查器 mask/blend 控件、轨道音量滑块；截图验证。
