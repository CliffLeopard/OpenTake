# OpenTake Studio：完整功能复刻差距与路线

状态：Phase 1–15 已实现，剩余项见 §3 · 2026-11-08 · 分支 `feat/dsh-native-studio`

当前 `plugins/opentake-studio` 是**纯 DSH 原生编辑器 MVP**（工程、媒体、时间线、预览、文本、基础导出、15 个 Agent 工具），
不是 Rust/Tauri 版 OpenTake 的完整功能复刻。本文是“完整功能”的验收清单与路线，避免把 MVP 当成完成。

## 1. “完整”意味着什么

Rust/Tauri 版包含：

- 10 个 Rust crate（domain / ops / project / render / media / agent / gen / motion / core / process-tree）与
  `src-tauri` 的 30+ 模块：工程、媒体、播放、渲染、导出、转写、视觉检索、生成、Motion、Lottie、账户、
  更新、遥测、外部 MCP、Codex 集成等。
- 完整的 React/TypeScript NLE 前端：媒体库、时间线、预览、检查器、字幕、效果、转场、关键帧、
  多轨合成、设置、账户、素材库、搜索、Agent 对话面板等。
- 平台与打包：macOS/Windows/Linux 安装包、代码签名、更新器、权限、GPU/FFmpeg/Whisper/ONNX 运行时。

“完整功能复刻为 DSH 插件”= 上述**用户可见功能**全部在 DSH 内可用，且有自动化/真实验收。
这不是一个会话能真实完成的工作量；分阶段交付必须明确每阶段验收。

## 2. 当前已经可用（MVP + Phase 1/2）

| 域 | 已实现 |
|---|---|
| 工程 | 新建/打开文件夹工程、JSON 原子保存、自动保存、单工程 |
| 媒体 | 文件夹导入、拖拽上传、ffprobe 探测、缩略图、Range 流 |
| 时间线 | 视频/音频/Text 轨、添加/移动/trim/split/删除、重叠裁剪/拆分、undo/redo |
| 预览 | Canvas 合成、视频/图片/文本、播放/暂停/seek/音量/循环（近似） |
| 检查器 | 音量、不透明度、位置/大小/旋转、文本样式 |
| 导出 | H.264/AAC MP4、异步进度/取消、文本由浏览器 PNG 叠加、单工程单导出 |
| Agent | 41 个原生工具，与 UI 共用服务 |
| 测试 | 382 项（model/project/media/export/captions/library/transcribe/generate/vision/lottie/host） |
| Phase 2 | 真 dissolve/wipe（静态不透明同轨）、静态旋转导出、H.265/ProRes/VP9 预设、轨道静音/隐藏/重命名/删除 |
| Phase 3 | 全局媒体库（搜索/收藏/分类/标签/加入工程） |
| Phase 4–5 | Whisper 兼容转写 + 字幕生成 + 工程检索；OpenAI 兼容图片/语音生成 |
| Phase 6 | 裁剪、ProRes/WebM、H.264/H.265 预设 |
| Phase 7 | 矩形/椭圆遮罩（feather/invert）、8 种混合模式、轨道音量 |
| Phase 8 | 媒体库文件夹/移动 |
| Phase 9 | 轨道角色/ducking（voice 总线 + sidechaincompress）；fal 视频生成；视觉描述索引 |
| Phase 10–12 | UI（文件夹/角色/视频/视觉/代理/relink）；360p 代理；媒体重链接 |
| Phase 13 | ProRes 4444 alpha/透明底、10-bit H.265/VP9、色彩标签；逐帧步进 |
| Phase 14–15 | Lottie JSON/.lottie 容器导入/探测、客户端 lottie-web 预览、逐帧 PNG 预渲染 + ffmpeg 合成导出；vendored MIT 播放器 |
| Phase 16 | 最近工程列表/打开/清除；导出当前帧 PNG |

## 3. 未完成清单（按验收域；Phase 1 项已划掉）

