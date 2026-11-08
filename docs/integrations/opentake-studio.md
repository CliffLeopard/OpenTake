# OpenTake Studio：DSH 原生编辑器集成

> 状态：MVP / 实验性 · 插件版本 `0.1.0` · 分支 `feat/dsh-native-studio` · 验证日期 2026-11-08
> 插件说明：[plugins/opentake-studio/README.md](../../plugins/opentake-studio/README.md) · 设计契约：[docs/DESIGN.md](../../plugins/opentake-studio/docs/DESIGN.md)

本页说明仓库中的 **OpenTake Studio** 插件如何集成到 DeepSeek Harness（DSH）：它为什么采用 DSH 原生实现、Host 与 Client 如何分工、对 DSH 暴露什么契约、如何验证，以及它与 OpenTake 主线（Rust + Tauri 桌面应用）的边界。

## 定位：为什么另做一个 DSH 原生实现

OpenTake 主线是 Rust + Tauri 2 的跨平台桌面应用，Agent 通过 MCP 操作编辑器。本分支验证另一条路径：把最小视频编辑闭环做成**纯 DSH 插件**（Cordis bundle），让编辑器直接运行在 DSH 的 Host 进程和 Web UI 里。

- **没有 OpenTake/Tauri 进程。** Host 半在 DSH Host 的 Node 运行时中执行，Client 半是 DSH Web UI 的一个 Slot 页面。
- **没有 MCP server。** Agent 工具通过 DSH 原生工具注册表注册，和 UI 调用同一套服务函数，不产生第二个网络端口、令牌或配对流程。
- **没有独立安装包。** 插件随 DSH profile 安装；视频编辑能力以 DSH 已有 Web 会话为信任边界。
- **代价是功能范围小。** 本版只交付可验证的剪辑闭环，不追求与 Rust/Tauri 版功能对齐；明确缺口见[限制](#限制与后续)。

因此它是**集成到 DSH 的实验性编辑器**，不是 OpenTake 桌面应用的新发行版，也不替代主线的 MCP/Agent 能力。

## 总体架构

| 层 | 位置 | 职责 |
|---|---|---|
| Host 半 | `plugins/opentake-studio/index.js`、`lib/*.js` | 工程/时间线状态、媒体探测与导入、预览媒体流、ffmpeg 导出、Host 路由、原生 Agent 工具、自动保存与撤销栈 |
| Client 半 | `plugins/opentake-studio/client.js` | 单文件浏览器 bundle：媒体库、预览画布、时间线、检查器、对话框、状态条；通过同源路由读取/修改工程 |
| Bundle 元数据 | `package.json`、`cordis.patch.yml`、`locale/*.json` | DSH bundle 声明（`@opentake/studio`，Client 平台 `web`）、profile 插入行、en/zh 界面文案 |

运行时服务依赖：Host 注入 `tools`、`webServer`、`connection`；Client 注入 `slots`、`locale`、`uiWorkspace`。Host 半不依赖第三方 npm 包，Client 半只 `require('react')`，没有前端构建链。

数据流：

```
DSH Web UI (client.js)
   │  fetch 同源路由 /opentake-studio/*
   ▼
DSH Host plugin (index.js)
   │  调用同一套服务函数
   ├── lib/model.js     纯时间线模型 + applyOperation
   ├── lib/project.js   opentake-studio.json 原子读写
   ├── lib/media.js     ffprobe / ffmpeg / 导入 / 缩略图
   └── lib/export.js    buildExportArgs / runExport
   ▲
   └── DSH 原生 Agent 工具（与 UI 共享状态和撤销历史）
```

预览由浏览器侧合成：媒体通过 `/opentake-studio/media/file/<mediaId>`（支持 Range）读取，Client 用隐藏的 `<video>`/`<audio>`/`<img>` 元素驱动 Canvas 2D。导出由 Host 侧异步运行 ffmpeg；文本片段由 Client 先渲染成透明 PNG 并 `POST /text/render` 保存到项目的 `renders/`。

## 接口契约

### 数据模型

`opentake-studio.json` 是版本 `1` 的纯 JSON：

- `Project`：`name`、`fps`（允许 `24/25/30/50/60`，默认 `30`）、`width`/`height`（默认 `1920×1080`）、`createdAt`/`updatedAt`、`media[]`、`tracks[]`。
- `Media`：`id`、`name`、`kind`（`video`/`audio`/`image`）、`fileName`（相对 `media/`）、`durationFrames`（图片为 `null`）、`sourceDurationSeconds`、`width`/`height`、`hasAudio`、`sizeBytes`、`importedAt`。
- `Track`：`id`、`type`（`video`/`audio`）、`name`、`muted`、`hidden`、`clips[]`。
- `Clip`：`id`、`type`（`video`/`image`/`audio`/`text`）、`mediaId`、`startFrame`、`durationFrames`、`trimStartFrame`、`speed`（本版固定 `1`）、`volume`、`opacity`、归一化 `transform`、`text`（仅文本片段）。

所有帧值都是**项目整数帧**：`秒 = 帧 / project.fps`。`startFrame` 是时间线位置，`trimStartFrame` 是源媒体的入点，同样按项目帧计。模型层是纯函数式 `applyOperation(project, operation)`，支持 `add-track`、`remove-track`、`add-media`、`remove-media`、`add-clip`、`move-clip`、`trim-clip`、`split-clip`、`remove-clips`、`set-clip-properties`、`add-text`、`update-text`、`reorder-tracks`。同轨重叠会按契约覆盖、裁剪或拆分旧片段。

### Host 路由

全部挂在同源前缀 `/opentake-studio` 下；每次请求先经过 `connection.requestRejection`，失败即关闭（服务缺失时返回 `503`）。请求体默认上限 1 MiB，上传 2 GiB，文本渲染路由 16 MiB（PNG 本身 ≤ 8 MiB）。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| `GET` | `/opentake-studio/state`（根路径也映射到此） | — | `StateResponse` |
| `POST` | `/opentake-studio/project/new` | `{ path, name?, fps?, width?, height? }` | `StateResponse` |
| `POST` | `/opentake-studio/project/open` | `{ path }` | `StateResponse` |
| `POST` | `/opentake-studio/project/save` | — | `StateResponse` |
| `POST` | `/opentake-studio/media/import` | `{ path }`（绝对文件夹） | `StateResponse` + `imported`/`skipped` |
| `POST` | `/opentake-studio/media/upload?name=<encoded>` | raw bytes | `StateResponse` |
| `GET`/`HEAD` | `/opentake-studio/media/file/<mediaId>` | 支持 `Range` | `200`/`206` 字节流；非法 Range `416` |
| `GET` | `/opentake-studio/media/thumb/<mediaId>` | — | JPEG |
| `POST` | `/opentake-studio/edit` | `{ operations: Operation[] }` | `StateResponse`（原子：全部成功才提交） |
| `POST` | `/opentake-studio/undo` / `/redo` | — | `StateResponse` |
| `POST` | `/opentake-studio/text/render` | `{ clipId, dataUrl }`（base64 PNG） | `{ ok: true }` |
| `POST` | `/opentake-studio/export` | `{ path? }` | `StateResponse`（异步启动） |
| `GET` | `/opentake-studio/export/status` | — | `StateResponse` |
| `POST` | `/opentake-studio/export/cancel` | — | `StateResponse` |
| `POST` | `/opentake-studio/tracks` | `{ type: 'video' \| 'audio' }` | `StateResponse` |

`StateResponse` 包含：`version`、`project`（未打开时为 `null`）、`projectRoot`、`ffmpeg` 可用性/路径/版本、`export`（`state`/`progress`/`output`/`error`）、`canUndo`、`canRedo`、`saveError`、`lastError`、`pluginVersion`。

错误响应的形状是 `{ error: { code, message } }`。稳定 code 包括 `no-project`、`project-exists`、`project-not-found`、`invalid-input`、`invalid-project`、`model-error`、`media-error`、`media-not-found`、`ffmpeg-unavailable`、`export-running`、`not-found`、`internal-error`。常见映射：`project-exists`/`export-running`/`no-project` → `409`，`project-not-found`/`media-not-found` → `404`，`ffmpeg-unavailable` → `503`，输入/模型/媒体错误 → `400`。

### Client 注册

| Slot | key/id | order | 作用 |
|---|---|---|---|
| `main` | `opentake-studio` | — | 完整编辑器页面 |
| `sidebar.panellist` | `opentake-studio` | 15 | 左栏 **OpenTake Studio** 入口 |
| `settings.section` | `opentake-studio` | 25 | 设置页中的依赖/快捷键说明 |

Client 每 1000 ms 轮询一次 `state`（导出中改为 600 ms），页面隐藏时暂停；每次编辑后立即刷新。目录选择优先使用 `uiWorkspace.pickDirectory`，不可用时退化为对话框内输入绝对路径。

### 原生 Agent 工具

| 工具 | 用途 |
|---|---|
| `opentake_studio_get_state` | 读取 fps/分辨率/总帧数/轨道/片段/媒体摘要 |
| `opentake_studio_new_project` / `opentake_studio_open_project` | 按绝对路径新建/打开工程 |
| `opentake_studio_import_media` | 导入文件夹中的媒体 |
| `opentake_studio_add_clip` / `move_clip` / `trim_clip` / `split_clip` / `remove_clips` | 时间线编辑 |
| `opentake_studio_set_clip_properties` | 设置音量、不透明度、归一化 transform |
| `opentake_studio_add_text` | 添加文本覆盖（`startFrame`、`durationFrames`、`x`/`y` 等，帧口径） |
| `opentake_studio_undo` / `redo` | 撤销/重做 |
| `opentake_studio_export` | 异步启动导出，省略 `path` 时写入 `exports/` |

完整参数、默认值和返回说明见 [插件 README 的 Agent 工具参考](../../plugins/opentake-studio/README.md#agent-tools)。工具与 UI 共享同一 Host 服务、同一撤销栈和同一自动保存，不是两套逻辑。

## 安装与端到端验证

### 安装

1. 用 DSH 的 `plugin_manager` 工具安装本地 bundle：action `install_bundle`，target 为本目录绝对路径 `.../plugins/opentake-studio`。
2. 确认 profile 中出现 `@opentake/studio`（`0.1.0`），且 bundle 已启用/active。该包无依赖、无构建脚本，安装时不需要执行 build。
3. 若左栏入口未出现，重新加载 DSH Web UI 一次；如果仍不可见，检查 bundle 是否 applied。

### 验证步骤

1. 打开左栏 **OpenTake Studio**，确认欢迎页和 ffmpeg 状态可见。
2. **New project**：选择一个空文件夹，确认生成 `opentake-studio.json`、`media/`、`thumbnails/`、`exports/`。
3. **Import folder**：导入含视频/音频/图片的文件夹，确认媒体库出现缩略图。
4. 双击或拖拽媒体到时间线，添加文本片段，拖动/裁剪/分割/删除，使用撤销/重做。
5. 播放预览，确认画布显示当前帧画面。
6. **Export**：运行 UI 导出对话框，确认文本 PNG 被上传、MP4 生成且包含文字覆盖。
7. Agent 侧调用 `opentake_studio_get_state`、`add_text`、`remove_clips`、`export`，确认与 UI 状态一致。

### 验证证据（2026-11-08）

测试与已安装 bundle 两项在编写本文时复检；Client/UI/导出证据来自当次验证运行。

| 项目 | 结果 |
|---|---|
| Node 测试 | **299/299 通过**（31 suites，0 failed；含 Phase 1–6 模型/导出/字幕/媒体库/转写/生成/Host 测试）；文档编写时用 `node --test test/` 复跑确认 |
| Bundle 安装 | `@opentake/studio` 已作为本地链接安装、启用并 active |
| Client Slots | `main`、`sidebar.panellist` 均暴露 `opentake-studio`；左栏编辑器面板已截图验收 |
| 预览 | 真实视频帧渲染成功；媒体路由返回 HTTP **Range 206** |
| Host 路由 | 新工程、媒体导入、添加片段、添加文本均通过 Host 路由验证 |
| Agent 工具 | `get_state`、`add_text`、`remove_clips`、`export` 已在运行中调用 |
| UI 导出 | 导出对话框实际运行；文本 PNG 已上传；生成 **1280×720、H.264 + AAC、2.0 s** MP4；导出帧包含文字覆盖 |

### 未验证 / 未声称

- **没有独立签名的桌面应用可验证**：DSH 就是 Host，本插件不产出独立安装包或签名。
- **真实人工拖拽交互**只做了自动化覆盖，未穷尽。
- **完整功能对齐**未实现：转场、关键帧、特效、导出旋转、生成、转写、语义搜索均不在本版范围。

## 限制与后续

本版是 MVP，明确不包含：

- 转场、关键帧、特效、速度变化、调色、多机位、Lottie/Motion。
- AI 生成、whisper 转写、语义搜索、媒体库文件夹/收藏。
- 导出旋转：检查器可旋转、预览会应用，但 ffmpeg 导出路径不旋转画面。
- 文本导出依赖 Client：UI 导出需要浏览器在线渲染 PNG；Agent 直接导出时只在没有 PNG 的情况下回退到 `drawtext`。
- 音频自动化：仅应用片段 `volume`，无淡入淡出、闪避或轨道级效果。
- 单一输出格式：项目分辨率/fps 的 H.264/AAC MP4，无 ProRes/H.265/WebM 预设。
- 单一打开工程和单一运行中导出；UI 不提供轨道删除/重命名/静音/隐藏。
- fps/分辨率创建后固定；撤销栈最多 100 个快照且仅存在于 Host 内存中。

后续里程碑按此顺序扩展即可：更多片段属性与关键帧、音频自动化、转场/特效、导出变体、资源库与生成能力。

## 相关文档

- [插件 README（安装、用户流程、工具参考、故障排查）](../../plugins/opentake-studio/README.md)
- [设计契约（数据模型、路由、导出算法）](../../plugins/opentake-studio/docs/DESIGN.md)
- [文档总目录](../INDEX.md)
- [仓库 README](../../README.md)