### A. NLE 核心
- ✅ 转场（Phase 2：dissolve/wipe 对静态不透明同轨片段用真正 xfade，其余回退淡入淡出）
- ✅ 关键帧 volume/opacity/x/y（width/height/rotation 预览，导出静态降级）
- ✅ 变速 0.25–4x（视频 setpts / 音频 atempo）
- ✅ 淡入淡出、每片段效果（eq/colorbalance/gblur/unsharp/chromakey/lut3d）
- ✅ SRT/VTT 导入导出、字幕片段编辑；逐词时间轴待 Phase 2
- ✅ 吸附加标记/多选/复制粘贴/波纹删除/快照 undo
- ✅ 旋转静态导出（关键帧旋转降级）
- ✅ 裁剪、矩形/椭圆遮罩、8 种混合模式（全帧）
- ✅ 轨道音量、轨道角色、ducking（sidechaincompress）
- ❌ 画中画高级遮罩、非全帧混合模式、ducking 参数 UI
- ✅ 轨道静音/隐藏/重命名/删除 UI
- ❌ 音频 ducking/增益自动化、独立轨道音量、5.1/采样率策略
- ✅ 代理媒体（预览代理；导出用原片）
- ❌ 帧精确播放/丢帧策略/true HDR/色彩管理
- ✅ SRT/VTT 导入导出、字幕片段编辑（Phase 1）
- ❌ 字幕组批量同步、逐词时间轴
- ❌ 嵌套序列、多工程、分组、滚动编辑

### B. 媒体/AI
- 媒体库全局/跨工程、收藏、文件夹、重链接、代理、波形
- Whisper 转写、逐词时间戳、字幕生成
- SigLIP2 视觉搜索、语音搜索、语义检索
- 生成/超分/配音/换脸/高级 AI 工作流（需要 provider/BYOK 能力）
- 节拍检测、自动卡点、静音/口头禅剪辑、智能重构

### C. Motion/特效
- Lottie/Motion Canvas 渲染与编辑
- 运动图形文档（创建/编辑/预览/发布）
- 调色/LUT、色键、蒙版、效果栈、关键帧效果
- 文字高级排版、字体管理、动画文字

### D. 产品/平台
- 账户、设置、导入导出偏好、快捷键自定义
- 代码签名/安装包/更新器/遥测
- 多语言、可访问性、主题与性能预算
- Windows/Linux 实机验证与 CI
- 大工程性能（千片段、4K、长时线）

## 4. 路线选择（必须先定）

### 路线 A：纯 TS/JS 重写全部功能
- 所有代码在 DSH 插件内，无原生扩展、无外部进程。
- 优点：完全符合“纯插件”；跨平台由 Node/浏览器承担。
- 缺点：等于重写一个 NLE + AI 栈；Whisper/ONNX/GPU/编码器仍需外部依赖或重写；
  与 Rust 版逻辑一致性、性能、开发周期风险最大。**不承诺可在一个会话完成。**

### 路线 B：插件内嵌现有 Rust 引擎（N-API / WASM）+ 迁移现有 React UI
- 把 `opentake-domain/ops/project/render/media/gen/motion/core` 编译成插件自带的 native addon
  （或可行的 WASM 子集），由 DSH Host 进程加载；现有 React 前端通过 Tauri IPC shim 改成插件路由。
- 优点：复用真实编辑逻辑、渲染、转码、AI 接口，最接近“完整功能复刻”；没有独立 OpenTake 进程。
- 缺点：跨平台构建/签名、Electron Node ABI、wgpu/FFmpeg/模型运行时集成、UI shim 工程量大；
  需要新的构建与验收流水线。**推荐作为完整复刻路线。**

### 路线 C：DSH 面板内嵌现有编辑器（iframe/sidecar）
- 插件启动/连接本机 OpenTake 引擎进程，DSH 面板内嵌现有 Web UI。
- 优点：最快获得接近完整的功能。
- 缺点：仍是独立引擎进程，不满足“纯插件/无外部进程”的严格定义；生命周期、权限、打包都更复杂。

## 5. 里程碑（以路线 B 为例）

- **M1 引擎嵌入 spike**：napi-rs 包装 `opentake-core`，Node 内加载；打开/保存工程、get_timeline、
  add/move/trim/split/undo；无 UI 验收 + 崩溃隔离。
- **M2 渲染/预览**：wgpu 离屏渲染接入，动态取帧；替换当前 Canvas 近似预览。
- **M3 前端迁移**：现有 React NLE 以 DSH Client bundle/iframe 接入，Tauri IPC 全部映射为 Host 路由；
  媒体库/时间线/检查器/预览/导出 UI 对齐。
- **M4 媒体/AI**：转写、搜索、生成、Motion 通过现有 Rust 能力接入并做能力门控。
- **M5 平台/打包**：macOS/Windows/Linux native addon 构建、签名、更新、CI。
- **M6 完整验收**：逐项对照 Rust 版功能矩阵，自动化 + 真实桌面验收。

## 6. 结论

当前 MVP 的“架构是纯 DSH 原生”，但“功能完整”尚未达成。要真实完成完整复刻，必须先选择路线；
推荐路线 B（复用 Rust 引擎 + 迁移现有 UI），否则纯 JS 重写将是一个独立的新 NLE，无法保证与 OpenTake 一致。
