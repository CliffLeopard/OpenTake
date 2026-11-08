/**
 * OpenTake Studio — browser half of the native DeepSeek Harness video editor.
 *
 * Single-file, hand-written browser bundle in the DSH `__ModuleLoader__`
 * format. It only requires `react`; every other capability arrives through the
 * injected client services (`slots`, `locale`) and the optional `uiWorkspace`
 * directory picker (read with `ctx.get`), plus the Host
 * routes mounted under `opentake-studio/...`.
 *
 * The page is a conventional NLE: media library on the left, 16:9 canvas
 * preview in the centre, clip inspector on the right and a frame timeline at
 * the bottom. Project, timeline and export state always come from the Host;
 * this file owns interaction state only (playback clock, drag math, drafts).
 */
window.__ModuleLoader__.load({
	id: '@opentake/studio',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;
		const ReactFragment = React.Fragment;

		const NS = 'opentake-studio';
		const PANEL_ID = 'opentake-studio';
		const ROUTE = 'opentake-studio';
		const HEAD_WIDTH = 132;
		const MIN_ZOOM = 0.08;
		const MAX_ZOOM = 24;
		const DEFAULT_ZOOM = 1.6;
		const INSPECTOR_COMMIT_DELAY = 240;

		// -------------------------------------------------------------------
		// Small pure helpers
		// -------------------------------------------------------------------

		function clamp(value, min, max) {
			return Math.min(max, Math.max(min, value));
		}

		function clamp01(value) {
			return clamp(value, 0, 1);
		}

		function finiteNumber(value, fallback) {
			const number = typeof value === 'number' ? value : Number(value);
			return Number.isFinite(number) ? number : fallback;
		}

		function now() {
			return typeof performance !== 'undefined' && typeof performance.now === 'function'
				? performance.now()
				: Date.now();
		}

		function formatTimecode(frame, fps) {
			const rate = Math.max(1, Math.round(fps || 30));
			const total = Math.max(0, Math.round(frame));
			const frames = total % rate;
			const totalSeconds = Math.floor(total / rate);
			const seconds = totalSeconds % 60;
			const minutes = Math.floor(totalSeconds / 60) % 60;
			const hours = Math.floor(totalSeconds / 3600);
			const pad = (number) => String(number).padStart(2, '0');
			if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
			return `${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
		}

		function formatClock(seconds) {
			const safe = Math.max(0, finiteNumber(seconds, 0));
			const minutes = Math.floor(safe / 60);
			const rest = Math.floor(safe % 60);
			return `${minutes}:${String(rest).padStart(2, '0')}`;
		}

		function formatDurationFrames(frames, fps) {
			if (frames === null || frames === undefined) return null;
			return formatClock(frames / Math.max(1, fps || 30));
		}

		function timelineDurationFrames(project) {
			if (!project) return 0;
			let duration = 0;
			for (const track of project.tracks) {
				for (const clip of track.clips) {
					duration = Math.max(duration, clip.startFrame + clip.durationFrames);
				}
			}
			return duration;
		}

		function allClips(project) {
			const rows = [];
			if (!project) return rows;
			for (const track of project.tracks) {
				for (const clip of track.clips) rows.push({ track, clip });
			}
			return rows;
		}

		function findClipEntry(project, clipId) {
			if (!project || !clipId) return null;
			for (const track of project.tracks) {
				for (const clip of track.clips) {
					if (clip.id === clipId) return { track, clip };
				}
			}
			return null;
		}

		function findMedia(project, mediaId) {
			if (!project || !mediaId) return null;
			return project.media.find((media) => media.id === mediaId) || null;
		}

		function clipTrackType(clip) {
			return clip && clip.type === 'audio' ? 'audio' : 'video';
		}

		function activeClipsAt(project, frame) {
			const rows = [];
			if (!project) return rows;
			for (const track of project.tracks) {
				for (const clip of track.clips) {
					if (frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames) {
						rows.push({ track, clip });
					}
				}
			}
			return rows;
		}

		function mediaFileUrl(mediaId) {
			return `${ROUTE}/media/file/${encodeURIComponent(mediaId)}`;
		}

		function mediaProxyUrl(mediaId) {
			return `${ROUTE}/media/proxy/${encodeURIComponent(mediaId)}`;
		}

		function mediaMissingOf(media) {
			return Boolean(media && media.missing === true);
		}

		const lottiePreviewCache = new Map();
		const lottieThumbCache = new Map();
		let lottiePlayerPromise = null;

		function lottieGlobalApi() {
			try {
				if (typeof window !== 'undefined' && (window.lottie || window.bodymovin)) return window.lottie || window.bodymovin;
				if (typeof globalThis !== 'undefined' && globalThis.lottie) return globalThis.lottie;
			} catch (error) {
				/* ignore */
			}
			return null;
		}

		function loadLottiePlayer() {
			const existing = lottieGlobalApi();
			if (existing) return Promise.resolve(existing);
			if (lottiePlayerPromise !== null) return lottiePlayerPromise;
			lottiePlayerPromise = new Promise((resolve, reject) => {
				if (typeof document === 'undefined' || !document.head || typeof document.createElement !== 'function') {
					reject(new Error('lottie-player-unavailable'));
					return;
				}
				const script = document.createElement('script');
				script.src = `${ROUTE}/vendor/lottie.min.js`;
				script.async = true;
				script.onload = () => {
					const api = lottieGlobalApi();
					if (api) resolve(api);
					else reject(new Error('lottie-player-missing'));
				};
				script.onerror = () => reject(new Error('lottie-player-load-failed'));
				document.head.appendChild(script);
			}).catch((error) => {
				lottiePlayerPromise = null;
				throw error;
			});
			return lottiePlayerPromise;
		}

		function getLottieCanvas(animation) {
			if (!animation) return null;
			try {
				if (animation.renderer && animation.renderer.canvas) return animation.renderer.canvas;
				if (animation.renderer && animation.renderer.canvasContext && animation.renderer.canvasContext.canvas) {
					return animation.renderer.canvasContext.canvas;
				}
				if (animation.rendererContext && animation.rendererContext.canvas) return animation.rendererContext.canvas;
			} catch (error) {
				/* fall through */
			}
			return null;
		}

		function waitForLottieReady(animation) {
			if (!animation || typeof animation.addEventListener !== 'function') return Promise.resolve(animation);
			if (animation.isLoaded === true) return Promise.resolve(animation);
			return new Promise((resolve, reject) => {
				let settled = false;
				const finish = (error) => {
					if (settled) return;
					settled = true;
					if (error) reject(error);
					else resolve(animation);
				};
				try {
					animation.addEventListener('DOMLoaded', () => finish());
					animation.addEventListener('data_failed', () => finish(new Error('lottie-data-failed')));
				} catch (error) {
					finish(error);
				}
				setTimeout(() => finish(new Error('lottie-load-timeout')), 15000);
			});
		}

		async function fetchLottieJson(media) {
			const response = await fetch(`${ROUTE}/media/lottie-json/${encodeURIComponent(media.id)}`);
			if (!response.ok) throw new Error(`lottie-json-${response.status}`);
			return response.json();
		}

		function ensureLottiePreview(media) {
			const key = `${media.id}:${media.fileName || ''}`;
			const existing = lottiePreviewCache.get(media.id);
			if (existing && existing.key === key && existing.status === 'ready') return Promise.resolve(existing);
			if (existing && existing.key === key && existing.status === 'loading') return existing.promise;
			if (existing && existing.animation) {
				try {
					existing.animation.destroy();
				} catch (error) {
					/* ignore */
				}
			}
			const entry = { key, status: 'loading', animation: null, error: null, promise: null, container: null };
			lottiePreviewCache.set(media.id, entry);
			entry.promise = (async () => {
				const api = await loadLottiePlayer();
				const json = await fetchLottieJson(media);
				const container = document.createElement('div');
				container.style.cssText =
					'position:fixed;left:-10000px;top:0;pointer-events:none;opacity:0;' +
					`width:${Math.max(1, Math.round(finiteNumber(json.w, 320)))}px;` +
					`height:${Math.max(1, Math.round(finiteNumber(json.h, 180)))}px;`;
				document.body.appendChild(container);
				entry.container = container;
				const animation = api.loadAnimation({
					container,
					renderer: 'canvas',
					loop: false,
					autoplay: false,
					animationData: json,
					rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
				});
				try {
					// The canvas renderer does not reliably emit DOMLoaded while
					// paused, so wait for its backing canvas and force frame 0.
					const deadline = Date.now() + 15000;
					let canvas = null;
					while (Date.now() < deadline) {
						canvas = getLottieCanvas(animation);
						if (canvas && canvas.width > 0 && canvas.height > 0 && animation.isLoaded === true) break;
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
					if (!canvas || canvas.width < 1 || canvas.height < 1) {
						throw new Error('lottie-canvas-unavailable');
					}
					animation.goToAndStop(0, true);
					await new Promise((resolve) => setTimeout(resolve, 60));
					entry.animation = animation;
					entry.status = 'ready';
					return entry;
				} catch (error) {
					try {
						animation.destroy();
					} catch (destroyError) {
						/* ignore */
					}
					container.remove();
					entry.container = null;
					throw error;
				}
			})().catch((error) => {
				entry.status = 'error';
				entry.error = error;
				throw error;
			});
			return entry.promise;
		}

		function disposeLottiePreview(mediaId) {
			const entry = lottiePreviewCache.get(mediaId);
			if (!entry) return;
			if (entry.animation) {
				try {
					entry.animation.destroy();
				} catch (error) {
					/* ignore */
				}
			}
			if (entry.container && entry.container.parentNode) entry.container.parentNode.removeChild(entry.container);
			lottiePreviewCache.delete(mediaId);
			lottieThumbCache.delete(mediaId);
		}

		function disposeLottiePreviewsExcept(activeIds) {
			for (const mediaId of Array.from(lottiePreviewCache.keys())) {
				if (!activeIds.has(mediaId)) disposeLottiePreview(mediaId);
			}
		}

		function disposeAllLottiePreviews() {
			for (const mediaId of Array.from(lottiePreviewCache.keys())) disposeLottiePreview(mediaId);
		}

		function renderLottieThumb(media) {
			const key = `${media.id}:${media.fileName || ''}`;
			const cached = lottieThumbCache.get(media.id);
			if (cached && cached.key === key) return cached.promise;
			const entry = { key, promise: null };
			entry.promise = (async () => {
				const asset = await ensureLottiePreview(media);
				const animation = asset.animation;
				animation.goToAndStop(0, true);
				const canvas = getLottieCanvas(animation);
				if (!canvas || typeof canvas.toDataURL !== 'function') throw new Error('lottie-canvas-unavailable');
				return canvas.toDataURL('image/png');
			})().catch((error) => {
				lottieThumbCache.delete(media.id);
				throw error;
			});
			lottieThumbCache.set(media.id, entry);
			return entry.promise;
		}

		function renderLottieFrameDataUrl(animation, clip, project, index) {
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(2, Math.round(project.width));
			canvas.height = Math.max(2, Math.round(project.height));
			const context = canvas.getContext('2d');
			if (!context) throw new Error('lottie-canvas-unavailable');
			context.clearRect(0, 0, canvas.width, canvas.height);
			const source = getLottieCanvas(animation);
			if (!source) throw new Error('lottie-canvas-unavailable');
			const fps = Math.max(1, Number(project.fps) || 30);
			const seconds = (finiteNumber(clip.trimStartFrame, 0) + index * clipSpeedOf(clip)) / fps;
			animation.goToAndStop(Math.max(0, seconds), true);
			context.drawImage(source, 0, 0, canvas.width, canvas.height);
			if (typeof canvas.toDataURL !== 'function') throw new Error('lottie-canvas-unavailable');
			return canvas.toDataURL('image/png');
		}


		const PROXY_PREVIEW_KEY = 'opentake-studio.proxy-preview';

		function readProxyPreviewPreference() {
			try {
				return window.localStorage.getItem(PROXY_PREVIEW_KEY) === 'true';
			} catch (error) {
				return false;
			}
		}

		function writeProxyPreviewPreference(value) {
			try {
				window.localStorage.setItem(PROXY_PREVIEW_KEY, value ? 'true' : 'false');
			} catch (error) {
				/* preference persistence is best-effort */
			}
		}

		function mediaThumbUrl(mediaId) {
			return `${ROUTE}/media/thumb/${encodeURIComponent(mediaId)}`;
		}

		function libraryThumbUrl(itemId) {
			return `${ROUTE}/library/thumb/${encodeURIComponent(itemId)}`;
		}

		function libraryItemsQuery(query, kind, favoritesOnly, folderId) {
			const params = [];
			if (typeof query === 'string' && query.trim().length > 0) params.push(`query=${encodeURIComponent(query.trim())}`);
			if (kind !== undefined && kind !== 'all' && kind !== '') params.push(`kind=${encodeURIComponent(kind)}`);
			if (favoritesOnly) params.push('favorite=true');
			if (folderId === null) params.push('folderId=root');
			else if (typeof folderId === 'string' && folderId.length > 0) params.push(`folderId=${encodeURIComponent(folderId)}`);
			return params.length > 0 ? `library?${params.join('&')}` : 'library';
		}

		function libraryFolderChildren(folders, parentId) {
			const list = Array.isArray(folders) ? folders : [];
			return list
				.filter((folder) => folder && typeof folder.id === 'string' && (folder.parentId ?? null) === (parentId ?? null))
				.sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
		}

		function libraryFolderOptions(folders) {
			const list = Array.isArray(folders) ? folders : [];
			const result = [];
			const visited = new Set();
			const walk = (parentId, depth) => {
				for (const folder of libraryFolderChildren(list, parentId)) {
					if (visited.has(folder.id)) continue;
					visited.add(folder.id);
					result.push({ id: folder.id, name: folder.name || folder.id, depth });
					walk(folder.id, depth + 1);
				}
			};
			walk(null, 0);
			for (const folder of list) {
				if (!visited.has(folder.id)) {
					visited.add(folder.id);
					result.push({ id: folder.id, name: folder.name || folder.id, depth: 0 });
				}
			}
			return result;
		}

		function libraryFolderName(folders, folderId) {
			if (folderId === null || folderId === undefined) return null;
			const list = Array.isArray(folders) ? folders : [];
			const folder = list.find((entry) => entry && entry.id === folderId);
			return folder ? folder.name || folder.id : null;
		}

		function slugify(value) {
			const slug = String(value || 'opentake-studio')
				.toLowerCase()
				.replace(/[^a-z0-9._-]+/g, '-')
				.replace(/^-+|-+$/g, '')
				.slice(0, 64);
			return slug || 'opentake-studio';
		}

		function joinPath(directory, name) {
			const base = String(directory || '').replace(/[\\/]+$/, '');
			if (base.length === 0) return name;
			const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
			return `${base}${separator}${name}`;
		}

		const EXPORT_BIT_DEPTH_CODECS = ['h265', 'vp9', 'prores', 'prores4444'];
		const EXPORT_COLOR_PRIMARIES = ['bt709', 'bt2020'];
		const EXPORT_COLOR_TRCS = ['bt709', 'smpte2084', 'arib-std-b67'];
		const EXPORT_COLOR_SPACES = ['bt709', 'bt2020nc', 'bt2020c'];

		function exportCodecExtension(codec) {
			if (codec === 'prores' || codec === 'prores4444') return '.mov';
			if (codec === 'vp9') return '.webm';
			return '.mp4';
		}

		function suggestedExportName(project, codec) {
			const base = slugify(project && project.name ? project.name : 'opentake-studio');
			return `${base}-${Date.now()}${exportCodecExtension(codec)}`;
		}

		function transcriptCaptionOperation(transcript, project) {
			if (!transcript || !Array.isArray(transcript.segments) || !project) return null;
			const fps = Math.max(1, Number(project.fps) || 30);
			const segments = transcript.segments
				.map((segment) => ({
					startFrame: Math.max(0, Math.round(finiteNumber(segment.startSeconds, 0) * fps)),
					durationFrames: Math.max(1, Math.round((finiteNumber(segment.endSeconds, 0) - finiteNumber(segment.startSeconds, 0)) * fps)),
					text: typeof segment.text === 'string' ? segment.text : '',
				}))
				.filter((segment) => segment.text.trim().length > 0);
			if (segments.length === 0) return null;
			const startFrame = Math.min(...segments.map((segment) => segment.startFrame));
			const endFrame = Math.max(...segments.map((segment) => segment.startFrame + segment.durationFrames));
			const durationFrames = Math.max(1, endFrame - startFrame);
			const relative = segments
				.map((segment) => ({
					startFrame: Math.max(0, segment.startFrame - startFrame),
					durationFrames: segment.durationFrames,
					text: segment.text,
				}))
				.filter((segment) => segment.startFrame < durationFrames);
			if (relative.length === 0) return null;
			return {
				type: 'add-caption',
				clipId: newId(),
				startFrame,
				durationFrames,
				segments: relative,
				style: { fontSize: 44, color: '#ffffff', fontWeight: '600', align: 'center', background: 'rgba(0,0,0,0.45)' },
			};
		}

		function asrConfigured(asr) {
			return Boolean(asr && asr.configured === true && asr.error === undefined);
		}

		function asrKeyRef(asr) {
			return asr && typeof asr.keyRef === 'string' && asr.keyRef.length > 0 ? asr.keyRef : 'OPENTAKE_STUDIO_ASR_KEY';
		}

		function transcriptPreviewLines(transcript, count) {
			if (!transcript || !Array.isArray(transcript.segments)) return [];
			return transcript.segments.slice(0, count === undefined ? 3 : count).map((segment) => ({
				time: formatClock(finiteNumber(segment.startSeconds, 0)),
				text: typeof segment.text === 'string' ? segment.text : '',
			}));
		}

		function effectiveExportSettings(project, dialog) {
			const source = dialog && typeof dialog === 'object' ? dialog : {};
			const projectWidth = project && Number.isFinite(Number(project.width)) ? Math.max(1, Math.round(Number(project.width))) : 1920;
			const projectHeight = project && Number.isFinite(Number(project.height)) ? Math.max(1, Math.round(Number(project.height))) : 1080;
			const projectFps = project && Number.isFinite(Number(project.fps)) ? Math.max(1, Number(project.fps)) : 30;
			const codec = ['h264', 'h265', 'prores', 'prores4444', 'vp9'].includes(source.codec) ? source.codec : 'h264';
			const resolution = ['project', '1080p', '720p', 'custom'].includes(source.resolution) ? source.resolution : 'project';
			let width = projectWidth;
			let height = projectHeight;
			if (resolution === '1080p') {
				width = 1920;
				height = 1080;
			} else if (resolution === '720p') {
				width = 1280;
				height = 720;
			} else if (resolution === 'custom') {
				width = Math.max(2, Math.round(finiteNumber(source.width, projectWidth)));
				height = Math.max(2, Math.round(finiteNumber(source.height, projectHeight)));
			}
			const fpsMode = ['project', 24, 25, 30, 50, 60].includes(Number(source.fps)) ? Number(source.fps) : 'project';
			const fps = fpsMode === 'project' ? projectFps : fpsMode;
			const qualityMode = source.qualityMode === 'bitrate' ? 'bitrate' : 'crf';
			const crf = clamp(Math.round(finiteNumber(source.crf, 20)), 0, 51);
			const rawBitrate = typeof source.bitrate === 'string' ? source.bitrate.trim() : '';
			const bitrate = rawBitrate.length > 0 ? rawBitrate : '8M';
			const bitDepth =
				codec === 'prores' || codec === 'prores4444'
					? 10
					: EXPORT_BIT_DEPTH_CODECS.includes(codec) && Number(source.bitDepth) === 10
						? 10
						: 8;
			const transparent = codec === 'prores4444' && source.transparent === true;
			const colorPrimaries = EXPORT_COLOR_PRIMARIES.includes(source.colorPrimaries) ? source.colorPrimaries : undefined;
			const colorTrc = EXPORT_COLOR_TRCS.includes(source.colorTrc) ? source.colorTrc : undefined;
			const colorspace = EXPORT_COLOR_SPACES.includes(source.colorspace) ? source.colorspace : undefined;
			return {
				codec,
				transparent,
				bitDepth,
				...(colorPrimaries === undefined ? {} : { colorPrimaries }),
				...(colorTrc === undefined ? {} : { colorTrc }),
				...(colorspace === undefined ? {} : { colorspace }),
				resolution,
				width,
				height,
				fpsMode,
				fps,
				qualityMode,
				crf,
				bitrate,
				overwrite: source.overwrite === true,
				extension: exportCodecExtension(codec),
			};
		}

		function normalizeTransform(transform) {
			const input = transform && typeof transform === 'object' ? transform : {};
			return {
				x: clamp01(finiteNumber(input.x, 0)),
				y: clamp01(finiteNumber(input.y, 0)),
				width: clamp01(finiteNumber(input.width, 1)),
				height: clamp01(finiteNumber(input.height, 1)),
				rotation: finiteNumber(input.rotation, 0),
			};
		}

		function clipCropOf(clip) {
			const value = clip && clip.crop;
			if (!value || typeof value !== 'object') return null;
			const crop = {
				x: clamp01(finiteNumber(value.x, 0)),
				y: clamp01(finiteNumber(value.y, 0)),
				width: clamp01(finiteNumber(value.width, 1)),
				height: clamp01(finiteNumber(value.height, 1)),
			};
			if (crop.width <= 0 || crop.height <= 0) return null;
			if (crop.x + crop.width > 1) crop.width = Math.max(0.01, 1 - crop.x);
			if (crop.y + crop.height > 1) crop.height = Math.max(0.01, 1 - crop.y);
			return crop;
		}

		function cropDraftFromClip(clip) {
			return clipCropOf(clip) || { x: 0, y: 0, width: 1, height: 1 };
		}

		function normalizeCropDraft(draft) {
			const width = clamp(finiteNumber(draft.width, 1), 0.01, 1);
			const height = clamp(finiteNumber(draft.height, 1), 0.01, 1);
			return {
				x: clamp(finiteNumber(draft.x, 0), 0, 1 - width),
				y: clamp(finiteNumber(draft.y, 0), 0, 1 - height),
				width,
				height,
			};
		}

		const BLEND_MODES = ['normal', 'screen', 'multiply', 'overlay', 'darken', 'lighten', 'add', 'difference'];
		const TRACK_ROLES = ['voice', 'music', 'sfx', 'other'];
		const DUCK_ATTENUATION = 0.35;

		function trackRoleOf(track) {
			return track && TRACK_ROLES.includes(track.role) ? track.role : 'other';
		}

		function isDuckableRole(role) {
			return role === 'music' || role === 'sfx';
		}

		function trackDuckingOf(track) {
			return Boolean(track && track.ducking === true && isDuckableRole(trackRoleOf(track)));
		}

		const CANVAS_BLEND_MODES = Object.freeze({
			normal: 'source-over',
			screen: 'screen',
			multiply: 'multiply',
			overlay: 'overlay',
			darken: 'darken',
			lighten: 'lighten',
			add: 'lighter',
			difference: 'difference',
		});

		function clipMaskOf(clip) {
			const value = clip && clip.mask;
			if (!value || typeof value !== 'object') return null;
			const width = clamp(finiteNumber(value.width, 1), 0.01, 1);
			const height = clamp(finiteNumber(value.height, 1), 0.01, 1);
			return {
				shape: value.shape === 'ellipse' ? 'ellipse' : 'rect',
				x: clamp(finiteNumber(value.x, 0), 0, 1 - width),
				y: clamp(finiteNumber(value.y, 0), 0, 1 - height),
				width,
				height,
				feather: clamp01(finiteNumber(value.feather, 0)),
				invert: value.invert === true,
			};
		}

		function maskDraftFromClip(clip) {
			return (
				clipMaskOf(clip) || {
					shape: 'rect',
					x: 0,
					y: 0,
					width: 1,
					height: 1,
					feather: 0,
					invert: false,
				}
			);
		}

		function normalizeMaskDraft(draft) {
			const width = clamp(finiteNumber(draft.width, 1), 0.01, 1);
			const height = clamp(finiteNumber(draft.height, 1), 0.01, 1);
			return {
				shape: draft.shape === 'ellipse' ? 'ellipse' : 'rect',
				x: clamp(finiteNumber(draft.x, 0), 0, 1 - width),
				y: clamp(finiteNumber(draft.y, 0), 0, 1 - height),
				width,
				height,
				feather: clamp01(finiteNumber(draft.feather, 0)),
				invert: draft.invert === true,
			};
		}

		function clipBlendMode(clip) {
			return clip && BLEND_MODES.includes(clip.blendMode) ? clip.blendMode : 'normal';
		}

		function isFullFrameBlendClip(clip) {
			if (!clip) return false;
			if (clip.crop || clip.mask) return false;
			const transform = normalizeTransform(clip.transform);
			return transform.x === 0 && transform.y === 0 && transform.width === 1 && transform.height === 1 && transform.rotation === 0;
		}

		function addMaskShape(context, mask, box, shrink) {
			const factor = clamp(finiteNumber(shrink, 1), 0.0001, 1);
			const width = Math.max(0.5, mask.width * box.width * factor);
			const height = Math.max(0.5, mask.height * box.height * factor);
			const centerX = -box.width / 2 + (mask.x + mask.width / 2) * box.width;
			const centerY = -box.height / 2 + (mask.y + mask.height / 2) * box.height;
			const left = centerX - width / 2;
			const top = centerY - height / 2;
			if (mask.shape === 'ellipse') {
				context.moveTo(left + width, top + height / 2);
				context.ellipse(left + width / 2, top + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2, false);
			} else {
				context.rect(left, top, width, height);
			}
		}

		function applyClipMask(context, mask, box, shrink) {
			if (!mask) return;
			context.beginPath();
			if (mask.invert) context.rect(-box.width / 2, -box.height / 2, box.width, box.height);
			addMaskShape(context, mask, box, shrink === undefined ? 1 : shrink);
			try {
				context.clip(mask.invert ? 'evenodd' : 'nonzero');
			} catch (error) {
				context.clip();
			}
		}

		function applyMaskRing(context, mask, box, outerShrink, innerShrink) {
			context.beginPath();
			addMaskShape(context, mask, box, outerShrink);
			addMaskShape(context, mask, box, innerShrink);
			try {
				context.clip('evenodd');
			} catch (error) {
				context.clip();
			}
		}

		function draftFromClip(clip) {
			const transform = normalizeTransform(clip.transform);
			const text = clip.text || {};
			return {
				volume: clamp01(finiteNumber(clip.volume, 1)),
				opacity: clamp01(finiteNumber(clip.opacity, 1)),
				x: transform.x,
				y: transform.y,
				width: transform.width,
				height: transform.height,
				rotation: transform.rotation,
				content: typeof text.content === 'string' ? text.content : '',
				fontSize: finiteNumber(text.fontSize, 48),
				color: typeof text.color === 'string' && text.color.length > 0 ? text.color : '#ffffff',
				fontWeight: text.fontWeight === '400' || text.fontWeight === '700' ? text.fontWeight : '600',
				align: text.align === 'left' || text.align === 'right' ? text.align : 'center',
			};
		}

		function mergeDraft(draft, patch) {
			const next = Object.assign({}, draft || {}, patch);
			return next;
		}

		function newId() {
			try {
				if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
					return crypto.randomUUID();
				}
			} catch (error) {
				/* fall through */
			}
			return `ots-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		}

		function deepCopy(value) {
			try {
				return JSON.parse(JSON.stringify(value));
			} catch (error) {
				return value;
			}
		}

		// Phase 1: speed, fades, keyframes, effects, captions, markers, transitions.
		const KEYFRAME_PROPERTIES = ['volume', 'opacity', 'x', 'y', 'width', 'height', 'rotation'];
		const KEYFRAME_EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out'];
		const EFFECT_TYPES = ['brightness', 'contrast', 'saturation', 'temperature', 'blur', 'sharpen', 'chromaKey', 'lut'];
		const TRANSITION_TYPES = ['dissolve', 'fadeToBlack', 'wipeLeft', 'wipeRight'];
		const DEFAULT_CAPTION_STYLE = Object.freeze({
			fontSize: 48,
			color: '#ffffff',
			fontWeight: '600',
			align: 'center',
			background: null,
		});
		const DEFAULT_CAPTION_TRANSFORM = Object.freeze({ x: 0.05, y: 0.78, width: 0.9, height: 0.16, rotation: 0 });

		function effectDefaultParams(type) {
			switch (type) {
				case 'brightness':
				case 'contrast':
				case 'saturation':
					return { amount: 1 };
				case 'temperature':
					return { amount: 0 };
				case 'blur':
					return { radius: 0 };
				case 'sharpen':
					return { amount: 0 };
				case 'chromaKey':
					return { keyColor: '#00ff00', similarity: 0.1, blend: 0.1 };
				case 'lut':
					return { file: 'look.cube' };
				default:
					return {};
			}
		}

		function clipSpeedOf(clip) {
			return clamp(finiteNumber(clip && clip.speed, 1), 0.25, 4);
		}

		function clipDurationOf(clip) {
			return Math.max(1, Math.round(finiteNumber(clip && clip.durationFrames, 1)));
		}

		function clipFadeInFrames(clip) {
			return clamp(Math.round(finiteNumber(clip && clip.fadeInFrames, 0)), 0, clipDurationOf(clip));
		}

		function clipFadeOutFrames(clip) {
			return clamp(Math.round(finiteNumber(clip && clip.fadeOutFrames, 0)), 0, clipDurationOf(clip));
		}

		function clipFadeFactor(clip, frame) {
			const duration = clipDurationOf(clip);
			const relative = frame - clip.startFrame;
			let factor = 1;
			const fadeIn = clipFadeInFrames(clip);
			const fadeOut = clipFadeOutFrames(clip);
			if (fadeIn > 0) factor *= clamp01(relative / fadeIn);
			if (fadeOut > 0) factor *= clamp01((duration - relative) / fadeOut);
			return clamp01(factor);
		}

		function applyEasing(progress, easing) {
			const value = clamp01(progress);
			switch (easing) {
				case 'ease-in':
					return value * value;
				case 'ease-out':
					return 1 - (1 - value) * (1 - value);
				case 'ease-in-out':
					return value < 0.5 ? 2 * value * value : 1 - 2 * (1 - value) * (1 - value);
				default:
					return value;
			}
		}

		function keyframesOf(clip, property) {
			const keyframes = clip && clip.keyframes;
			const list = keyframes && keyframes[property];
			if (!Array.isArray(list) || list.length === 0) return [];
			return list
				.filter((keyframe) => keyframe && Number.isFinite(Number(keyframe.frame)) && Number.isFinite(Number(keyframe.value)))
				.map((keyframe) => ({
					frame: Number(keyframe.frame),
					value: Number(keyframe.value),
					easing: KEYFRAME_EASINGS.includes(keyframe.easing) ? keyframe.easing : 'linear',
				}))
				.sort((a, b) => a.frame - b.frame);
		}

		function evaluateKeyframes(list, frame, fallback) {
			if (!Array.isArray(list) || list.length === 0) return fallback;
			const sorted = list
				.filter((keyframe) => keyframe && Number.isFinite(Number(keyframe.frame)) && Number.isFinite(Number(keyframe.value)))
				.slice()
				.sort((a, b) => Number(a.frame) - Number(b.frame));
			if (sorted.length === 0) return fallback;
			const value = Number(frame);
			if (value <= Number(sorted[0].frame)) return Number(sorted[0].value);
			if (value >= Number(sorted[sorted.length - 1].frame)) return Number(sorted[sorted.length - 1].value);
			for (let index = 0; index < sorted.length - 1; index += 1) {
				const current = sorted[index];
				const next = sorted[index + 1];
				if (value >= Number(current.frame) && value <= Number(next.frame)) {
					const span = Number(next.frame) - Number(current.frame);
					const progress = span <= 0 ? 1 : (value - Number(current.frame)) / span;
					const eased = applyEasing(progress, next.easing || 'linear');
					return Number(current.value) + (Number(next.value) - Number(current.value)) * eased;
				}
			}
			return fallback;
		}

		function clipPropertyAt(clip, property, relativeFrame, fallback) {
			return evaluateKeyframes(keyframesOf(clip, property), relativeFrame, fallback);
		}

		function baseTransformForClip(clip) {
			if (clip && clip.transform) return normalizeTransform(clip.transform);
			if (clip && clip.type === 'caption') return Object.assign({}, DEFAULT_CAPTION_TRANSFORM);
			return normalizeTransform(undefined);
		}

		function clipTransformAt(clip, relativeFrame) {
			const base = baseTransformForClip(clip);
			return {
				x: clamp01(clipPropertyAt(clip, 'x', relativeFrame, base.x)),
				y: clamp01(clipPropertyAt(clip, 'y', relativeFrame, base.y)),
				width: clamp01(clipPropertyAt(clip, 'width', relativeFrame, base.width)),
				height: clamp01(clipPropertyAt(clip, 'height', relativeFrame, base.height)),
				rotation: finiteNumber(clipPropertyAt(clip, 'rotation', relativeFrame, base.rotation), base.rotation),
			};
		}

		function clipEffects(clip) {
			return clip && Array.isArray(clip.effects) ? clip.effects : [];
		}

		function effectsFilterOf(effects) {
			const parts = [];
			let temperature = 0;
			const skipped = [];
			for (const effect of effects) {
				if (!effect || effect.enabled === false) continue;
				const params = effect.params && typeof effect.params === 'object' ? effect.params : {};
				if (effect.type === 'brightness') {
					parts.push(`brightness(${clamp(finiteNumber(params.amount, 1), 0, 2)})`);
				} else if (effect.type === 'contrast') {
					parts.push(`contrast(${clamp(finiteNumber(params.amount, 1), 0, 2)})`);
				} else if (effect.type === 'saturation') {
					parts.push(`saturate(${clamp(finiteNumber(params.amount, 1), 0, 2)})`);
				} else if (effect.type === 'blur') {
					const radius = clamp(finiteNumber(params.radius, 0), 0, 30);
					if (radius > 0) parts.push(`blur(${radius}px)`);
				} else if (effect.type === 'sharpen') {
					parts.push(`contrast(${1 + clamp(finiteNumber(params.amount, 0), 0, 2) * 0.2})`);
				} else if (effect.type === 'temperature') {
					temperature = clamp(temperature + finiteNumber(params.amount, 0), -1, 1);
				} else {
					skipped.push(effect.type);
				}
			}
			if (temperature > 0) {
				parts.push(`sepia(${(temperature * 0.35).toFixed(3)})`, `saturate(${(1 + temperature * 0.15).toFixed(3)})`);
			} else if (temperature < 0) {
				parts.push(`hue-rotate(${(temperature * 30).toFixed(2)}deg)`, `saturate(${(1 + temperature * 0.1).toFixed(3)})`);
			}
			return {
				filter: parts.length > 0 ? parts.join(' ') : 'none',
				skipped,
			};
		}

		function projectMarkers(project) {
			return project && Array.isArray(project.markers) ? project.markers : [];
		}

		function projectTransitions(project) {
			return project && Array.isArray(project.transitions) ? project.transitions : [];
		}

		function transitionEntryForClip(project, clip) {
			if (!clip) return null;
			for (const transition of projectTransitions(project)) {
				if (!transition) continue;
				if (transition.fromClipId === clip.id) return { role: 'from', transition };
				if (transition.toClipId === clip.id) return { role: 'to', transition };
			}
			return null;
		}

		function transitionBoundaryOf(project, clip, entry) {
			const transition = entry.transition;
			const duration = Math.max(1, Math.round(finiteNumber(transition.durationFrames, 1)));
			const half = duration / 2;
			if (entry.role === 'from') {
				const boundary = clip.startFrame + clip.durationFrames;
				return { boundary, half, start: boundary - half, end: boundary + half };
			}
			const boundary = clip.startFrame;
			return { boundary, half, start: boundary - half, end: boundary + half };
		}

		function clipIsVisibleAt(project, clip, frame) {
			if (frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames) return true;
			const entry = transitionEntryForClip(project, clip);
			if (!entry) return false;
			const windowInfo = transitionBoundaryOf(project, clip, entry);
			return frame >= windowInfo.start && frame < windowInfo.end;
		}

		function transitionRenderState(project, clip, frame) {
			const entry = transitionEntryForClip(project, clip);
			if (!entry) return { opacity: 1, clipRect: null };
			const windowInfo = transitionBoundaryOf(project, clip, entry);
			if (frame < windowInfo.start || frame >= windowInfo.end) return { opacity: 1, clipRect: null };
			const span = Math.max(0.0001, windowInfo.end - windowInfo.start);
			const progress = clamp01((frame - windowInfo.start) / span);
			const type = TRANSITION_TYPES.includes(entry.transition.type) ? entry.transition.type : 'dissolve';
			if (type === 'wipeLeft' || type === 'wipeRight') {
				const width = project.width;
				const height = project.height;
				let rect;
				if (type === 'wipeLeft') {
					rect =
						entry.role === 'from'
							? { x: 0, y: 0, width: width * (1 - progress), height }
							: { x: width * (1 - progress), y: 0, width: width * progress, height };
				} else {
					rect =
						entry.role === 'from'
							? { x: width * progress, y: 0, width: width * (1 - progress), height }
							: { x: 0, y: 0, width: width * progress, height };
				}
				return { opacity: 1, clipRect: rect };
			}
			if (type === 'fadeToBlack') {
				if (entry.role === 'from') return { opacity: progress < 0.5 ? 1 - progress * 2 : 0, clipRect: null };
				return { opacity: progress > 0.5 ? (progress - 0.5) * 2 : 0, clipRect: null };
			}
			return { opacity: entry.role === 'from' ? 1 - progress : progress, clipRect: null };
		}

		function captionOf(clip) {
			if (clip && clip.caption && typeof clip.caption === 'object') return clip.caption;
			return { segments: [], style: {} };
		}

		function captionSegmentsOf(clip) {
			const caption = captionOf(clip);
			return Array.isArray(caption.segments) ? caption.segments : [];
		}

		function captionStyleOf(clip) {
			const caption = captionOf(clip);
			return Object.assign({}, DEFAULT_CAPTION_STYLE, caption.style && typeof caption.style === 'object' ? caption.style : {});
		}

		function captionSegmentAt(clip, relativeFrame) {
			for (const segment of captionSegmentsOf(clip)) {
				if (!segment) continue;
				const start = Math.round(finiteNumber(segment.startFrame, 0));
				const duration = Math.max(1, Math.round(finiteNumber(segment.durationFrames, 1)));
				if (relativeFrame >= start && relativeFrame < start + duration) return segment;
			}
			return null;
		}

		function clipRelativeFrame(clip, frame) {
			return frame - clip.startFrame;
		}

		function clipSourceSeconds(clip, frame, fps) {
			const speed = clipSpeedOf(clip);
			return (finiteNumber(clip.trimStartFrame, 0) + clipRelativeFrame(clip, frame) * speed) / Math.max(1, fps);
		}

		function activeVisualClipsAt(project, frame) {
			const rows = [];
			if (!project) return rows;
			for (const track of project.tracks) {
				if (track.hidden || track.type !== 'video') continue;
				for (const clip of track.clips) {
					if (clip.type === 'audio') continue;
					if (clipIsVisibleAt(project, clip, frame)) rows.push({ track, clip });
				}
			}
			return rows;
		}

		function clipDisplayLabel(project, clip, fallback) {
			if (clip.type === 'motion') {
				const motion = motionOf(clip);
				const text = motion.text.trim();
				return text.length > 0 ? text.split('\n')[0] : fallback;
			}
			if (clip.type === 'text') {
				const content = clip.text && typeof clip.text.content === 'string' ? clip.text.content : '';
				const firstLine = content.split('\n')[0].trim();
				return firstLine.length > 0 ? firstLine : fallback;
			}
			if (clip.type === 'caption') {
				for (const segment of captionSegmentsOf(clip)) {
					if (segment && typeof segment.text === 'string' && segment.text.trim().length > 0) {
						return segment.text.split('\n')[0].trim();
					}
				}
				return fallback;
			}
			const media = findMedia(project, clip.mediaId);
			return media ? media.name : fallback;
		}

		function downloadDataUrl(filename, dataUrl) {
			try {
				if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
				const anchor = document.createElement('a');
				if (!anchor) return false;
				anchor.href = dataUrl;
				anchor.download = filename;
				anchor.rel = 'noopener';
				if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(anchor);
				if (typeof anchor.click !== 'function') return false;
				anchor.click();
				if (document.body && typeof document.body.removeChild === 'function' && anchor.parentNode === document.body) {
					document.body.removeChild(anchor);
				} else if (typeof anchor.remove === 'function') {
					anchor.remove();
				}
				return true;
			} catch (error) {
				return false;
			}
		}

		function exportFrameFileName(project, frame) {
			const base = String(project && project.name ? project.name : 'opentake-studio')
				.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
				.trim();
			const safe = base.length > 0 ? base : 'opentake-studio';
			return `${safe}-${Math.max(0, Math.round(frame))}.png`;
		}

		function downloadTextFile(filename, text) {
			try {
				if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return;
				const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
				const url = URL.createObjectURL(blob);
				const anchor = document.createElement('a');
				anchor.href = url;
				anchor.download = filename;
				if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(anchor);
				if (typeof anchor.click === 'function') anchor.click();
				if (typeof anchor.remove === 'function') anchor.remove();
				if (typeof URL.revokeObjectURL === 'function') setTimeout(() => URL.revokeObjectURL(url), 1000);
			} catch (error) {
				/* download is best-effort */
			}
		}

		function buildPasteOperations(entries, targetFrame) {
			const operations = [];
			const createdIds = [];
			if (!Array.isArray(entries) || entries.length === 0) return { operations, createdIds };
			let minStart = Infinity;
			for (const entry of entries) {
				if (entry && entry.clip) minStart = Math.min(minStart, finiteNumber(entry.clip.startFrame, 0));
			}
			if (!Number.isFinite(minStart)) minStart = 0;
			for (const entry of entries) {
				if (!entry || !entry.clip) continue;
				const clip = entry.clip;
				const startFrame = Math.max(0, Math.round(targetFrame + (finiteNumber(clip.startFrame, 0) - minStart)));
				const clipId = newId();
				createdIds.push(clipId);
				if (clip.type === 'text') {
					operations.push({
						type: 'add-text',
						clipId,
						trackId: entry.trackId,
						startFrame,
						durationFrames: Math.max(1, Math.round(finiteNumber(clip.durationFrames, 1))),
						content: clip.text && typeof clip.text.content === 'string' ? clip.text.content : '',
						text: deepCopy(clip.text || {}),
						transform: deepCopy(clip.transform || undefined),
					});
					operations.push({
						type: 'set-clip-properties',
						clipIds: [clipId],
						volume: clamp01(finiteNumber(clip.volume, 1)),
						opacity: clamp01(finiteNumber(clip.opacity, 1)),
						transform: deepCopy(clip.transform || normalizeTransform(clip.transform)),
					});
				} else if (clip.type === 'caption') {
					operations.push({
						type: 'add-caption',
						clipId,
						trackId: entry.trackId,
						startFrame,
						durationFrames: Math.max(1, Math.round(finiteNumber(clip.durationFrames, 1))),
						segments: deepCopy(captionSegmentsOf(clip)),
						style: deepCopy(captionStyleOf(clip)),
					});
					operations.push({
						type: 'set-clip-properties',
						clipIds: [clipId],
						volume: clamp01(finiteNumber(clip.volume, 1)),
						opacity: clamp01(finiteNumber(clip.opacity, 1)),
						transform: deepCopy(clip.transform || DEFAULT_CAPTION_TRANSFORM),
					});
				} else if (clip.mediaId) {
					const speed = clipSpeedOf(clip);
					const timelineDuration = Math.max(1, Math.round(finiteNumber(clip.durationFrames, 1)));
					const sourceDuration = Math.max(1, Math.round(timelineDuration * speed));
					operations.push({
						type: 'add-clip',
						clipId,
						mediaId: clip.mediaId,
						trackId: entry.trackId,
						startFrame,
						durationFrames: clip.type === 'video' || clip.type === 'audio' ? sourceDuration : timelineDuration,
						trimStartFrame: Math.max(0, Math.round(finiteNumber(clip.trimStartFrame, 0))),
					});
					operations.push({
						type: 'set-clip-properties',
						clipIds: [clipId],
						volume: clamp01(finiteNumber(clip.volume, 1)),
						opacity: clamp01(finiteNumber(clip.opacity, 1)),
						transform: deepCopy(clip.transform || normalizeTransform(undefined)),
					});
				} else {
					continue;
				}
				if (clip.type === 'video' || clip.type === 'audio') {
					if (Math.abs(clipSpeedOf(clip) - 1) > 0.0001) {
						operations.push({ type: 'set-speed', clipId, speed: clipSpeedOf(clip) });
					}
				}
				if (clipFadeInFrames(clip) > 0 || clipFadeOutFrames(clip) > 0) {
					operations.push({
						type: 'set-fades',
						clipId,
						fadeInFrames: clipFadeInFrames(clip),
						fadeOutFrames: clipFadeOutFrames(clip),
					});
				}
				for (const property of KEYFRAME_PROPERTIES) {
					const list = keyframesOf(clip, property);
					if (list.length > 0) operations.push({ type: 'set-keyframes', clipId, property, keyframes: list });
				}
				for (const effect of clipEffects(clip)) {
					if (!effect) continue;
					operations.push({
						type: 'add-effect',
						clipId,
						effect: {
							id: newId(),
							type: effect.type,
							enabled: effect.enabled !== false,
							params: deepCopy(effect.params || {}),
						},
					});
				}
			}
			return { operations, createdIds };
		}

		function buildRippleOperations(project, entries) {
			const operations = [];
			const selectedIds = new Set();
			const byTrack = new Map();
			for (const entry of entries) {
				if (!entry || !entry.clip || !entry.track) continue;
				selectedIds.add(entry.clip.id);
				const list = byTrack.get(entry.track.id) || [];
				list.push(entry.clip);
				byTrack.set(entry.track.id, list);
			}
			if (selectedIds.size === 0) return { operations, clipIds: [] };
			operations.push({ type: 'remove-clips', clipIds: Array.from(selectedIds) });
			for (const track of project.tracks) {
				const removed = byTrack.get(track.id);
				if (!removed || removed.length === 0) continue;
				for (const clip of track.clips) {
					if (selectedIds.has(clip.id)) continue;
					let shift = 0;
					for (const removedClip of removed) {
						if (removedClip.startFrame < clip.startFrame) shift += Math.max(1, removedClip.durationFrames);
					}
					if (shift > 0) {
						operations.push({
							type: 'move-clip',
							clipId: clip.id,
							startFrame: Math.max(0, clip.startFrame - shift),
						});
					}
				}
			}
			return { operations, clipIds: Array.from(selectedIds) };
		}

		function nextClipIdAfter(previousProject, nextProject, predicate) {
			const before = new Set(allClips(previousProject).map(({ clip }) => clip.id));
			for (const { clip } of allClips(nextProject)) {
				if (before.has(clip.id)) continue;
				if (typeof predicate === 'function' && !predicate(clip)) continue;
				return clip.id;
			}
			return null;
		}

		function rulerStepSeconds(zoom, fps) {
			const pxPerSecond = Math.max(0.0001, zoom * Math.max(1, fps));
			const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
			for (const seconds of candidates) {
				if (seconds * pxPerSecond >= 64) return seconds;
			}
			return 3600;
		}

		// -------------------------------------------------------------------
		// Host route access
		// -------------------------------------------------------------------

		class HostRequestError extends Error {
			constructor(message, code, status) {
				super(message);
				this.name = 'HostRequestError';
				this.code = code;
				this.status = status;
				this.fromHost = true;
			}
		}

		async function hostRequest(path, options) {
			const settings = options || {};
			const init = { method: settings.method || 'GET', headers: {} };
			if (settings.body !== undefined) {
				init.headers['content-type'] = 'application/json';
				init.body = JSON.stringify(settings.body);
			}
			const response = await fetch(`${ROUTE}/${path}`, init);
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				payload = null;
			}
			if (!response.ok) {
				const detail = payload && payload.error ? payload.error : null;
				const message = detail && typeof detail.message === 'string' ? detail.message : `Host route failed (${response.status})`;
				const code = detail && typeof detail.code === 'string' ? detail.code : 'http-error';
				throw new HostRequestError(message, code, response.status);
			}
			return payload;
		}

		async function hostPost(path, body) {
			return hostRequest(path, { method: 'POST', body: body === undefined ? {} : body });
		}

		function safeSetCurrentTime(element, seconds) {
			try {
				element.currentTime = Math.max(0, seconds);
			} catch (error) {
				/* metadata is not ready yet; the next sync retries */
			}
		}

		// -------------------------------------------------------------------
		// Canvas compositing
		// -------------------------------------------------------------------

		function transformBox(transform, width, height) {
			const value = normalizeTransform(transform);
			return {
				x: value.x * width,
				y: value.y * height,
				width: Math.max(1, value.width * width),
				height: Math.max(1, value.height * height),
				rotation: value.rotation,
			};
		}

		function drawTextClip(context, clip, box) {
			const text = clip.text || {};
			const fontSize = Math.max(1, finiteNumber(text.fontSize, 48));
			const weight = text.fontWeight === '400' || text.fontWeight === '700' ? text.fontWeight : '600';
			const align = text.align === 'left' || text.align === 'right' ? text.align : 'center';
			const content = typeof text.content === 'string' ? text.content : '';
			context.fillStyle = typeof text.color === 'string' && text.color.length > 0 ? text.color : '#ffffff';
			context.font = `${weight} ${fontSize}px -apple-system, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif`;
			context.textAlign = align;
			context.textBaseline = 'top';
			const anchorX = align === 'left' ? -box.width / 2 : align === 'right' ? box.width / 2 : 0;
			const lines = content.length === 0 ? [''] : content.split('\n');
			const lineHeight = fontSize * 1.2;
			let y = -box.height / 2;
			for (const line of lines) {
				context.fillText(line, anchorX, y);
				y += lineHeight;
			}
		}

		function drawCaptionClip(context, clip, relativeFrame, box) {
			const segment = captionSegmentAt(clip, relativeFrame);
			if (!segment || typeof segment.text !== 'string' || segment.text.length === 0) return;
			const style = captionStyleOf(clip);
			const fontSize = Math.max(1, finiteNumber(style.fontSize, 48));
			const weight = style.fontWeight === '400' || style.fontWeight === '700' ? style.fontWeight : '600';
			const align = style.align === 'left' || style.align === 'right' ? style.align : 'center';
			const inset = 6;
			context.font = `${weight} ${fontSize}px -apple-system, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif`;
			const lines = wrapTextLines(context, segment.text, Math.max(1, box.width - inset * 2));
			const lineHeight = fontSize * 1.2;
			const totalHeight = lines.length * lineHeight;
			let widest = 0;
			for (const line of lines) widest = Math.max(widest, context.measureText(line).width);
			const blockWidth = Math.min(box.width, Math.max(1, widest + inset * 2));
			const blockHeight = Math.min(box.height, Math.max(1, totalHeight + inset * 2));
			const blockX = align === 'left' ? -box.width / 2 : align === 'right' ? box.width / 2 - blockWidth : -blockWidth / 2;
			const blockY = -box.height / 2 + Math.max(0, (box.height - blockHeight) / 2);
			context.textAlign = align;
			context.textBaseline = 'top';
			if (typeof style.background === 'string' && style.background.length > 0) {
				context.fillStyle = style.background;
				context.fillRect(blockX, blockY, blockWidth, blockHeight);
			}
			context.fillStyle = typeof style.color === 'string' && style.color.length > 0 ? style.color : '#ffffff';
			const anchorX = align === 'left' ? blockX + inset : align === 'right' ? blockX + blockWidth - inset : 0;
			let y = blockY + Math.max(0, (blockHeight - totalHeight) / 2);
			for (const line of lines) {
				context.fillText(line, anchorX, y);
				y += lineHeight;
			}
		}

		function wrapTextLines(context, content, maxWidth) {
			const paragraphs = String(content || '').split('\n');
			const lines = [];
			const limit = Math.max(1, maxWidth);
			for (const paragraph of paragraphs) {
				if (paragraph.length === 0) {
					lines.push('');
					continue;
				}
				const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
				let line = '';
				for (let word of words) {
					const candidate = line.length === 0 ? word : `${line} ${word}`;
					if (context.measureText(candidate).width <= limit) {
						line = candidate;
						continue;
					}
					if (line.length > 0) {
						lines.push(line);
						line = '';
					}
					while (word.length > 0 && context.measureText(word).width > limit) {
						let cut = word.length - 1;
						while (cut > 1 && context.measureText(word.slice(0, cut)).width > limit) cut -= 1;
						lines.push(word.slice(0, cut));
						word = word.slice(cut);
					}
					line = word;
				}
				lines.push(line);
			}
			return lines.length > 0 ? lines : [''];
		}

		function renderTextContentToDataUrl(content, style, transform, project, padding, background) {
			if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
				throw new Error('Canvas is unavailable in this browser');
			}
			const box = transformBox(transform, project.width, project.height);
			const width = Math.max(1, Math.round(box.width));
			const height = Math.max(1, Math.round(box.height));
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext ? canvas.getContext('2d') : null;
			if (!context) throw new Error('A 2D canvas context is unavailable');
			const fontSize = Math.max(1, finiteNumber(style && style.fontSize, 48));
			const weight = style && (style.fontWeight === '400' || style.fontWeight === '700') ? style.fontWeight : '600';
			const align = style && (style.align === 'left' || style.align === 'right') ? style.align : 'center';
			const inset = padding === undefined ? 2 : Math.max(0, padding);
			context.clearRect(0, 0, width, height);
			context.fillStyle = style && typeof style.color === 'string' && style.color.length > 0 ? style.color : '#ffffff';
			context.font = `${weight} ${fontSize}px -apple-system, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif`;
			context.textAlign = align;
			context.textBaseline = 'top';
			const lines = wrapTextLines(context, content || '', Math.max(1, width - inset * 2));
			const lineHeight = fontSize * 1.2;
			const totalHeight = lines.length * lineHeight;
			let widest = 0;
			for (const line of lines) widest = Math.max(widest, context.measureText(line).width);
			const blockWidth = Math.min(width, Math.max(1, widest + inset * 2));
			const blockHeight = Math.min(height, Math.max(1, totalHeight + inset * 2));
			const blockX = align === 'left' ? 0 : align === 'right' ? width - blockWidth : (width - blockWidth) / 2;
			const blockY = Math.max(0, (height - blockHeight) / 2);
			if (typeof background === 'string' && background.length > 0) {
				context.fillStyle = background;
				context.fillRect(blockX, blockY, blockWidth, blockHeight);
				context.fillStyle = style && typeof style.color === 'string' && style.color.length > 0 ? style.color : '#ffffff';
			}
			const x = align === 'left' ? blockX + inset : align === 'right' ? blockX + blockWidth - inset : width / 2;
			let y = blockY + Math.max(0, (blockHeight - totalHeight) / 2);
			for (const line of lines) {
				if (line.length > 0) context.fillText(line, x, y);
				y += lineHeight;
			}
			if (typeof canvas.toDataURL !== 'function') throw new Error('Canvas export is unavailable');
			return canvas.toDataURL('image/png');
		}

		function renderTextClipToDataUrl(clip, project) {
			const text = clip.text || {};
			return renderTextContentToDataUrl(
				typeof text.content === 'string' ? text.content : '',
				text,
				clip.transform,
				project,
				2,
				null,
			);
		}

		function renderCaptionSegmentToDataUrl(clip, segment, project) {
			const style = captionStyleOf(clip);
			const content = segment && typeof segment.text === 'string' ? segment.text : '';
			const background = typeof style.background === 'string' && style.background.length > 0 ? style.background : null;
			return renderTextContentToDataUrl(
				content,
				style,
				clip.transform || DEFAULT_CAPTION_TRANSFORM,
				project,
				6,
				background,
			);
		}

		function collectTextClips(project) {
			return collectClipsOfType(project, 'text');
		}

		function collectCaptionClips(project) {
			return collectClipsOfType(project, 'caption');
		}

		function collectLottieClips(project) {
			return collectClipsOfType(project, 'lottie');
		}

		function collectMotionClips(project) {
			return collectClipsOfType(project, 'motion');
		}

		function renderMotionFrameDataUrl(clip, project, index) {
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(2, Math.round(project.width));
			canvas.height = Math.max(2, Math.round(project.height));
			const context = canvas.getContext('2d');
			if (!context) throw new Error('motion-canvas-unavailable');
			context.clearRect(0, 0, canvas.width, canvas.height);
			context.save();
			context.translate(canvas.width / 2, canvas.height / 2);
			drawMotionClip(
				context,
				clip,
				index,
				{ x: 0, y: 0, width: canvas.width, height: canvas.height, rotation: 0 },
				project,
			);
			context.restore();
			if (typeof canvas.toDataURL !== 'function') throw new Error('motion-canvas-unavailable');
			return canvas.toDataURL('image/png');
		}

		function collectClipsOfType(project, type) {
			const seen = new Set();
			const rows = [];
			if (!project) return rows;
			for (const track of project.tracks) {
				for (const clip of track.clips) {
					if (clip.type !== type || seen.has(clip.id)) continue;
					seen.add(clip.id);
					rows.push(clip);
				}
			}
			return rows;
		}

		function countExportRenders(project) {
			let count = collectTextClips(project).length;
			for (const clip of collectCaptionClips(project)) {
				const segments = captionSegmentsOf(clip);
				for (const segment of segments) {
					if (segment && typeof segment.text === 'string' && segment.text.length > 0) count += 1;
				}
			}
			for (const clip of collectLottieClips(project)) count += Math.max(1, Math.round(finiteNumber(clip.durationFrames, 1)));
			for (const clip of collectMotionClips(project)) count += Math.max(1, Math.round(finiteNumber(clip.durationFrames, 1)));
			return count;
		}

		async function prepareExportRenders(project, onProgress) {
			for (const clip of collectTextClips(project)) {
				const dataUrl = renderTextClipToDataUrl(clip, project);
				await hostRequest('text/render', { method: 'POST', body: { clipId: clip.id, dataUrl } });
			}
			for (const clip of collectCaptionClips(project)) {
				const segments = captionSegmentsOf(clip);
				for (let index = 0; index < segments.length; index += 1) {
					const segment = segments[index];
					const hasText = segment && typeof segment.text === 'string' && segment.text.length > 0;
					if (!hasText) continue;
					const dataUrl = renderCaptionSegmentToDataUrl(clip, segment, project);
					await hostRequest('text/render', {
						method: 'POST',
						body: { clipId: clip.id, segmentIndex: index, dataUrl },
					});
				}
			}
			for (const clip of collectLottieClips(project)) {
				const media = findMedia(project, clip.mediaId);
				if (!media) throw new Error('Lottie media is missing; relink it before exporting');
				const asset = await ensureLottiePreview(media);
				const total = Math.max(1, Math.round(finiteNumber(clip.durationFrames, 1)));
				await hostRequest('lottie/clear', { method: 'POST', body: { clipId: clip.id } });
				for (let index = 0; index < total; index += 1) {
					if (typeof onProgress === 'function') {
						onProgress('lottie', media.name || clip.id, index + 1, total);
					}
					const dataUrl = renderLottieFrameDataUrl(asset.animation, clip, project, index);
					await hostRequest('lottie/frame', {
						method: 'POST',
						body: { clipId: clip.id, index, dataUrl },
					});
				}
			}
			for (const clip of collectMotionClips(project)) {
				const total = Math.max(1, Math.round(finiteNumber(clip.durationFrames, 1)));
				const motion = motionOf(clip);
				await hostRequest('lottie/clear', { method: 'POST', body: { clipId: clip.id } });
				for (let index = 0; index < total; index += 1) {
					if (typeof onProgress === 'function') onProgress('motion', motion.text || clip.id, index + 1, total);
					const dataUrl = renderMotionFrameDataUrl(clip, project, index);
					await hostRequest('lottie/frame', {
						method: 'POST',
						body: { clipId: clip.id, index, dataUrl },
					});
				}
			}
		}

		const MOTION_TEMPLATES = ['title', 'lowerThird', 'callout'];
		const MOTION_DEFAULT = Object.freeze({
			template: 'title',
			text: 'Your title',
			subtitle: '',
			color: '#ffffff',
			accentColor: '#4f8cff',
			fontSize: 64,
			align: 'center',
			background: false,
		});

		function motionColor(value, fallback) {
			return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
		}

		function motionOf(clip) {
			const motion = clip && clip.motion && typeof clip.motion === 'object' ? clip.motion : {};
			const template = MOTION_TEMPLATES.includes(motion.template) ? motion.template : MOTION_DEFAULT.template;
			const align = motion.align === 'left' || motion.align === 'right' || motion.align === 'center' ? motion.align : MOTION_DEFAULT.align;
			return {
				template,
				text: typeof motion.text === 'string' ? motion.text : MOTION_DEFAULT.text,
				subtitle: typeof motion.subtitle === 'string' ? motion.subtitle : '',
				color: motionColor(motion.color, MOTION_DEFAULT.color),
				accentColor: motionColor(motion.accentColor, MOTION_DEFAULT.accentColor),
				fontSize: clamp(Math.round(finiteNumber(motion.fontSize, MOTION_DEFAULT.fontSize)), 18, 200),
				align,
				background: motion.background === true,
			};
		}

		function normalizeMotionInput(motion) {
			return motionOf({ motion });
		}

		function defaultMotionForm(t) {
			return Object.assign({}, MOTION_DEFAULT, {
				text: t ? t('motion.textDefault') : MOTION_DEFAULT.text,
				subtitle: '',
				durationSeconds: 3,
				error: null,
				busy: false,
			});
		}

		function motionRoundRect(context, x, y, width, height, radius) {
			const r = Math.max(0, Math.min(radius, width / 2, height / 2));
			context.beginPath();
			context.moveTo(x + r, y);
			context.lineTo(x + width - r, y);
			context.quadraticCurveTo(x + width, y, x + width, y + r);
			context.lineTo(x + width, y + height - r);
			context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
			context.lineTo(x + r, y + height);
			context.quadraticCurveTo(x, y + height, x, y + height - r);
			context.lineTo(x, y + r);
			context.quadraticCurveTo(x, y, x + r, y);
			context.closePath();
		}

		function drawMotionClip(context, clip, relativeFrame, box, project) {
			const motion = motionOf(clip);
			const duration = Math.max(1, Math.round(finiteNumber(clip.durationFrames, 1)));
			const local = clamp(Math.round(finiteNumber(relativeFrame, 0)), 0, duration - 1);
			const inFrames = Math.max(1, Math.min(12, Math.round(duration * 0.2)));
			const outFrames = Math.max(1, Math.min(12, Math.round(duration * 0.2)));
			const fadeIn = clamp(local / inFrames, 0, 1);
			const fadeOut = clamp((duration - 1 - local) / outFrames, 0, 1);
			const alpha = Math.min(fadeIn, fadeOut);
			if (alpha <= 0.001 || box.width < 2 || box.height < 2) return;
			const easeOut = (value) => 1 - Math.pow(1 - clamp(value, 0, 1), 3);
			const easeIn = (value) => Math.pow(clamp(value, 0, 1), 3);
			const align = motion.align;
			const fontSize = Math.max(1, motion.fontSize);
			const fontFamily = '-apple-system, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif';
			context.save();
			context.globalAlpha = clamp01(finiteNumber(context.globalAlpha, 1) * alpha);
			if (motion.template === 'lowerThird') {
				const slide = (1 - easeOut(fadeIn)) * -0.22 * box.width;
				const outSlide = (1 - easeOut(fadeOut)) * 0.08 * box.width;
				context.translate(slide + outSlide, 0);
				const maxWidth = Math.max(40, box.width * 0.72);
				context.font = `600 ${fontSize}px ${fontFamily}`;
				const lines = wrapTextLines(context, motion.text || '', maxWidth);
				const subSize = Math.max(10, Math.round(fontSize * 0.44));
				const lineHeight = fontSize * 1.16;
				const subHeight = motion.subtitle ? subSize * 1.3 : 0;
				const blockHeight = lines.length * lineHeight + subHeight + fontSize * 0.4;
				const left = align === 'right' ? box.width / 2 - maxWidth : align === 'center' ? -maxWidth / 2 : -box.width / 2 + box.width * 0.06;
				const top = box.height / 2 - blockHeight - box.height * 0.1;
				if (motion.background) {
					context.fillStyle = 'rgba(8, 12, 20, 0.58)';
					motionRoundRect(context, left - fontSize * 0.28, top - fontSize * 0.2, maxWidth + fontSize * 0.56, blockHeight + fontSize * 0.3, fontSize * 0.18);
					context.fill();
				}
				context.fillStyle = motion.accentColor;
				context.fillRect(left - fontSize * 0.22, top, Math.max(3, fontSize * 0.1), blockHeight);
				context.textBaseline = 'top';
				context.textAlign = align;
				const textX = align === 'left' ? left : align === 'right' ? left + maxWidth : left + maxWidth / 2;
				context.fillStyle = motion.color;
				context.font = `600 ${fontSize}px ${fontFamily}`;
				let y = top;
				for (const line of lines) {
					context.fillText(line, textX, y);
					y += lineHeight;
				}
				if (motion.subtitle) {
					context.font = `400 ${subSize}px ${fontFamily}`;
					context.fillStyle = motion.color;
					context.globalAlpha *= 0.75;
					context.fillText(motion.subtitle, textX, y + fontSize * 0.1);
				}
			} else if (motion.template === 'callout') {
				const pop = 0.85 + 0.15 * (1 - easeIn(1 - fadeIn)) + 0.03 * Math.sin(fadeIn * Math.PI);
				context.scale(pop, pop);
				const maxWidth = Math.max(60, box.width * 0.58);
				const subSize = Math.max(10, Math.round(fontSize * 0.46));
				context.font = `600 ${fontSize}px ${fontFamily}`;
				const lines = wrapTextLines(context, motion.text || '', maxWidth - fontSize * 0.8);
				const lineHeight = fontSize * 1.2;
				const cardWidth = Math.min(box.width * 0.78, maxWidth + fontSize * 0.8);
				const cardHeight = lines.length * lineHeight + (motion.subtitle ? subSize * 1.4 : 0) + fontSize * 0.8;
				const cardX = align === 'left' ? -box.width / 2 + box.width * 0.08 : align === 'right' ? box.width / 2 - cardWidth - box.width * 0.08 : -cardWidth / 2;
				const cardY = -cardHeight / 2;
				context.fillStyle = 'rgba(8, 12, 20, 0.72)';
				motionRoundRect(context, cardX, cardY, cardWidth, cardHeight, fontSize * 0.3);
				context.fill();
				context.fillStyle = motion.accentColor;
				context.fillRect(cardX, cardY, Math.max(3, fontSize * 0.12), cardHeight);
				context.textAlign = 'left';
				context.textBaseline = 'top';
				context.fillStyle = motion.color;
				context.font = `600 ${fontSize}px ${fontFamily}`;
				let y = cardY + fontSize * 0.4;
				for (const line of lines) {
					context.fillText(line, cardX + fontSize * 0.5, y);
					y += lineHeight;
				}
				if (motion.subtitle) {
					context.font = `400 ${subSize}px ${fontFamily}`;
					context.globalAlpha *= 0.78;
					context.fillText(motion.subtitle, cardX + fontSize * 0.5, y + fontSize * 0.08);
				}
			} else {
				const scale = 0.94 + 0.06 * easeOut(fadeIn);
				context.scale(scale, scale);
				const maxWidth = Math.max(80, box.width * 0.84);
				const subSize = Math.max(10, Math.round(fontSize * 0.46));
				context.font = `700 ${fontSize}px ${fontFamily}`;
				const lines = wrapTextLines(context, motion.text || '', maxWidth);
				const lineHeight = fontSize * 1.12;
				const subHeight = motion.subtitle ? subSize * 1.4 : 0;
				const textHeight = lines.length * lineHeight;
				const blockHeight = textHeight + subHeight;
				const startY = -blockHeight / 2;
				const anchorX = align === 'left' ? -box.width / 2 + box.width * 0.08 : align === 'right' ? box.width / 2 - box.width * 0.08 : 0;
				if (motion.background) {
					const padding = fontSize * 0.45;
					const cardW = Math.min(box.width * 0.94, maxWidth + padding * 2);
					const cardX = align === 'left' ? -box.width / 2 + box.width * 0.04 : align === 'right' ? box.width / 2 - box.width * 0.04 - cardW : -cardW / 2;
					context.fillStyle = 'rgba(8, 12, 20, 0.58)';
					motionRoundRect(context, cardX, startY - padding, cardW, blockHeight + padding * 2, fontSize * 0.22);
					context.fill();
				}
				context.textBaseline = 'top';
				context.textAlign = align;
				context.fillStyle = motion.color;
				let y = startY;
				for (const line of lines) {
					context.fillText(line, anchorX, y);
					y += lineHeight;
				}
				if (motion.subtitle) {
					context.font = `400 ${subSize}px ${fontFamily}`;
					context.globalAlpha *= 0.78;
					context.fillText(motion.subtitle, anchorX, y + fontSize * 0.12);
				}
				context.globalAlpha = clamp01(finiteNumber(context.globalAlpha, 1) / Math.max(0.0001, motion.subtitle ? 0.78 : 1));
				const underlineWidth = Math.min(box.width * 0.28, maxWidth * 0.35) * easeOut(fadeIn);
				const underlineY = startY + blockHeight + fontSize * 0.28;
				const underlineX = align === 'left' ? anchorX : align === 'right' ? anchorX - underlineWidth : -underlineWidth / 2;
				context.fillStyle = motion.accentColor;
				context.fillRect(underlineX, underlineY, underlineWidth, Math.max(3, fontSize * 0.08));
			}
			context.restore();
		}

		function drawComposite(context, project, frame, mediaElements) {
			const width = project.width;
			const height = project.height;
			context.save();
			context.setTransform(1, 0, 0, 1, 0, 0);
			context.globalAlpha = 1;
			context.filter = 'none';
			context.fillStyle = '#000000';
			context.fillRect(0, 0, width, height);
			for (const track of project.tracks) {
				if (track.hidden || track.type !== 'video') continue;
				for (const clip of track.clips) {
					if (!clipIsVisibleAt(project, clip, frame)) continue;
					const relative = clipRelativeFrame(clip, frame);
					const fade = clipFadeFactor(clip, frame);
					const transitionState = transitionRenderState(project, clip, frame);
					const opacity =
						clamp01(clipPropertyAt(clip, 'opacity', relative, finiteNumber(clip.opacity, 1))) *
						fade *
						transitionState.opacity;
					if (opacity <= 0.001) continue;
					if (transitionState.clipRect && transitionState.clipRect.width <= 0.5) continue;
					const media = clip.mediaId ? findMedia(project, clip.mediaId) : null;
					const elements = clip.mediaId ? mediaElements[clip.mediaId] : null;
					const box = transformBox(clipTransformAt(clip, relative), width, height);
					const effectFilter = effectsFilterOf(clipEffects(clip)).filter;
					context.save();
					if (transitionState.clipRect) {
						context.beginPath();
						context.rect(
							transitionState.clipRect.x,
							transitionState.clipRect.y,
							Math.max(0, transitionState.clipRect.width),
							Math.max(0, transitionState.clipRect.height),
						);
						context.clip();
					}
					context.globalAlpha = opacity;
					if (effectFilter !== 'none') {
						try {
							context.filter = effectFilter;
						} catch (error) {
							/* an older canvas ignores the filter */
						}
					}
					const crop = clipCropOf(clip);
					if (crop && (clip.type === 'text' || clip.type === 'caption' || clip.type === 'motion')) {
						const cropX = crop.x * width - (box.x + box.width / 2);
						const cropY = crop.y * height - (box.y + box.height / 2);
						context.beginPath();
						context.rect(cropX, cropY, Math.max(0.5, crop.width * width), Math.max(0.5, crop.height * height));
						context.clip();
					}
					context.translate(box.x + box.width / 2, box.y + box.height / 2);
					if (box.rotation !== 0) context.rotate((box.rotation * Math.PI) / 180);
					const mask = clipMaskOf(clip);
					const blendMode = clipBlendMode(clip);
					if (blendMode !== 'normal' && isFullFrameBlendClip(clip)) {
						context.globalCompositeOperation = CANVAS_BLEND_MODES[blendMode] || 'source-over';
					}
					const drawContent = () => {
					if (clip.type === 'text') {
						drawTextClip(context, clip, box);
					} else if (clip.type === 'caption') {
						drawCaptionClip(context, clip, relative, box);
					} else if (clip.type === 'motion') {
						drawMotionClip(context, clip, relative, box, project);
					} else if (clip.type === 'video' && elements && elements.video) {
						const video = elements.video;
						if (video.readyState >= 2 && video.videoWidth > 0) {
							if (crop) {
								context.drawImage(
									video,
									crop.x * video.videoWidth,
									crop.y * video.videoHeight,
									Math.max(1, crop.width * video.videoWidth),
									Math.max(1, crop.height * video.videoHeight),
									-box.width / 2,
									-box.height / 2,
									box.width,
									box.height,
								);
							} else {
								context.drawImage(video, -box.width / 2, -box.height / 2, box.width, box.height);
							}
						}
					} else if (clip.type === 'image' && elements && elements.image) {
						const image = elements.image;
						if (image.complete && image.naturalWidth > 0) {
							if (crop) {
								context.drawImage(
									image,
									crop.x * image.naturalWidth,
									crop.y * image.naturalHeight,
									Math.max(1, crop.width * image.naturalWidth),
									Math.max(1, crop.height * image.naturalHeight),
									-box.width / 2,
									-box.height / 2,
									box.width,
									box.height,
								);
							} else {
								context.drawImage(image, -box.width / 2, -box.height / 2, box.width, box.height);
							}
						}
					} else if (clip.type === 'lottie') {
						const asset = lottiePreviewCache.get(clip.mediaId);
						const source = asset && asset.status === 'ready' ? getLottieCanvas(asset.animation) : null;
						if (source) {
							const sourceWidth = Math.max(1, Number(source.width) || box.width);
							const sourceHeight = Math.max(1, Number(source.height) || box.height);
							try {
								asset.animation.goToAndStop(
									clipSourceSeconds(clip, frame, Math.max(1, Number(project.fps) || 30)),
									true,
								);
							} catch (error) {
								/* keep the previous lottie frame */
							}
							if (crop) {
								context.drawImage(
									source,
									crop.x * sourceWidth,
									crop.y * sourceHeight,
									Math.max(1, crop.width * sourceWidth),
									Math.max(1, crop.height * sourceHeight),
									-box.width / 2,
									-box.height / 2,
									box.width,
									box.height,
								);
							} else {
								context.drawImage(source, -box.width / 2, -box.height / 2, box.width, box.height);
							}
						}
					}
					};
					if (mask && !mask.invert && mask.feather > 0.001) {
						const bands = 4;
						context.save();
						applyClipMask(context, mask, box, 1 - mask.feather);
						drawContent();
						context.restore();
						for (let band = 1; band < bands; band += 1) {
							const outerShrink = 1 - mask.feather * ((band - 1) / bands);
							const innerShrink = 1 - mask.feather * (band / bands);
							context.save();
							applyMaskRing(context, mask, box, outerShrink, innerShrink);
							context.globalAlpha = opacity * (band / bands);
							drawContent();
							context.restore();
						}
					} else {
						if (mask) applyClipMask(context, mask, box, 1);
						drawContent();
					}
					try {
						context.filter = 'none';
					} catch (error) {
						/* ignore */
					}
					context.restore();
				}
			}
			context.restore();
		}

		function useElementSize(ref) {
			const [size, setSize] = React.useState({ width: 0, height: 0 });
			React.useEffect(() => {
				const element = ref.current;
				if (!element || typeof element.getBoundingClientRect !== 'function') return undefined;
				const measure = () => {
					const rect = element.getBoundingClientRect();
					setSize((previous) => {
						if (Math.abs(previous.width - rect.width) < 0.5 && Math.abs(previous.height - rect.height) < 0.5) return previous;
						return { width: rect.width, height: rect.height };
					});
				};
				measure();
				if (typeof ResizeObserver === 'undefined') return undefined;
				const observer = new ResizeObserver(measure);
				observer.observe(element);
				return () => observer.disconnect();
			}, [ref]);
			return size;
		}

		// -------------------------------------------------------------------
		// Styles — one scoped sheet, `.ots-` classes, `--dsw-alias-*` tokens only
		// -------------------------------------------------------------------

		const STYLES = `
.ots-root{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;position:relative;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.45}
.ots-root *{box-sizing:border-box}
.ots-root button{font:inherit;color:inherit}
.ots-root input,.ots-root textarea,.ots-root select{font:inherit;color:var(--dsw-alias-label-primary)}
.ots-root ::-webkit-scrollbar{width:10px;height:10px}
.ots-root ::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:6px;border:2px solid transparent;background-clip:padding-box}
.ots-root ::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-secondary);background-clip:padding-box}
.ots-topbar{align-items:center;background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex;flex:0 0 auto;gap:10px;min-height:46px;padding:calc(6px + var(--dsh-frame-top-clearance,0px)) 10px 6px}
.ots-brand{align-items:center;display:flex;gap:8px;min-width:0;flex:1 1 auto}
.ots-brand-glyph{color:var(--dsw-alias-brand-primary);display:inline-flex;flex:0 0 auto}
.ots-glyph{display:block;flex:0 0 auto}
.ots-brand-text{display:flex;flex-direction:column;min-width:0;line-height:1.2}
.ots-project-name{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-project-path{color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.ots-top-actions{align-items:center;display:flex;flex:0 0 auto;gap:4px}
.ots-status{align-items:center;display:flex;flex:0 0 auto;gap:8px}
.ots-btn{border:.5px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 9px;font-size:12.5px;white-space:nowrap}
.ots-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ots-btn:active:not(:disabled){background:var(--dsw-alias-bg-overlay)}
.ots-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ots-btn:disabled{opacity:.42;cursor:default}
.ots-root .ots-btn-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.ots-root .ots-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);filter:brightness(1.05)}
.ots-root .ots-btn-primary:active:not(:disabled){filter:brightness(.96)}
.ots-btn-outline{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ots-btn-toolbar{background:var(--dsw-alias-bg-layer-2)}
.ots-btn-toolbar:hover:not(:disabled){background:var(--dsw-alias-bg-overlay)}
.ots-btn-icon{width:28px;padding:0}
.ots-btn[data-active="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.ots-pill{align-items:center;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);display:inline-flex;font-size:11px;gap:5px;height:22px;padding:0 8px;white-space:nowrap}
.ots-pill-dot{background:var(--dsw-alias-state-idle-primary);border-radius:50%;height:6px;width:6px}
.ots-pill[data-ok="true"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.ots-pill[data-ok="true"] .ots-pill-dot{background:var(--dsw-alias-state-success-primary)}
.ots-pill[data-ok="false"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.ots-pill[data-ok="false"] .ots-pill-dot{background:var(--dsw-alias-state-warn-primary)}
.ots-export-progress{align-items:center;display:flex;gap:6px;min-width:120px}
.ots-export-track{background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:5px;width:80px;overflow:hidden}
.ots-export-bar{background:var(--dsw-alias-brand-primary);height:100%;border-radius:999px;transition:width .2s linear}
.ots-export-text{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.ots-banners{display:flex;flex-direction:column;flex:0 0 auto}
.ots-banner{align-items:flex-start;display:flex;font-size:12.5px;gap:8px;padding:7px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.ots-banner-error{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}
.ots-banner-warn{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);color:var(--dsw-alias-label-primary)}
.ots-banner-info{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ots-banner-text{flex:1 1 auto;overflow-wrap:anywhere}
.ots-banner-close{align-self:center;background:none;border:0;color:inherit;cursor:pointer;font-size:16px;height:20px;line-height:1;opacity:.7;padding:0;width:20px}
.ots-banner-close:hover{opacity:1}
.ots-loading{align-items:center;color:var(--dsw-alias-label-secondary);display:flex;flex:1 1 auto;flex-direction:column;gap:12px;justify-content:center}
.ots-spinner{border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;height:22px;width:22px;animation:ots-spin .8s linear infinite}
@keyframes ots-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ots-spinner{animation:none}.ots-export-bar{transition:none}}
.ots-welcome{align-items:center;display:flex;flex:1 1 auto;justify-content:center;min-height:0;padding:24px;background:var(--dsw-alias-bg-base)}
.ots-welcome-card{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;display:flex;flex-direction:column;gap:12px;max-width:520px;padding:28px 30px;width:100%}
.ots-welcome-glyph{color:var(--dsw-alias-brand-primary)}
.ots-welcome-title{margin:0;font-size:22px;font-weight:650;letter-spacing:.2px}
.ots-welcome-lead{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px}
.ots-welcome-actions{display:flex;gap:8px;margin-top:4px}
.ots-recent{border-top:.5px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:4px;margin-top:8px;max-height:280px;overflow:auto;padding-top:8px}
.ots-recent[data-compact="true"]{max-height:200px}
.ots-recent-head{align-items:center;display:flex;gap:6px;justify-content:space-between}
.ots-recent-title{color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:600;letter-spacing:.3px;text-transform:uppercase}
.ots-recent-actions{display:flex;gap:3px}
.ots-recent-list{display:flex;flex-direction:column;gap:3px;overflow:auto}
.ots-recent-row{align-items:center;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:5px;color:inherit;cursor:pointer;display:flex;font-family:inherit;gap:6px;min-width:0;padding:4px 6px;text-align:left;width:100%}
.ots-recent-row:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.ots-recent-row[data-missing="true"]{border-color:var(--dsw-alias-state-error-primary);cursor:not-allowed;opacity:.85}
.ots-recent-main{display:flex;flex:1 1 auto;flex-direction:column;gap:1px;min-width:0}
.ots-recent-name{color:var(--dsw-alias-label-primary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-recent-path,.ots-recent-meta{color:var(--dsw-alias-label-secondary);font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-recent-missing{background:var(--dsw-alias-state-error-primary);border-radius:3px;color:var(--dsw-alias-bg-base);flex:0 0 auto;font-size:8px;padding:1px 4px;text-transform:uppercase}
.ots-recent-confirm{align-items:center;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-state-error-primary);border-radius:5px;display:flex;flex-wrap:wrap;font-size:10px;gap:4px;justify-content:space-between;padding:4px 6px}
.ots-welcome-note{border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;margin:4px 0 0;padding-top:10px}
.ots-welcome-note[data-warn="true"]{color:var(--dsw-alias-state-warn-primary)}
.ots-body{display:grid;flex:1 1 auto;grid-template-columns:236px minmax(0,1fr) 272px;min-height:0}
.ots-panel{background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;min-height:0;min-width:0}
.ots-panel-head{align-items:center;border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex;flex:0 0 auto;gap:6px;padding:8px 10px}
.ots-panel-title{font-size:12px;font-weight:600;letter-spacing:.35px;text-transform:uppercase;color:var(--dsw-alias-label-secondary);flex:1 1 auto}
.ots-panel-sub{color:var(--dsw-alias-label-secondary);font-size:11px}
.ots-panel-body{flex:1 1 auto;min-height:0;overflow:auto;padding:8px}
.ots-media{border-right:.5px solid var(--dsw-alias-border-l2)}
.ots-media-grid{display:grid;gap:8px;grid-template-columns:repeat(2,minmax(0,1fr))}
.ots-media-card{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:grab;display:flex;flex-direction:column;min-width:0;overflow:hidden;padding:0;position:relative;transition:border-color .12s}
.ots-media-card:hover{border-color:var(--dsw-alias-border-l1)}
.ots-media-card[data-selected="true"]{border-color:var(--dsw-alias-brand-primary)}
.ots-media-thumb{align-items:center;aspect-ratio:16/9;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);display:flex;justify-content:center;overflow:hidden;position:relative}
.ots-media-thumb img{height:100%;object-fit:cover;width:100%;display:block}
.ots-media-glyph{font-size:11px;font-weight:700;letter-spacing:.5px}
.ots-media-meta{display:flex;flex-direction:column;gap:1px;min-width:0;padding:5px 7px 6px}
.ots-media-name{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-media-sub{color:var(--dsw-alias-label-secondary);display:flex;font-size:10.5px;gap:5px;min-width:0}
.ots-proxy-badge{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-brand-primary);font-size:9px;letter-spacing:.3px;padding:1px 6px;text-transform:uppercase}
.ots-media-card[data-missing="true"] .ots-media-thumb{box-shadow:inset 0 0 0 1.5px var(--dsw-alias-state-error-primary)}
.ots-media-card[data-missing="true"]{border-color:var(--dsw-alias-state-error-primary)}
.ots-media-offline{background:var(--dsw-alias-state-error-primary);border-radius:3px;color:var(--dsw-alias-bg-base);font-size:8px;left:4px;letter-spacing:.3px;padding:1px 4px;position:absolute;text-transform:uppercase;top:4px;z-index:3}
.ots-clip[data-offline="true"]{border-color:var(--dsw-alias-state-error-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-error-primary)}
.ots-clip-offline-badge{background:var(--dsw-alias-state-error-primary);border-radius:2px;color:var(--dsw-alias-bg-base);font-size:8px;line-height:11px;margin-right:3px;padding:0 3px;pointer-events:none}
.ots-media-warning{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-state-error-primary);border-radius:6px;color:var(--dsw-alias-state-error-primary);font-size:10.5px;line-height:1.4;margin:0 0 6px;padding:6px 7px}
.ots-missing-overlay{align-items:center;background:var(--dsw-alias-bg-overlay);display:flex;flex-direction:column;gap:3px;inset:0;justify-content:center;padding:12px;position:absolute;text-align:center;z-index:2}
.ots-missing-overlay-title{color:var(--dsw-alias-state-error-primary);font-size:12px;font-weight:600}
.ots-missing-overlay-hint{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.4}
.ots-proxy-chip{background:var(--dsw-alias-bg-overlay);border-radius:3px;bottom:4px;color:var(--dsw-alias-label-primary);font-size:8px;left:4px;letter-spacing:.3px;padding:1px 4px;position:absolute;text-transform:uppercase;z-index:2}
.ots-media-add{background:var(--dsw-alias-bg-overlay);border:0;border-radius:5px;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:14px;height:22px;line-height:1;opacity:0;position:absolute;right:4px;top:4px;width:22px;transition:opacity .12s}
.ots-media-card:hover .ots-media-add,.ots-media-add:focus-visible{opacity:1}
.ots-media-empty{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;padding:18px 10px;text-align:center}
.ots-media-tabs{background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex;flex:0 0 auto;gap:2px;padding:4px 8px 0}
.ots-media-tab{background:none;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:1 1 0;font-size:11.5px;height:26px;padding:0 6px}
.ots-media-tab:hover{color:var(--dsw-alias-label-primary)}
.ots-media-tab[data-active="true"]{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600}
.ots-library-panel{display:flex;flex-direction:column;gap:8px;min-width:0}
.ots-library-toolbar{display:flex;flex-direction:column;gap:5px}
.ots-library-folders{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;margin-bottom:6px;padding:4px 5px}
.ots-library-folder-head{align-items:center;display:flex;gap:4px;justify-content:space-between;padding:1px 2px 3px}
.ots-folder-list{display:flex;flex-direction:column;gap:1px;max-height:168px;overflow:auto}
.ots-folder-row{align-items:center;border-radius:4px;display:flex;gap:2px;min-width:0;padding:1px 3px}
.ots-folder-row[data-active="true"]{background:var(--dsw-alias-bg-layer-2)}
.ots-folder-row:hover .ots-folder-actions,.ots-folder-row:focus-within .ots-folder-actions{opacity:1}
.ots-folder-toggle{align-items:center;background:none;border:0;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;flex:0 0 auto;font-size:9px;height:15px;justify-content:center;padding:0;width:14px}
.ots-folder-name{background:none;border:0;color:var(--dsw-alias-label-primary);cursor:pointer;flex:1 1 auto;font-family:inherit;font-size:10.5px;min-width:0;overflow:hidden;padding:0 1px;text-align:left;text-overflow:ellipsis;white-space:nowrap}
.ots-folder-actions{display:flex;flex:0 0 auto;gap:1px;opacity:0}
.ots-folder-actions .ots-mini{font-size:9px;height:16px;padding:0 3px}
.ots-library-search-row{display:grid;gap:4px;grid-template-columns:minmax(0,1fr) auto auto}
.ots-library-search-row .ots-input,.ots-library-search-row .ots-select{height:24px;font-size:11px}
.ots-library-actions-row{align-items:center;display:flex;flex-wrap:wrap;gap:4px}
.ots-library-card .ots-library-actions-row{padding:0 6px 6px}
.ots-library-card .ots-library-actions-row .ots-mini{font-size:9.5px;height:18px;padding:0 4px}
.ots-library-status{align-items:center;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;font-size:11.5px;gap:8px;padding:16px 8px;text-align:center}
.ots-library-error{color:var(--dsw-alias-state-error-primary)}
.ots-library-error .ots-btn{align-self:center}
.ots-library-star{background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l1);border-radius:50%;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;height:20px;left:4px;line-height:1;padding:0;position:absolute;top:4px;width:20px;z-index:2}
.ots-library-star[data-active="true"]{color:var(--dsw-alias-state-warn-primary)}
.ots-library-star:disabled{opacity:.5;cursor:default}
.ots-library-category{color:var(--dsw-alias-label-secondary);display:inline-block;max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-library-card .ots-library-actions-row .ots-mini{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-modal-fixed{position:fixed}
.ots-lottie-thumb{display:block;height:100%;object-fit:cover;width:100%}
.ots-lottie-fallback{align-items:center;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);display:flex;font-size:9px;height:100%;justify-content:center;line-height:1.3;padding:4px;text-align:center;width:100%}
.ots-media-actions{display:flex;gap:3px;padding:0 6px 6px;flex-wrap:wrap}
.ots-media-actions .ots-mini{font-size:9.5px;height:18px;max-width:100%;overflow:hidden;padding:0 4px;text-overflow:ellipsis;white-space:nowrap}
.ots-media-note{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.45;margin:0 0 6px;padding:6px 7px}
.ots-search{display:flex;flex-direction:column;gap:5px;margin-bottom:7px}
.ots-search-row{display:flex;gap:4px}
.ots-search-row .ots-input{flex:1 1 auto;height:24px;font-size:11px}
.ots-search-error{color:var(--dsw-alias-state-error-primary);font-size:10.5px;margin:0}
.ots-search-results{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;max-height:210px;overflow:auto;padding:3px}
.ots-search-group{display:flex;flex-direction:column;gap:1px;margin-bottom:3px}
.ots-search-group-title{color:var(--dsw-alias-label-secondary);font-size:9px;letter-spacing:.35px;padding:2px 4px;text-transform:uppercase}
.ots-search-result{background:none;border:0;border-radius:4px;color:inherit;cursor:pointer;display:flex;flex-direction:column;gap:0;padding:3px 5px;text-align:left;width:100%}
.ots-search-result:hover{background:var(--dsw-alias-bg-layer-2)}
.ots-search-result-name{color:var(--dsw-alias-label-primary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-search-result-snippet{color:var(--dsw-alias-label-secondary);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-search-result-time{color:var(--dsw-alias-label-secondary);font-size:9.5px;font-variant-numeric:tabular-nums}
.ots-transcript-preview{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;display:flex;flex-direction:column;gap:3px;margin-bottom:7px;padding:6px 7px}
.ots-transcript-preview-head{align-items:center;display:flex;gap:6px;justify-content:space-between}
.ots-transcript-preview-head strong{color:var(--dsw-alias-label-primary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-transcript-preview-seg{color:var(--dsw-alias-label-secondary);display:flex;font-size:10px;gap:5px;line-height:1.35}
.ots-transcript-preview-time{color:var(--dsw-alias-label-secondary);flex:0 0 auto;font-variant-numeric:tabular-nums}
.ots-asr-card{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;display:flex;flex-direction:column;gap:4px;margin-bottom:7px;padding:7px}
.ots-asr-head{align-items:center;display:flex;gap:6px;justify-content:space-between}
.ots-asr-title{color:var(--dsw-alias-label-primary);font-size:11.5px;font-weight:600}
.ots-asr-details{display:flex;flex-direction:column;gap:2px}
.ots-asr-row{display:flex;font-size:9.5px;gap:6px;justify-content:space-between;min-width:0}
.ots-asr-key{color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.ots-asr-value{color:var(--dsw-alias-label-primary);overflow:hidden;text-align:right;text-overflow:ellipsis;white-space:nowrap}
.ots-library-group-title{color:var(--dsw-alias-label-secondary);flex:1 1 auto;font-size:10px;letter-spacing:.3px;text-transform:uppercase}
.ots-transcript-list{display:flex;flex-direction:column;gap:5px}
.ots-transcript-row{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;display:flex;flex-direction:column;gap:3px;padding:6px 7px}
.ots-transcript-row-head{align-items:center;display:flex;gap:6px;justify-content:space-between;min-width:0}
.ots-transcript-name{color:var(--dsw-alias-label-primary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-transcript-meta{color:var(--dsw-alias-label-secondary);font-size:9.5px}
.ots-transcript-snippet{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.4;margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ots-transcripts{display:flex;flex-direction:column;gap:5px}
.ots-generate{display:flex;flex-direction:column;gap:6px}
.ots-generate-card{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;display:flex;flex-direction:column;gap:5px;padding:7px}
.ots-generate-head{align-items:center;display:flex;gap:6px;justify-content:space-between;min-width:0}
.ots-generate-title{color:var(--dsw-alias-label-primary);font-size:11.5px;font-weight:600}
.ots-generate-provider{align-items:center;display:grid;font-size:9.5px;gap:4px;grid-template-columns:auto minmax(0,1fr) auto}
.ots-generate-provider-name{color:var(--dsw-alias-label-secondary)}
.ots-generate-provider-id{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-vision-panel{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;display:flex;flex-direction:column;gap:3px;margin-bottom:7px;max-height:190px;overflow:auto;padding:6px 7px}
.ots-vision-row{border-bottom:.5px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:1px;padding:2px 0}
.ots-vision-row:last-child{border-bottom:0}
.ots-vision-name{color:var(--dsw-alias-label-primary);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-vision-desc{color:var(--dsw-alias-label-secondary);display:-webkit-box;font-size:9.5px;line-height:1.35;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:3}
.ots-generate-error{color:var(--dsw-alias-state-error-primary);font-size:10.5px;line-height:1.4;margin:0;overflow-wrap:anywhere}
.ots-generate-actions{display:flex;gap:5px;justify-content:flex-end}
.ots-generate textarea{min-height:54px}
.ots-generate .ots-field-grid{grid-template-columns:1fr 1fr}



.ots-media-empty-title{color:var(--dsw-alias-label-secondary);display:block;font-weight:600;margin-bottom:4px}
.ots-drop-hint{border:.5px dashed var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:8px;padding:10px;text-align:center}
.ots-center{background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;min-height:0;min-width:0}
.ots-stage{align-items:center;background:var(--dsw-alias-bg-base);display:flex;flex:1 1 auto;justify-content:center;min-height:0;min-width:0;padding:14px}
.ots-canvas-wrap{background:#000;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;box-shadow:0 8px 30px color-mix(in srgb,var(--dsw-alias-bg-overlay) 62%,transparent);overflow:hidden;position:relative}
.ots-canvas{display:block;height:100%;width:100%}
.ots-canvas-hint{color:var(--dsw-alias-label-secondary);font-size:11px;left:8px;position:absolute;bottom:6px;pointer-events:none}
.ots-preview-controls{align-items:center;border-top:.5px solid var(--dsw-alias-border-l2);display:flex;flex:0 0 auto;gap:8px;min-height:40px;padding:5px 10px}
.ots-control-spacer{flex:1 1 auto}
.ots-timecode{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ots-frame-count{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ots-range{-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer;height:16px;width:100%;margin:0}
.ots-range::-webkit-slider-runnable-track{background:var(--dsw-alias-bg-overlay);border-radius:999px;height:4px}
.ots-range::-webkit-slider-thumb{-webkit-appearance:none;background:var(--dsw-alias-brand-primary);border:0;border-radius:50%;height:12px;margin-top:-4px;width:12px}
.ots-range:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ots-volume{width:84px}
.ots-inspector{border-left:.5px solid var(--dsw-alias-border-l2)}
.ots-inspector .ots-panel-body{padding:10px}
.ots-section{border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:8px;padding:10px 0}
.ots-section:first-child{padding-top:2px}
.ots-section:last-child{border-bottom:0}
.ots-section-title{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;margin:0}
.ots-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.ots-field-label{color:var(--dsw-alias-label-secondary);font-size:11px}
.ots-field-hint{color:var(--dsw-alias-label-secondary);font-size:10.5px}
.ots-field-row{align-items:center;display:flex;gap:8px;min-width:0}
.ots-field-row .ots-field-label{flex:1 1 auto}
.ots-field-grid{display:grid;gap:6px;grid-template-columns:1fr 1fr}
.ots-value{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ots-input,.ots-select,.ots-textarea{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:5px;color:var(--dsw-alias-label-primary);height:26px;min-width:0;outline:none;padding:0 7px;width:100%;font-size:12px}
.ots-input:focus,.ots-select:focus,.ots-textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-brand-primary)}
.ots-textarea{height:auto;min-height:64px;padding:6px 7px;resize:vertical;line-height:1.45}
.ots-select{appearance:none;padding-right:20px}
.ots-input[type="color"]{padding:2px;cursor:pointer}
.ots-kv{display:flex;flex-direction:column;gap:4px}
.ots-kv-row{align-items:baseline;display:flex;gap:10px;min-width:0}
.ots-kv-key{color:var(--dsw-alias-label-secondary);flex:0 0 82px;font-size:11px}
.ots-kv-value{color:var(--dsw-alias-label-primary);font-size:11.5px;overflow-wrap:anywhere;flex:1 1 auto;min-width:0}
.ots-shortcut{align-items:baseline;display:flex;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ots-shortcut-key{border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;padding:1px 5px;white-space:nowrap}
.ots-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;margin:0}
.ots-empty-line{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin:6px 0 0}
.ots-timeline{background:var(--dsw-alias-bg-layer-1);border-top:.5px solid var(--dsw-alias-border-l2);display:flex;flex:0 0 254px;flex-direction:column;min-height:150px;min-width:0}
.ots-timeline-toolbar{align-items:center;border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex;flex:0 0 auto;gap:3px;padding:4px 8px;min-height:34px;overflow-x:auto;overflow-y:hidden}
.ots-timeline-spacer{flex:1 1 auto}
.ots-timeline-zoom{color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;min-width:38px;text-align:center}
.ots-timeline-scroll{flex:1 1 auto;min-height:0;overflow:auto;position:relative}
.ots-timeline-content{min-width:100%;position:relative;width:max-content}
.ots-ruler{display:flex;height:26px;position:sticky;top:0;z-index:4;background:var(--dsw-alias-bg-layer-1)}
.ots-ruler-head{background:var(--dsw-alias-bg-layer-1);border-right:.5px solid var(--dsw-alias-border-l2);flex:0 0 132px;position:sticky;left:0;z-index:6;display:flex;align-items:center;padding:0 8px;color:var(--dsw-alias-label-secondary);font-size:10px;letter-spacing:.3px;text-transform:uppercase}
.ots-ruler-lane{flex:0 0 auto;position:relative;height:26px;cursor:pointer;background:var(--dsw-alias-bg-layer-1)}
.ots-ruler-lane:hover{background:var(--dsw-alias-bg-layer-2)}
.ots-ruler-tick{border-left:.5px solid var(--dsw-alias-border-l2);bottom:0;position:absolute;top:9px}
.ots-ruler-tick[data-major="true"]{border-color:var(--dsw-alias-border-l1);top:4px}
.ots-ruler-label{color:var(--dsw-alias-label-secondary);font-size:9.5px;left:3px;position:absolute;top:1px;white-space:nowrap;font-variant-numeric:tabular-nums}
.ots-track{display:flex;height:58px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.ots-track:last-child{border-bottom:0}
.ots-track-head{background:var(--dsw-alias-bg-layer-1);border-right:.5px solid var(--dsw-alias-border-l2);display:flex;flex:0 0 132px;flex-direction:column;justify-content:center;gap:2px;min-width:0;padding:2px 6px;position:sticky;left:0;z-index:3}
.ots-track-head-row{align-items:center;display:flex;gap:2px;min-width:0}
.ots-track-name-btn{background:none;border:0;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:1 1 auto;font-size:11px;line-height:1.2;min-width:0;overflow:hidden;padding:0;text-align:left;text-overflow:ellipsis;white-space:nowrap}
.ots-track-name-btn:hover{color:var(--dsw-alias-label-primary)}
.ots-track-name-input{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-brand-primary);border-radius:3px;color:var(--dsw-alias-label-primary);flex:1 1 auto;font-size:10.5px;height:17px;min-width:0;outline:none;padding:0 3px}
.ots-track-actions{display:flex;flex:0 0 auto;gap:1px}
.ots-track-icon{background:transparent;border:0;border-radius:3px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:9px;font-weight:600;height:15px;line-height:1;padding:0;width:15px}
.ots-track-icon:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ots-track-icon[data-active="true"]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-brand-primary)}
.ots-track-icon[data-danger="true"]:hover{color:var(--dsw-alias-state-error-primary)}
.ots-track-volume{align-items:center;display:flex;gap:3px;min-width:0}
.ots-track-volume-range{-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer;flex:1 1 auto;height:10px;margin:0;min-width:0;padding:0}
.ots-track-volume-range::-webkit-slider-runnable-track{background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:3px}
.ots-track-volume-range::-webkit-slider-thumb{-webkit-appearance:none;background:var(--dsw-alias-brand-primary);border:0;border-radius:50%;height:8px;margin-top:-2.5px;width:8px}
.ots-track-volume-range:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ots-track-volume-label{color:var(--dsw-alias-label-secondary);flex:0 0 auto;font-size:8.5px;font-variant-numeric:tabular-nums;min-width:25px;text-align:right}

.ots-track[data-muted="true"] .ots-track-lane{opacity:.62}
.ots-track[data-hidden="true"] .ots-track-lane{opacity:.38}
.ots-track[data-hidden="true"] .ots-track-name-btn{color:var(--dsw-alias-label-secondary);text-decoration:line-through}
.ots-track-confirm{align-items:center;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-state-error-primary);border-radius:4px;display:flex;flex-direction:column;gap:2px;inset:1px;justify-content:center;padding:2px;position:absolute;z-index:4}
.ots-track-confirm-text{color:var(--dsw-alias-label-primary);font-size:9px;line-height:1.15;text-align:center}
.ots-track-confirm-actions{display:flex;gap:3px}
.ots-track-confirm .ots-mini{font-size:9px;height:16px;padding:0 4px}
.ots-export-grid{display:grid;gap:8px;grid-template-columns:1fr 1fr}
.ots-export-toggles{display:flex;flex-wrap:wrap;gap:4px 12px}
.ots-export-summary{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;padding:6px 8px}
.ots-export-check{align-items:center;display:flex;gap:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11.5px}
.ots-export-check input{accent-color:var(--dsw-alias-brand-primary);margin:0}
.ots-export-custom{display:grid;gap:6px;grid-template-columns:1fr 1fr;grid-column:1/-1}
.ots-track-name{color:var(--dsw-alias-label-secondary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-track-kind{color:var(--dsw-alias-label-secondary);font-size:10px;letter-spacing:.25px;text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-track-badges{display:flex;flex:0 0 auto;gap:1px}
.ots-track-role-badge,.ots-track-duck-badge{background:var(--dsw-alias-bg-layer-2);border-radius:3px;color:var(--dsw-alias-label-secondary);font-size:7.5px;line-height:11px;padding:0 2px}
.ots-track-duck-badge{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.ots-track-mix-row{align-items:center;display:flex;gap:3px;min-width:0}
.ots-track-role{align-items:center;display:flex;flex:0 0 auto;gap:2px}
.ots-track-role-select{font-size:8.5px;height:16px;padding:0 1px;width:46px}
.ots-track-ducking{font-size:8.5px;height:16px;padding:0 3px}
.ots-track-ducking[data-active="true"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.ots-track-mix-row .ots-track-volume{flex:1 1 auto}

.ots-track-lane{flex:0 0 auto;position:relative;background:var(--dsw-alias-bg-base);background-image:linear-gradient(to right,var(--dsw-alias-border-l2) .5px,transparent .5px);background-size:calc(var(--ots-grid,60px)) 100%;cursor:default}
.ots-track-lane:hover{background-color:var(--dsw-alias-bg-layer-1)}
.ots-clip{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:5px;cursor:grab;display:flex;align-items:center;height:40px;margin-top:6px;min-width:2px;overflow:hidden;position:absolute;top:0;user-select:none}
.ots-clip[data-kind="video"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1))}
.ots-clip[data-kind="audio"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,var(--dsw-alias-border-l1))}
.ots-clip[data-kind="image"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1))}
.ots-clip[data-kind="text"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 38%,var(--dsw-alias-border-l1))}
.ots-clip[data-selected="true"]{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1.5px var(--dsw-alias-brand-primary) inset}
.ots-clip[data-dragging="true"]{opacity:.9;cursor:grabbing}
.ots-clip-label{color:var(--dsw-alias-label-primary);font-size:10.5px;line-height:1.15;overflow:hidden;padding:0 9px;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;pointer-events:none}
.ots-clip-handle{cursor:ew-resize;position:absolute;top:0;bottom:0;width:7px;z-index:2}
.ots-clip-handle-start{left:0}
.ots-clip-handle-end{right:0}
.ots-clip-handle:hover{background:var(--dsw-alias-bg-layer-2)}
.ots-playhead{background:var(--dsw-alias-brand-primary);bottom:0;pointer-events:none;position:absolute;top:0;width:1.5px;z-index:5}
.ots-playhead::before{content:"";position:absolute;left:-4.5px;top:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:8px solid var(--dsw-alias-brand-primary)}
.ots-timeline-empty{align-items:center;bottom:0;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:2px;justify-content:center;left:132px;position:absolute;right:0;top:26px;pointer-events:none;text-align:center;font-size:12px}
.ots-timeline-content{min-height:100%}
.ots-timeline-empty strong{color:var(--dsw-alias-label-secondary);font-weight:600}
.ots-modal-backdrop{align-items:center;background:var(--dsw-alias-bg-overlay);display:flex;inset:0;justify-content:center;padding:24px;position:absolute;z-index:40}
.ots-modal{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 18px 60px color-mix(in srgb,var(--dsw-alias-bg-overlay) 75%,transparent);display:flex;flex-direction:column;gap:12px;max-width:480px;padding:18px;width:100%}
.ots-modal-title{margin:0;font-size:15px;font-weight:600}
.ots-modal-body{display:flex;flex-direction:column;gap:10px}
.ots-modal-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:0}
.ots-modal-hint{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin:0}
.ots-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}
.ots-modal-path-row{display:flex;gap:6px}
.ots-modal-path-row .ots-input{flex:1 1 auto}
.ots-settings{height:100%;overflow:auto;padding:calc(28px + var(--dsh-frame-top-clearance,0px)) 32px 48px}
.ots-settings-inner{display:flex;flex-direction:column;gap:22px;max-width:760px;margin:0 auto}
.ots-settings h2{margin:0;font-size:20px;font-weight:600}
.ots-settings h3{margin:0;font-size:13px;font-weight:600}
.ots-settings p{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55}
.ots-settings-section{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;display:flex;flex-direction:column;gap:8px;padding:14px 16px}
.ots-settings-row{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:6px 0}
.ots-settings-row:last-child{border-bottom:0}
.ots-settings-row span:first-child{color:var(--dsw-alias-label-secondary)}
.ots-settings-row span:last-child{color:var(--dsw-alias-label-primary);text-align:right;overflow-wrap:anywhere}
.ots-settings code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px}
.ots-media-cache{position:absolute;left:-10000px;top:0;width:320px;height:180px;overflow:hidden;opacity:0;pointer-events:none}
@media (max-width:1180px){.ots-body{grid-template-columns:206px minmax(0,1fr) 244px}.ots-media-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:980px){.ots-body{grid-template-columns:190px minmax(0,1fr)}.ots-inspector{display:none}.ots-project-path{display:none}}
.ots-marker{align-items:center;background:var(--dsw-alias-state-warn-primary);border-radius:2px;bottom:0;cursor:pointer;display:flex;justify-content:center;position:absolute;top:0;width:3px;z-index:6}
.ots-marker:hover{background:var(--dsw-alias-state-error-primary)}
.ots-marker-label{background:var(--dsw-alias-state-warn-primary);border-radius:3px;color:var(--dsw-alias-bg-base);font-size:9px;left:0;max-width:90px;overflow:hidden;padding:0 3px;position:absolute;text-overflow:ellipsis;top:-2px;white-space:nowrap}
.ots-transition-flag{background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-brand-primary);border-radius:3px;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:8.5px;height:14px;line-height:13px;min-width:14px;overflow:hidden;padding:0 2px;position:absolute;text-align:center;top:3px;z-index:3}
.ots-transition-flag:hover{color:var(--dsw-alias-label-primary)}
.ots-clip[data-kind="caption"]{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 18%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 45%,var(--dsw-alias-border-l1))}
.ots-subhead{align-items:center;display:flex;gap:6px;justify-content:space-between;margin:0}
.ots-subhead .ots-section-title{flex:1 1 auto}
.ots-inline-group{display:flex;flex-wrap:wrap;gap:4px}
.ots-mini{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:4px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;height:22px;line-height:1;padding:0 6px}
.ots-mini:hover:not(:disabled){background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
.ots-mini:disabled{opacity:.4;cursor:default}
.ots-mini[data-danger="true"]:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.ots-mini[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ots-color-input{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:4px;cursor:pointer;height:24px;padding:1px;width:38px}
.ots-check{align-items:center;display:flex;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ots-check input{accent-color:var(--dsw-alias-brand-primary);margin:0}
.ots-effect{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;display:flex;flex-direction:column;gap:5px;padding:6px 7px}
.ots-effect-head{align-items:center;display:flex;gap:5px}
.ots-effect-name{flex:1 1 auto;font-size:11.5px;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-effect-params{display:grid;gap:5px;grid-template-columns:1fr 1fr}
.ots-effect-params .ots-field{grid-column:auto}
.ots-effect-note{color:var(--dsw-alias-label-secondary);font-size:10px;margin:0}
.ots-keyframe-row{align-items:center;display:grid;gap:4px;grid-template-columns:1fr 1fr 1fr 20px}
.ots-keyframe-row .ots-input,.ots-keyframe-row .ots-select{height:22px;font-size:11px;padding:0 4px}
.ots-caption-segment{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;display:flex;flex-direction:column;gap:4px;padding:6px}
.ots-caption-segment .ots-textarea{min-height:36px}
.ots-marker-row{align-items:center;display:grid;gap:4px;grid-template-columns:52px 1fr 26px 22px 22px}
.ots-marker-row .ots-input{height:22px;font-size:11px;padding:0 4px}
.ots-marker-row .ots-input[type="color"]{padding:1px;width:22px}
.ots-transition-row{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;display:flex;flex-direction:column;gap:4px;padding:6px}
.ots-transition-head{align-items:center;display:flex;gap:5px}
.ots-transition-name{color:var(--dsw-alias-label-secondary);flex:1 1 auto;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-note{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.45;margin:0}
.ots-note[data-warn="true"]{color:var(--dsw-alias-state-warn-primary)}
`;

		// -------------------------------------------------------------------
		// Dictionaries
		// -------------------------------------------------------------------

		const en = {
			'meta.title': 'OpenTake Studio',
			'panel': 'OpenTake Studio',
			'settings.nav': 'OpenTake Studio',
			'settings.title': 'OpenTake Studio',
			'settings.lead': 'A native video editor inside DeepSeek Harness: project, media, timeline, preview, export and agent editing tools. No external editor process and no MCP bridge.',
			'settings.dependencies': 'Dependencies',
			'settings.ffmpeg': 'ffmpeg / ffprobe',
			'settings.dependencyHint': 'Import and export use the Host ffmpeg binary. Install it on PATH or set OPENTAKE_STUDIO_FFMPEG and OPENTAKE_STUDIO_FFPROBE.',
			'settings.shortcuts': 'Keyboard shortcuts',
			'settings.storage': 'Storage',
			'settings.storageHint': 'A project is a folder you choose. It contains opentake-studio.json, media/, thumbnails/ and exports/.',
			'settings.previewNote': 'The canvas preview is an approximate composite of the timeline; the ffmpeg export is authoritative.',
			'settings.rows': 'Works without an OpenTake or Tauri process; the editor runs from DSH Host routes.',
			'actions.new': 'New',
			'actions.open': 'Open',
			'actions.save': 'Save',
			'actions.undo': 'Undo',
			'actions.redo': 'Redo',
			'actions.export': 'Export',
			'actions.cancelExport': 'Cancel export',
			'actions.add': 'Add',
			'actions.cancel': 'Cancel',
			'actions.close': 'Close',
			'actions.browse': 'Browse…',
			'ffmpeg.ready': 'ffmpeg ready',
			'ffmpeg.missing': 'ffmpeg missing',
			'ffmpeg.readyTitle': 'ffmpeg {version}',
			'ffmpeg.missingTitle': 'ffmpeg was not found on the Host; import and export are unavailable.',
			'project.noProject': 'No project open',
			'project.noProjectHint': 'Create or open a project folder to start editing.',
			'project.untitled': 'Untitled project',
			'project.folder': 'Folder',
			'project.fps': 'Frame rate',
			'project.resolution': 'Resolution',
			'project.duration': 'Duration',
			'project.tracks': 'Tracks',
			'project.media': 'Media',
			'project.updated': 'Last updated',
			'project.ffmpegVersion': 'ffmpeg version',
			'project.saveError': 'Auto-save failed: {message}',
			'project.lastError': 'Last edit error: {message}',
			'project.saveOk': 'Project saved.',
			'welcome.title': 'OpenTake Studio',
			'welcome.lead': 'A native video editor inside DeepSeek Harness — project, media library, timeline, preview and export, with only the Host routes.',
			'welcome.new': 'New project',
			'welcome.open': 'Open project',
			'welcome.dependency': 'Import and export need ffmpeg on the Host.',
			'welcome.ffmpegMissing': 'ffmpeg was not found. You can open a project and edit the timeline, but import and export are unavailable.',
			'welcome.loading': 'Loading OpenTake Studio…',
			'media.title': 'Media',
			'media.import': 'Import folder',
			'media.empty': 'No media yet',
			'media.emptyHint': 'Import a folder of videos, audio and images, or drop files here.',
			'media.dropHint': 'Drop files to upload',
			'media.addToTimeline': 'Add to timeline',
			'media.video': 'Video',
			'media.audio': 'Audio',
			'media.image': 'Image',
			'media.still': 'Still',
			'media.importing': 'Importing…',
			'media.imported': 'Imported {count} file(s); skipped {skipped}.',
			'media.uploading': 'Uploading {name}…',
			'media.uploadDone': 'Uploaded {count} file(s).',
			'media.missing': 'Missing media file',
			'media.glyphAudio': 'AUDIO',
			'media.glyphImage': 'IMAGE',
			'media.glyphVideo': 'VIDEO',
			'preview.play': 'Play',
			'preview.pause': 'Pause',
			'preview.loop': 'Loop',
			'preview.volume': 'Preview volume',
			'preview.mute': 'Mute preview',
			'preview.unmute': 'Unmute preview',
			'preview.canvas': 'Preview canvas',
			'preview.emptyFrame': 'No visual clips at this frame',
			'preview.controls': 'Playback controls',
			'timeline.title': 'Timeline',
			'timeline.zoomIn': 'Zoom in',
			'timeline.zoomOut': 'Zoom out',
			'timeline.fit': 'Fit',
			'timeline.split': 'Split at playhead',
			'timeline.delete': 'Delete clip',
			'timeline.addVideoTrack': 'Add video track',
			'timeline.addAudioTrack': 'Add audio track',
			'timeline.addText': 'Add text',
			'timeline.empty': 'Timeline is empty',
			'timeline.emptyHint': 'Double-click a media item, or drag it onto a track.',
			'timeline.noTracks': 'No tracks yet — add a track or drop media.',
			'timeline.videoTrack': 'Video',
			'timeline.audioTrack': 'Audio',
			'timeline.clipCount': '{count} clip(s)',
			'timeline.splitDisabled': 'Place the playhead inside the selected clip.',
			'timeline.deleteDisabled': 'Select a clip first.',
			'timeline.shortcutHint': 'Drag to move · drag edges to trim · click the ruler to seek',
			'timeline.ruler': 'Timeline ruler',
			'timeline.track': 'Track {name}',
			'timeline.zoomValue': '{percent}%',
			'inspector.title': 'Inspector',
			'inspector.nothing': 'Nothing selected',
			'inspector.nothingHint': 'Select a clip to edit volume, opacity, transform or text.',
			'inspector.project': 'Project settings',
			'inspector.clip': 'Clip',
			'inspector.kindVideo': 'Video clip',
			'inspector.kindAudio': 'Audio clip',
			'inspector.kindImage': 'Image clip',
			'inspector.kindText': 'Text clip',
			'inspector.timing': 'Timing',
			'inspector.start': 'Start',
			'inspector.duration': 'Duration',
			'inspector.trim': 'Source offset',
			'inspector.end': 'End',
			'inspector.volume': 'Volume',
			'inspector.opacity': 'Opacity',
			'inspector.transform': 'Transform',
			'inspector.x': 'X',
			'inspector.y': 'Y',
			'inspector.width': 'Width',
			'inspector.height': 'Height',
			'inspector.rotation': 'Rotation',
			'inspector.normalized': 'Normalized 0–1',
			'inspector.text': 'Text',
			'inspector.content': 'Content',
			'inspector.fontSize': 'Font size',
			'inspector.color': 'Color',
			'inspector.fontWeight': 'Weight',
			'inspector.align': 'Alignment',
			'inspector.weightRegular': 'Regular',
			'inspector.weightSemibold': 'Semibold',
			'inspector.weightBold': 'Bold',
			'inspector.alignLeft': 'Left',
			'inspector.alignCenter': 'Center',
			'inspector.alignRight': 'Right',
			'inspector.shortcuts': 'Keyboard shortcuts',
			'inspector.shortcutPlay': 'Space — play / pause',
			'inspector.shortcutDelete': 'Delete — remove the selected clip',
			'inspector.shortcutUndo': 'Cmd/Ctrl+Z — undo',
			'inspector.shortcutRedo': 'Shift+Cmd/Ctrl+Z — redo',
			'inspector.shortcutSplit': 'Cmd/Ctrl+K — split at the playhead',
			'inspector.addText': 'Add text at playhead',
			'inspector.defaultText': 'Text',
			'inspector.readonly': 'Timing is edited by dragging clips and clip edges on the timeline.',
			'dialog.newTitle': 'New project',
			'dialog.openTitle': 'Open project',
			'dialog.importTitle': 'Import media folder',
			'dialog.exportTitle': 'Export video',
			'dialog.folder': 'Project folder',
			'dialog.mediaFolder': 'Media folder',
			'dialog.outputFile': 'Output file',
			'dialog.projectName': 'Project name',
			'dialog.projectNamePlaceholder': 'My project',
			'dialog.create': 'Create project',
			'dialog.open': 'Open project',
			'dialog.import': 'Import',
			'dialog.export': 'Start export',
			'dialog.newHint': 'The project is stored as opentake-studio.json inside this folder.',
			'dialog.openHint': 'Select the project folder that contains opentake-studio.json.',
			'dialog.importHint': 'Every video, audio and image file in this folder is imported and probed.',
			'dialog.exportHint': 'Leave the file empty to export into the project exports folder.',
			'dialog.pathHint': 'Absolute path on the Host.',
			'dialog.pathPlaceholder': '/absolute/path',
			'dialog.outputPlaceholder': 'exports/…',
			'dialog.pickerUnavailable': 'The native folder picker is unavailable here; type a path instead.',
			'dialog.requiredPath': 'An absolute folder path is required.',
			'dialog.requiredOutput': 'The output path must be an absolute file path or empty.',
			'dialog.working': 'Working…',
			'error.action': 'The action failed: {message}',
			'error.network': 'Could not reach the OpenTake Studio Host routes. Check that the plugin is installed and the Host is running.',
			'error.export': 'Export failed: {message}',
			'error.dismiss': 'Dismiss',
			'error.browser': 'This browser could not decode a media file.',
			'error.noProject': 'Open or create a project first.',
			'status.exporting': 'Exporting {percent}%',
			'status.exportStarted': 'Export started.',
			'status.exportDone': 'Export finished: {path}',
			'status.exportDoneNoPath': 'Export finished.',
			'status.exportCancelled': 'Export cancelled.',
			'status.saved': 'Project saved.',
			'status.undo': 'Undone.',
			'status.redo': 'Redone.',
			'status.deleted': 'Clip deleted.',
			'status.split': 'Clip split.',
			'status.trackAdded': 'Track added.',
			'status.trackRemoved': 'Track removed.',
			'status.textAdded': 'Text clip added.',
			'status.clipAdded': 'Clip added to the timeline.',
			'status.loading': 'Loading…',
			'inspector.kindCaption': 'Caption clip',
			'inspector.speed': 'Speed',
			'inspector.speedValue': '{value}×',
			'inspector.speedHint': 'Changes the timeline length while keeping the same source range.',
			'inspector.fades': 'Fades',
			'inspector.fadeIn': 'Fade in (frames)',
			'inspector.fadeOut': 'Fade out (frames)',
			'inspector.fadesHint': '0 … clip length; visual is from/to black, audio is volume.',
			'inspector.keyframes': 'Keyframes',
			'inspector.keyframeProperty': 'Property',
			'inspector.keyframeFrame': 'Frame',
			'inspector.keyframeValue': 'Value',
			'inspector.keyframeEasing': 'Easing',
			'inspector.addKeyframe': 'Add keyframe at playhead',
			'inspector.removeKeyframe': 'Remove keyframe',
			'inspector.keyframesEmpty': 'No keyframes yet — add one at the playhead.',
			'inspector.keyframesHint': 'Frames are relative to the clip start; values override the static property.',
			'inspector.effects': 'Effects',
			'inspector.effectsAdd': 'Add effect',
			'inspector.effectsEmpty': 'No effects.',
			'inspector.effectsEnable': 'Enabled',
			'inspector.effectsRemove': 'Remove effect',
			'inspector.effectsUp': 'Move effect up',
			'inspector.effectsDown': 'Move effect down',
			'inspector.effectsPreviewSkipped': 'Approximated/skipped in preview: {types}',
			'inspector.transitions': 'Transitions',
			'inspector.transitionsEmpty': 'Select a video clip next to another clip to add a transition.',
			'inspector.transitionsBefore': 'Incoming boundary',
			'inspector.transitionsAfter': 'Outgoing boundary',
			'inspector.transitionsDuration': 'Duration (frames)',
			'inspector.transitionsType': 'Type',
			'inspector.transitionsAdd': 'Add transition',
			'inspector.transitionsRemove': 'Remove transition',
			'inspector.transitionsHint': 'Transitions need two adjacent clips on the same video track. Wipe/dissolve previews are approximate.',
			'inspector.captions': 'Captions',
			'inspector.captionsAdd': 'Add caption at playhead',
			'inspector.captionsEmpty': 'No caption clip selected.',
			'inspector.captionsSegments': 'Segments',
			'inspector.captionsSegmentStart': 'Start',
			'inspector.captionsSegmentDuration': 'Duration',
			'inspector.captionsSegmentText': 'Text',
			'inspector.captionsAddSegment': 'Add segment',
			'inspector.captionsRemoveSegment': 'Remove segment',
			'inspector.captionsStyle': 'Caption style',
			'inspector.captionsFontSize': 'Font size',
			'inspector.captionsColor': 'Color',
			'inspector.captionsWeight': 'Weight',
			'inspector.captionsAlign': 'Alignment',
			'inspector.captionsBackground': 'Background',
			'inspector.captionsImport': 'Import SRT/VTT',
			'inspector.captionsExportSrt': 'Export SRT',
			'inspector.captionsExportVtt': 'Export VTT',
			'inspector.captionsHint': 'Segments use frames relative to the caption clip.',
			'inspector.markers': 'Markers',
			'inspector.markersAdd': 'Add marker at playhead',
			'inspector.markersEmpty': 'No project markers.',
			'inspector.markersFrame': 'Frame',
			'inspector.markersLabel': 'Label',
			'inspector.markersColor': 'Color',
			'inspector.markersJump': 'Jump to marker',
			'inspector.markersRemove': 'Remove marker',
			'inspector.markersDefaultLabel': 'Marker',
			'inspector.multiHint': '{count} clips selected; inspector edits the primary clip.',
			'effect.typeBrightness': 'Brightness',
			'effect.typeContrast': 'Contrast',
			'effect.typeSaturation': 'Saturation',
			'effect.typeTemperature': 'Temperature',
			'effect.typeBlur': 'Blur',
			'effect.typeSharpen': 'Sharpen',
			'effect.typeChromaKey': 'Chroma key',
			'effect.typeLut': 'LUT',
			'effect.paramAmount': 'Amount',
			'effect.paramRadius': 'Radius',
			'effect.paramKeyColor': 'Key color',
			'effect.paramSimilarity': 'Similarity',
			'effect.paramBlend': 'Blend',
			'effect.paramFile': 'LUT file (.cube)',
			'effect.previewSkipChromaKey': 'Chroma key is export-only in this preview.',
			'effect.previewSkipLut': 'LUT is export-only in this preview; the file path is relative to the project luts/ folder.',
			'transition.dissolve': 'Dissolve',
			'transition.fadeToBlack': 'Fade to black',
			'transition.wipeLeft': 'Wipe left',
			'transition.wipeRight': 'Wipe right',
			'easing.linear': 'Linear',
			'easing.easeIn': 'Ease in',
			'easing.easeOut': 'Ease out',
			'easing.easeInOut': 'Ease in-out',
			'timeline.snap': 'Snap',
			'timeline.addMarker': 'Add marker',
			'timeline.rippleDelete': 'Ripple delete',
			'timeline.copy': 'Copy',
			'timeline.paste': 'Paste',
			'timeline.selectAll': 'Select all',
			'timeline.markerTitle': 'Marker: {label}',
			'timeline.transitionTitle': 'Transition: {type} ({duration} frames)',
			'status.copied': 'Copied {count} clip(s).',
			'status.copyEmpty': 'Select a clip to copy.',
			'status.pasteEmpty': 'Copy a clip first.',
			'status.pasted': 'Pasted {count} clip(s).',
			'status.rippleDeleted': 'Rippled {count} clip(s).',
			'status.markerAdded': 'Marker added.',
			'status.markerRemoved': 'Marker removed.',
			'status.captionsImported': 'Captions imported.',
			'status.captionsExported': 'Captions exported.',
			'status.captionAdded': 'Caption clip added.',
			'status.keyframesSaved': 'Keyframes updated.',
			'status.effectAdded': 'Effect added.',
			'status.transitionAdded': 'Transition added.',
			'error.captions': 'Could not handle the caption file: {message}',
			'timeline.muteTrack': 'Mute track',
			'timeline.unmuteTrack': 'Unmute track',
			'timeline.hideTrack': 'Hide track',
			'timeline.showTrack': 'Show track',
			'timeline.renameTrack': 'Rename track',
			'timeline.deleteTrack': 'Delete track',
			'timeline.confirmDeleteTrack': 'Delete this track and all its clips?',
			'timeline.deleteConfirm': 'Delete',
			'timeline.muted': 'muted',
			'timeline.hidden': 'hidden',
			'export.settings': 'Export settings',
			'export.codec': 'Codec',
			'export.codecH264': 'H.264',
			'export.codecH265': 'H.265',
			'export.resolution': 'Resolution',
			'export.resProject': 'Project ({width}×{height})',
			'export.res1080p': '1080p',
			'export.res720p': '720p',
			'export.resCustom': 'Custom',
			'export.fps': 'Frame rate',
			'export.fpsProject': 'Project ({fps} fps)',
			'export.quality': 'Quality',
			'export.qualityCrf': 'CRF',
			'export.qualityBitrate': 'Bitrate',
			'export.crf': 'CRF (0–51)',
			'export.bitrate': 'Bitrate',
			'export.bitratePlaceholder': '8M',
			'export.customWidth': 'Width',
			'export.customHeight': 'Height',
			'export.overwrite': 'Overwrite an existing file',
			'export.summary': '{codec} · {width}×{height} · {fps} fps · {quality}',
			'export.summaryCrf': 'CRF {value}',
			'export.summaryBitrate': '{value}',
			'export.invalidSize': 'Custom width and height must be positive whole numbers.',
			'export.invalidBitrate': 'Enter a bitrate such as 8M or 6000k.',
			'export.estimated': 'Estimated settings',
			'library.tabProject': 'Project',
			'library.tabLibrary': 'Library',
			'library.search': 'Search name, category or tags',
			'library.kind': 'Media kind',
			'library.kindAll': 'All kinds',
			'library.favoritesOnly': 'Favorites only',
			'library.import': 'Import folder',
			'library.importing': 'Importing…',
			'library.imported': 'Imported {count} item(s) into the library; skipped {skipped}.',
			'library.empty': 'Library is empty',
			'library.emptyHint': 'Import a folder to build a reusable global media library.',
			'library.loading': 'Loading library…',
			'library.retry': 'Retry',
			'library.error': 'Library error: {message}',
			'library.favorite': 'Add to favorites',
			'library.unfavorite': 'Remove from favorites',
			'library.addToProject': 'Add to project',
			'library.added': 'Added “{name}” to the project.',
			'library.edit': 'Edit library item',
			'library.editTitle': 'Edit library item',
			'library.name': 'Name',
			'library.nameRequired': 'A name is required.',
			'library.category': 'Category',
			'library.tags': 'Tags',
			'library.tagsPlaceholder': 'outdoor, b-roll',
			'library.save': 'Save',
			'library.updated': 'Library item updated.',
			'library.delete': 'Delete library item',
			'library.deleteTitle': 'Delete library item',
			'library.deleteConfirm': 'Delete',
			'library.deleted': 'Library item deleted.',
			'library.importFolder': 'Folder path',
			'library.importHint': 'Every video, audio and image file in the folder is imported into the global library.',
			'library.importConfirm': 'Import',
			'library.working': 'Working…',
			'common.yes': 'Yes',
			'common.no': 'No',
			'transcribe.tabTranscripts': 'Transcripts',
			'transcribe.action': 'Transcribe',
			'transcribe.actionTitle': 'Transcribe with captions added to the timeline',
			'transcribe.onlyTitle': 'Transcribe without adding captions',
			'transcribe.busy': 'Transcribing…',
			'transcribe.done': 'Transcript ready for {name}.',
			'transcribe.captionsAdded': 'Transcript ready for {name}; captions were added to the timeline.',
			'transcribe.captionsCreated': 'Caption clip created from {name}.',
			'transcribe.noCaptions': 'Transcript ready for {name}.',
			'transcribe.noTranscriptPreview': 'The transcript is stored but no preview is available.',
			'transcribe.emptyTranscript': 'The transcript has no usable segments.',
			'transcribe.error': 'Transcription failed for {name}: {message}',
			'transcribe.preview': 'Transcript · {name}',
			'transcribe.closePreview': 'Close transcript preview',
			'transcribe.asrTitle': 'Speech recognition',
			'transcribe.asrReady': 'Configured',
			'transcribe.asrMissing': 'Not configured',
			'transcribe.asrHint': 'Configure ASR on the Host: set {keyRef} (API key) or OPENTAKE_STUDIO_ASR_URL for a loopback Whisper-compatible endpoint, then reload the Host.',
			'transcribe.asrUnknown': 'ASR status is unavailable; transcribe may still work if the Host is configured.',
			'transcribe.endpoint': 'Endpoint',
			'transcribe.model': 'Model',
			'transcribe.language': 'Language',
			'transcribe.keyRef': 'Key reference',
			'transcribe.loopback': 'Loopback',
			'transcribe.transcriptsTitle': 'Transcripts',
			'transcribe.refresh': 'Refresh',
			'transcribe.loading': 'Loading transcripts…',
			'transcribe.empty': 'No transcripts yet',
			'transcribe.emptyHint': 'Transcribe a video or audio asset from the Project tab.',
			'transcribe.segmentCount': '{count} segment(s)',
			'transcribe.createCaptions': 'Create captions',
			'transcribe.loadError': 'Could not load transcripts: {message}',
			'search.placeholder': 'Search media and transcripts',
			'search.action': 'Search',
			'search.clear': 'Clear',
			'search.loading': 'Searching…',
			'search.error': 'Search failed: {message}',
			'search.noResults': 'No results for “{query}”.',
			'search.transcripts': 'Transcripts',
			'search.media': 'Media',
			'generate.tab': 'Generate',
			'generate.providers': 'Generation providers',
			'generate.imageProvider': 'Image',
			'generate.speechProvider': 'Speech',
			'generate.configured': 'Configured',
			'generate.notConfigured': 'Not configured',
			'generate.unknown': 'Generation status unavailable.',
			'generate.hint': 'Configure OpenAI generation on the Host: set OPENAI_API_KEY (optionally OPENAI_BASE_URL) or store the credential in DSH, then reload the Host.',
			'generate.working': 'Generating…',
			'generate.imageTitle': 'Generate image',
			'generate.imagePrompt': 'Image prompt',
			'generate.imagePromptPlaceholder': 'Describe the image to generate…',
			'generate.imageSize': 'Size',
			'generate.imageAction': 'Generate image',
			'generate.imageDone': 'Image generated and added to the project media.',
			'generate.speechTitle': 'Generate speech',
			'generate.speechText': 'Speech text',
			'generate.speechTextPlaceholder': 'Enter the text to speak…',
			'generate.voice': 'Voice',
			'generate.model': 'Model (optional)',
			'generate.modelPlaceholder': 'Provider default model',
			'generate.speechAction': 'Generate speech',
			'generate.speechDone': 'Speech generated and added to the project media.',
			'generate.error': 'Generation failed: {message}',
			'inspector.crop': 'Crop',
			'inspector.cropReset': 'Reset crop',
			'inspector.cropX': 'Crop X',
			'inspector.cropY': 'Crop Y',
			'inspector.cropWidth': 'Crop width',
			'inspector.cropHeight': 'Crop height',
			'inspector.cropHint': 'Normalized source crop; independent of the transform. Cropped clips fall back from true transitions to the fade approximation.',
			'export.codecProres': 'ProRes (.mov)',
			'export.codecVp9': 'VP9 / WebM (.webm)',
			'export.extensionHint': 'Output extension: {ext}',
			'export.proresHint': 'ProRes ignores the CRF value (profile/bitrate based).',
			'inspector.mask': 'Mask',
			'inspector.maskReset': 'Reset mask',
			'inspector.maskShape': 'Shape',
			'inspector.maskX': 'Mask X',
			'inspector.maskY': 'Mask Y',
			'inspector.maskWidth': 'Mask width',
			'inspector.maskHeight': 'Mask height',
			'inspector.maskFeather': 'Feather',
			'inspector.maskInvert': 'Invert mask',
			'inspector.maskHint': 'Mask is applied inside the transform box after crop/scale, before overlay. Feather is approximated in the canvas preview.',
			'inspector.blend': 'Blend',
			'inspector.blendMode': 'Blend mode',
			'inspector.blendHint': 'Full-frame clips (no transform/crop/mask) blend with the layers below in the preview.',
			'inspector.blendFallback': 'This clip is transformed/cropped/masked, so the preview falls back to normal overlay; the export may blend when applicable.',
			'mask.rect': 'Rectangle',
			'mask.ellipse': 'Ellipse',
			'blend.normal': 'Normal',
			'blend.screen': 'Screen',
			'blend.multiply': 'Multiply',
			'blend.overlay': 'Overlay',
			'blend.darken': 'Darken',
			'blend.lighten': 'Lighten',
			'blend.add': 'Add',
			'blend.difference': 'Difference',
			'timeline.trackVolume': 'Track volume',
			'library.folders': 'Folders',
			'library.newFolder': 'New folder',
			'library.allFolders': 'All',
			'library.rootFolder': 'Root',
			'library.expandFolder': 'Expand folder',
			'library.collapseFolder': 'Collapse folder',
			'library.renameFolder': 'Rename folder',
			'library.deleteFolder': 'Delete folder',
			'library.createFolderTitle': 'New folder',
			'library.renameFolderTitle': 'Rename folder',
			'library.folderName': 'Folder name',
			'library.folderParent': 'Parent folder',
			'library.createFolder': 'Create',
			'library.deleteFolderTitle': 'Delete folder',
			'library.deleteFolderHint': 'Child folders and items are moved to the parent folder.',
			'library.deleteFolderConfirm': 'Delete folder',
			'library.move': 'Move to folder',
			'library.moveTitle': 'Move to folder',
			'library.moveTo': 'Destination',
			'library.moveConfirm': 'Move',
			'library.moved': 'Moved {name}.',
			'library.folderCreated': 'Folder created.',
			'library.folderUpdated': 'Folder updated.',
			'library.folderDeleted': 'Folder deleted.',
			'timeline.trackRole': 'Track role',
			'timeline.ducking': 'Ducking',
			'timeline.duckingHint': 'Attenuate this track while a voice-role track has audio at the playhead.',
			'role.voice': 'Voice',
			'role.music': 'Music',
			'role.sfx': 'SFX',
			'role.other': 'Other',
			'role.short.voice': 'V',
			'role.short.music': 'M',
			'role.short.sfx': 'S',
			'role.short.other': 'O',
			'generate.videoProvider': 'Video',
			'generate.videoTitle': 'Generate video',
			'generate.videoPrompt': 'Video prompt',
			'generate.videoPromptPlaceholder': 'Describe the shot to generate…',
			'generate.aspectRatio': 'Aspect ratio',
			'generate.duration': 'Duration',
			'generate.duration5': '5 seconds',
			'generate.duration10': '10 seconds',
			'generate.videoAction': 'Generate video',
			'generate.videoDone': 'Video generated and added to the project media.',
			'vision.title': 'Visual descriptions',
			'vision.index': 'Describe',
			'vision.indexTitle': 'Describe this visual with the configured vision model (adds it to search).',
			'vision.indexing': 'Describing…',
			'vision.indexed': 'Visual description added for {name}.',
			'vision.error': 'Visual indexing failed: {message}',
			'vision.hint': 'Configure OPENAI_API_KEY (or a DSH credential) on the Host to describe and search visuals.',
			'vision.refresh': 'Refresh',
			'search.vision': 'Visual matches',
			'proxy.toggle': 'Proxy preview',
			'proxy.toggleTitle': 'Preview videos through low-resolution proxies (export still uses originals).',
			'proxy.badge': 'Proxy',
			'proxy.badgeTitle': 'Preview is using a low-resolution proxy; export uses the original.',
			'proxy.fallback': 'Proxy preview failed for {name}; falling back to the original.',
			'proxy.generate': 'Proxy',
			'proxy.generating': 'Proxy…',
			'proxy.generateTitle': 'Generate a low-resolution preview proxy now (export uses the original).',
			'proxy.generated': 'Preview proxy ready for {name}.',
			'proxy.generateError': 'Could not generate a proxy for {name}: {message}',
			'media.offline': 'Offline',
			'media.missingPreview': 'Media missing',
			'media.missingPreviewHint': 'Relink this asset from the media panel to preview it.',
			'media.missingInspector': 'Media missing — relink the asset from the media panel.',
			'media.missingDetected': 'Media file missing: {name}.',
			'media.relink': 'Relink',
			'media.relinkError': 'Relink failed: {message}',
			'media.relinkTitle': 'Relink media',
			'media.relinkPath': 'New file path',
			'media.relinkPathRequired': 'Enter an absolute file path.',
			'media.relinkConfirm': 'Relink',
			'media.relinkHint': 'Enter an absolute path to an existing media file. Clips keep the same id and timing.',
			'media.relinked': 'Relinked {name}.',
			'export.codecProres4444': 'ProRes 4444 (.mov, alpha)',
			'export.transparent': 'Transparent background',
			'export.transparentHint': 'Render a transparent base; ProRes 4444 keeps the alpha channel.',
			'export.bitDepth10': '10-bit',
			'export.bitDepthHint': '10-bit output is available for H.265, VP9 and ProRes (ignored for H.264).',
			'export.colorPrimaries': 'Primaries',
			'export.colorTrc': 'Transfer',
			'export.colorspace': 'Color space',
			'export.colorAuto': 'Default',
			'export.primaries709': 'BT.709',
			'export.primaries2020': 'BT.2020',
			'export.trcSdr': 'SDR (BT.709)',
			'export.trcPq': 'PQ (HDR10)',
			'export.trcHlg': 'HLG',
			'export.space709': 'BT.709',
			'export.space2020': 'BT.2020',
			'export.colorHint': 'Optional color metadata tags; leave on Default unless the delivery requires them.',
			'preview.stepBack': 'Step back one frame',
			'preview.stepForward': 'Step forward one frame',
			'inspector.shortcutStep': '← / → — step one frame',
			'media.lottie': 'Lottie',
			'lottie.loading': 'Loading Lottie…',
			'lottie.unavailable': 'Lottie unavailable',
			'status.preparingLottie': 'Rendering Lottie frame {index}/{total} for {name}…',
			'inspector.kindLottie': 'Lottie clip',
			'welcome.recentTitle': 'Recent projects',
			'welcome.recentRefresh': 'Refresh',
			'welcome.recentClear': 'Clear',
			'welcome.recentLoading': 'Loading recent projects…',
			'welcome.recentEmpty': 'No recent projects yet.',
			'welcome.recentMissing': 'Missing',
			'welcome.recentMissingHint': 'Project folder or opentake-studio.json is missing.',
			'welcome.recentClearConfirm': 'Clear the recent projects list?',
			'welcome.recentCleared': 'Recent projects cleared.',
			'welcome.recentOpened': 'Opened {name}.',
			'preview.exportFrame': 'Export frame',
			'preview.exportFrameTitle': 'Export the current composited preview frame as PNG.',
			'preview.frameExported': 'Exported {file}.',
			'preview.exportFrameError': 'Could not export the frame: {message}',
			'timeline.addMotion': 'Add motion',
			'motion.addTitle': 'Add motion template',
			'motion.addAction': 'Add motion',
			'motion.added': 'Motion clip added.',
			'motion.addFailed': 'Could not add the motion clip.',
			'motion.template': 'Template',
			'motion.templateTitle': 'Title',
			'motion.templateLowerThird': 'Lower third',
			'motion.templateCallout': 'Callout',
			'motion.text': 'Text',
			'motion.textPlaceholder': 'Motion text…',
			'motion.textDefault': 'Your title',
			'motion.subtitle': 'Subtitle',
			'motion.subtitlePlaceholder': 'Optional subtitle…',
			'motion.color': 'Text color',
			'motion.accentColor': 'Accent color',
			'motion.fontSize': 'Font size',
			'motion.align': 'Align',
			'motion.alignLeft': 'Left',
			'motion.alignCenter': 'Center',
			'motion.alignRight': 'Right',
			'motion.background': 'Background panel',
			'motion.duration': 'Duration (frames)',
			'motion.durationSeconds': 'Duration (seconds)',
			'motion.hint': 'Canvas-rendered template clip; frames are pre-rendered before export like Lottie.',
			'inspector.motion': 'Motion template',
			'inspector.kindMotion': 'Motion clip',
			'status.preparingMotion': 'Rendering motion frame {index}/{total} for {name}…',
			'status.preparingText': 'Preparing text…',
			'dialog.preparingText': 'Rendering text overlays for export…',
		};

		const zh = {
			'meta.title': 'OpenTake Studio',
			'panel': 'OpenTake Studio',
			'settings.nav': 'OpenTake Studio',
			'settings.title': 'OpenTake Studio',
			'settings.lead': 'DeepSeek Harness 内的原生视频编辑器：工程、媒体、时间线、预览、导出和 Agent 编辑工具，不需要外部编辑器进程，也不经过 MCP。',
			'settings.dependencies': '依赖',
			'settings.ffmpeg': 'ffmpeg / ffprobe',
			'settings.dependencyHint': '导入和导出使用 Host 上的 ffmpeg。请安装到 PATH，或设置 OPENTAKE_STUDIO_FFMPEG 与 OPENTAKE_STUDIO_FFPROBE。',
			'settings.shortcuts': '键盘快捷键',
			'settings.storage': '存储',
			'settings.storageHint': '工程就是你选择的文件夹，包含 opentake-studio.json、media/、thumbnails/ 和 exports/。',
			'settings.previewNote': '画布预览是时间线的近似合成，以 ffmpeg 导出结果为准。',
			'settings.rows': '无需 OpenTake 或 Tauri 进程，编辑器完全由 DSH Host 路由驱动。',
			'actions.new': '新建',
			'actions.open': '打开',
			'actions.save': '保存',
			'actions.undo': '撤销',
			'actions.redo': '重做',
			'actions.export': '导出',
			'actions.cancelExport': '取消导出',
			'actions.add': '添加',
			'actions.cancel': '取消',
			'actions.close': '关闭',
			'actions.browse': '浏览…',
			'ffmpeg.ready': 'ffmpeg 可用',
			'ffmpeg.missing': '缺少 ffmpeg',
			'ffmpeg.readyTitle': 'ffmpeg {version}',
			'ffmpeg.missingTitle': 'Host 上未找到 ffmpeg，导入和导出不可用。',
			'project.noProject': '未打开工程',
			'project.noProjectHint': '新建或打开一个工程文件夹开始剪辑。',
			'project.untitled': '未命名工程',
			'project.folder': '文件夹',
			'project.fps': '帧率',
			'project.resolution': '分辨率',
			'project.duration': '时长',
			'project.tracks': '轨道',
			'project.media': '媒体',
			'project.updated': '最近更新',
			'project.ffmpegVersion': 'ffmpeg 版本',
			'project.saveError': '自动保存失败：{message}',
			'project.lastError': '最近一次编辑错误：{message}',
			'project.saveOk': '工程已保存。',
			'welcome.title': 'OpenTake Studio',
			'welcome.lead': 'DeepSeek Harness 内的原生视频编辑器：工程、媒体库、时间线、预览和导出，完全由 Host 路由驱动。',
			'welcome.new': '新建工程',
			'welcome.open': '打开工程',
			'welcome.dependency': '导入和导出需要 Host 上的 ffmpeg。',
			'welcome.ffmpegMissing': '未找到 ffmpeg。你可以打开工程并编辑时间线，但导入和导出不可用。',
			'welcome.loading': '正在加载 OpenTake Studio…',
			'media.title': '媒体',
			'media.import': '导入文件夹',
			'media.empty': '还没有媒体',
			'media.emptyHint': '导入包含视频、音频和图片的文件夹，或把文件拖到这里。',
			'media.dropHint': '拖入文件以上传',
			'media.addToTimeline': '添加到时间线',
			'media.video': '视频',
			'media.audio': '音频',
			'media.image': '图片',
			'media.still': '静帧',
			'media.importing': '正在导入…',
			'media.imported': '已导入 {count} 个文件，跳过 {skipped} 个。',
			'media.uploading': '正在上传 {name}…',
			'media.uploadDone': '已上传 {count} 个文件。',
			'media.missing': '媒体文件缺失',
			'media.glyphAudio': '音频',
			'media.glyphImage': '图片',
			'media.glyphVideo': '视频',
			'preview.play': '播放',
			'preview.pause': '暂停',
			'preview.loop': '循环',
			'preview.volume': '预览音量',
			'preview.mute': '预览静音',
			'preview.unmute': '取消预览静音',
			'preview.canvas': '预览画布',
			'preview.emptyFrame': '当前帧没有可见片段',
			'preview.controls': '播放控制',
			'timeline.title': '时间线',
			'timeline.zoomIn': '放大',
			'timeline.zoomOut': '缩小',
			'timeline.fit': '适配',
			'timeline.split': '在播放头分割',
			'timeline.delete': '删除片段',
			'timeline.addVideoTrack': '添加视频轨道',
			'timeline.addAudioTrack': '添加音频轨道',
			'timeline.addText': '添加文本',
			'timeline.empty': '时间线为空',
			'timeline.emptyHint': '双击媒体素材，或把它拖到轨道上。',
			'timeline.noTracks': '还没有轨道——添加轨道或拖入媒体。',
			'timeline.videoTrack': '视频',
			'timeline.audioTrack': '音频',
			'timeline.clipCount': '{count} 个片段',
			'timeline.splitDisabled': '请把播放头放在所选片段内部。',
			'timeline.deleteDisabled': '请先选择片段。',
			'timeline.shortcutHint': '拖拽移动 · 拖拽两端修剪 · 点击标尺定位',
			'timeline.ruler': '时间线标尺',
			'timeline.track': '轨道 {name}',
			'timeline.zoomValue': '{percent}%',
			'inspector.title': '检查器',
			'inspector.nothing': '未选择片段',
			'inspector.nothingHint': '选择片段以编辑音量、不透明度、变换或文本。',
			'inspector.project': '工程设置',
			'inspector.clip': '片段',
			'inspector.kindVideo': '视频片段',
			'inspector.kindAudio': '音频片段',
			'inspector.kindImage': '图片片段',
			'inspector.kindText': '文本片段',
			'inspector.timing': '时间',
			'inspector.start': '开始',
			'inspector.duration': '长度',
			'inspector.trim': '源偏移',
			'inspector.end': '结束',
			'inspector.volume': '音量',
			'inspector.opacity': '不透明度',
			'inspector.transform': '变换',
			'inspector.x': 'X',
			'inspector.y': 'Y',
			'inspector.width': '宽',
			'inspector.height': '高',
			'inspector.rotation': '旋转',
			'inspector.normalized': '归一化 0–1',
			'inspector.text': '文本',
			'inspector.content': '内容',
			'inspector.fontSize': '字号',
			'inspector.color': '颜色',
			'inspector.fontWeight': '字重',
			'inspector.align': '对齐',
			'inspector.weightRegular': '常规',
			'inspector.weightSemibold': '半粗',
			'inspector.weightBold': '粗体',
			'inspector.alignLeft': '左对齐',
			'inspector.alignCenter': '居中',
			'inspector.alignRight': '右对齐',
			'inspector.shortcuts': '键盘快捷键',
			'inspector.shortcutPlay': '空格 — 播放 / 暂停',
			'inspector.shortcutDelete': 'Delete — 删除所选片段',
			'inspector.shortcutUndo': 'Cmd/Ctrl+Z — 撤销',
			'inspector.shortcutRedo': 'Shift+Cmd/Ctrl+Z — 重做',
			'inspector.shortcutSplit': 'Cmd/Ctrl+K — 在播放头分割',
			'inspector.addText': '在播放头添加文本',
			'inspector.defaultText': '文本',
			'inspector.readonly': '时间信息通过在时间线上拖拽片段和片段两端来编辑。',
			'dialog.newTitle': '新建工程',
			'dialog.openTitle': '打开工程',
			'dialog.importTitle': '导入媒体文件夹',
			'dialog.exportTitle': '导出视频',
			'dialog.folder': '工程文件夹',
			'dialog.mediaFolder': '媒体文件夹',
			'dialog.outputFile': '输出文件',
			'dialog.projectName': '工程名称',
			'dialog.projectNamePlaceholder': '我的工程',
			'dialog.create': '创建工程',
			'dialog.open': '打开工程',
			'dialog.import': '导入',
			'dialog.export': '开始导出',
			'dialog.newHint': '工程会以 opentake-studio.json 保存在此文件夹中。',
			'dialog.openHint': '选择包含 opentake-studio.json 的工程文件夹。',
			'dialog.importHint': '文件夹中所有视频、音频和图片都会被导入并探测。',
			'dialog.exportHint': '留空输出文件则导出到工程的 exports 文件夹。',
			'dialog.pathHint': 'Host 上的绝对路径。',
			'dialog.pathPlaceholder': '/绝对路径',
			'dialog.outputPlaceholder': 'exports/…',
			'dialog.pickerUnavailable': '此处无法使用原生文件夹选择器，请直接输入路径。',
			'dialog.requiredPath': '需要绝对文件夹路径。',
			'dialog.requiredOutput': '输出路径必须为绝对文件路径或留空。',
			'dialog.working': '处理中…',
			'error.action': '操作失败：{message}',
			'error.network': '无法连接 OpenTake Studio 的 Host 路由。请确认插件已安装且 Host 正在运行。',
			'error.export': '导出失败：{message}',
			'error.dismiss': '关闭',
			'error.browser': '此浏览器无法解码某个媒体文件。',
			'error.noProject': '请先打开或新建工程。',
			'status.exporting': '正在导出 {percent}%',
			'status.exportStarted': '已开始导出。',
			'status.exportDone': '导出完成：{path}',
			'status.exportDoneNoPath': '导出完成。',
			'status.exportCancelled': '已取消导出。',
			'status.saved': '工程已保存。',
			'status.undo': '已撤销。',
			'status.redo': '已重做。',
			'status.deleted': '已删除片段。',
			'status.split': '已分割片段。',
			'status.trackAdded': '已添加轨道。',
			'status.trackRemoved': '已删除轨道。',
			'status.textAdded': '已添加文本片段。',
			'status.clipAdded': '已把片段添加到时间线。',
			'status.loading': '加载中…',
			'inspector.kindCaption': '字幕片段',
			'inspector.speed': '速度',
			'inspector.speedValue': '{value}×',
			'inspector.speedHint': '在保持源区间不变的情况下改变时间线时长。',
			'inspector.fades': '淡入淡出',
			'inspector.fadeIn': '淡入（帧）',
			'inspector.fadeOut': '淡出（帧）',
			'inspector.fadesHint': '0 … 片段长度；画面为黑场淡入淡出，音频为音量淡入淡出。',
			'inspector.keyframes': '关键帧',
			'inspector.keyframeProperty': '属性',
			'inspector.keyframeFrame': '帧',
			'inspector.keyframeValue': '值',
			'inspector.keyframeEasing': '缓动',
			'inspector.addKeyframe': '在播放头添加关键帧',
			'inspector.removeKeyframe': '删除关键帧',
			'inspector.keyframesEmpty': '还没有关键帧——在播放头添加一个。',
			'inspector.keyframesHint': '帧相对于片段起点；关键帧值会覆盖静态属性。',
			'inspector.effects': '效果',
			'inspector.effectsAdd': '添加效果',
			'inspector.effectsEmpty': '没有效果。',
			'inspector.effectsEnable': '启用',
			'inspector.effectsRemove': '删除效果',
			'inspector.effectsUp': '上移效果',
			'inspector.effectsDown': '下移效果',
			'inspector.effectsPreviewSkipped': '预览中近似/跳过：{types}',
			'inspector.transitions': '转场',
			'inspector.transitionsEmpty': '选择与另一片段相邻的视频片段以添加转场。',
			'inspector.transitionsBefore': '前接边界',
			'inspector.transitionsAfter': '后接边界',
			'inspector.transitionsDuration': '时长（帧）',
			'inspector.transitionsType': '类型',
			'inspector.transitionsAdd': '添加转场',
			'inspector.transitionsRemove': '删除转场',
			'inspector.transitionsHint': '转场需要同一视频轨道上首尾相邻的两个片段。擦除/溶解预览为近似效果。',
			'inspector.captions': '字幕',
			'inspector.captionsAdd': '在播放头添加字幕',
			'inspector.captionsEmpty': '未选择字幕片段。',
			'inspector.captionsSegments': '分段',
			'inspector.captionsSegmentStart': '开始',
			'inspector.captionsSegmentDuration': '时长',
			'inspector.captionsSegmentText': '文本',
			'inspector.captionsAddSegment': '添加分段',
			'inspector.captionsRemoveSegment': '删除分段',
			'inspector.captionsStyle': '字幕样式',
			'inspector.captionsFontSize': '字号',
			'inspector.captionsColor': '颜色',
			'inspector.captionsWeight': '字重',
			'inspector.captionsAlign': '对齐',
			'inspector.captionsBackground': '背景',
			'inspector.captionsImport': '导入 SRT/VTT',
			'inspector.captionsExportSrt': '导出 SRT',
			'inspector.captionsExportVtt': '导出 VTT',
			'inspector.captionsHint': '分段使用相对于字幕片段的帧。',
			'inspector.markers': '标记',
			'inspector.markersAdd': '在播放头添加标记',
			'inspector.markersEmpty': '没有工程标记。',
			'inspector.markersFrame': '帧',
			'inspector.markersLabel': '标签',
			'inspector.markersColor': '颜色',
			'inspector.markersJump': '跳转到标记',
			'inspector.markersRemove': '删除标记',
			'inspector.markersDefaultLabel': '标记',
			'inspector.multiHint': '已选择 {count} 个片段；检查器编辑主片段。',
			'effect.typeBrightness': '亮度',
			'effect.typeContrast': '对比度',
			'effect.typeSaturation': '饱和度',
			'effect.typeTemperature': '色温',
			'effect.typeBlur': '模糊',
			'effect.typeSharpen': '锐化',
			'effect.typeChromaKey': '抠像',
			'effect.typeLut': 'LUT',
			'effect.paramAmount': '强度',
			'effect.paramRadius': '半径',
			'effect.paramKeyColor': '键控颜色',
			'effect.paramSimilarity': '相似度',
			'effect.paramBlend': '混合',
			'effect.paramFile': 'LUT 文件（.cube）',
			'effect.previewSkipChromaKey': '抠像在预览中仅作导出效果。',
			'effect.previewSkipLut': 'LUT 在预览中仅作导出效果；文件路径相对于工程的 luts/ 目录。',
			'transition.dissolve': '溶解',
			'transition.fadeToBlack': '淡入黑场',
			'transition.wipeLeft': '左擦除',
			'transition.wipeRight': '右擦除',
			'easing.linear': '线性',
			'easing.easeIn': '缓入',
			'easing.easeOut': '缓出',
			'easing.easeInOut': '缓入缓出',
			'timeline.snap': '吸附',
			'timeline.addMarker': '添加标记',
			'timeline.rippleDelete': '波纹删除',
			'timeline.copy': '复制',
			'timeline.paste': '粘贴',
			'timeline.selectAll': '全选',
			'timeline.markerTitle': '标记：{label}',
			'timeline.transitionTitle': '转场：{type}（{duration} 帧）',
			'status.copied': '已复制 {count} 个片段。',
			'status.copyEmpty': '请先选择要复制的片段。',
			'status.pasteEmpty': '请先复制片段。',
			'status.pasted': '已粘贴 {count} 个片段。',
			'status.rippleDeleted': '已波纹删除 {count} 个片段。',
			'status.markerAdded': '已添加标记。',
			'status.markerRemoved': '已删除标记。',
			'status.captionsImported': '字幕已导入。',
			'status.captionsExported': '字幕已导出。',
			'status.captionAdded': '已添加字幕片段。',
			'status.keyframesSaved': '关键帧已更新。',
			'status.effectAdded': '已添加效果。',
			'status.transitionAdded': '已添加转场。',
			'error.captions': '处理字幕文件失败：{message}',
			'timeline.muteTrack': '静音轨道',
			'timeline.unmuteTrack': '取消静音',
			'timeline.hideTrack': '隐藏轨道',
			'timeline.showTrack': '显示轨道',
			'timeline.renameTrack': '重命名轨道',
			'timeline.deleteTrack': '删除轨道',
			'timeline.confirmDeleteTrack': '删除此轨道及其全部片段？',
			'timeline.deleteConfirm': '删除',
			'timeline.muted': '已静音',
			'timeline.hidden': '已隐藏',
			'export.settings': '导出设置',
			'export.codec': '编码',
			'export.codecH264': 'H.264',
			'export.codecH265': 'H.265',
			'export.resolution': '分辨率',
			'export.resProject': '工程（{width}×{height}）',
			'export.res1080p': '1080p',
			'export.res720p': '720p',
			'export.resCustom': '自定义',
			'export.fps': '帧率',
			'export.fpsProject': '工程（{fps} fps）',
			'export.quality': '质量',
			'export.qualityCrf': 'CRF',
			'export.qualityBitrate': '码率',
			'export.crf': 'CRF（0–51）',
			'export.bitrate': '码率',
			'export.bitratePlaceholder': '8M',
			'export.customWidth': '宽',
			'export.customHeight': '高',
			'export.overwrite': '覆盖已存在的文件',
			'export.summary': '{codec} · {width}×{height} · {fps} fps · {quality}',
			'export.summaryCrf': 'CRF {value}',
			'export.summaryBitrate': '{value}',
			'export.invalidSize': '自定义宽高必须为正整数。',
			'export.invalidBitrate': '请输入码率，例如 8M 或 6000k。',
			'export.estimated': '预计设置',
			'library.tabProject': '工程',
			'library.tabLibrary': '素材库',
			'library.search': '搜索名称、分类或标签',
			'library.kind': '媒体类型',
			'library.kindAll': '全部类型',
			'library.favoritesOnly': '仅收藏',
			'library.import': '导入文件夹',
			'library.importing': '正在导入…',
			'library.imported': '已导入 {count} 个素材到素材库，跳过 {skipped} 个。',
			'library.empty': '素材库为空',
			'library.emptyHint': '导入文件夹以建立可复用的全局素材库。',
			'library.loading': '正在加载素材库…',
			'library.retry': '重试',
			'library.error': '素材库错误：{message}',
			'library.favorite': '加入收藏',
			'library.unfavorite': '取消收藏',
			'library.addToProject': '添加到工程',
			'library.added': '已将“{name}”添加到工程。',
			'library.edit': '编辑素材',
			'library.editTitle': '编辑素材',
			'library.name': '名称',
			'library.nameRequired': '名称不能为空。',
			'library.category': '分类',
			'library.tags': '标签',
			'library.tagsPlaceholder': '户外, 空镜',
			'library.save': '保存',
			'library.updated': '素材已更新。',
			'library.delete': '删除素材',
			'library.deleteTitle': '删除素材',
			'library.deleteConfirm': '删除',
			'library.deleted': '素材已删除。',
			'library.importFolder': '文件夹路径',
			'library.importHint': '该文件夹中所有视频、音频和图片都会导入全局素材库。',
			'library.importConfirm': '导入',
			'library.working': '处理中…',
			'common.yes': '是',
			'common.no': '否',
			'transcribe.tabTranscripts': '转写',
			'transcribe.action': '转写',
			'transcribe.actionTitle': '转写并把字幕添加到时间线',
			'transcribe.onlyTitle': '仅转写，不添加字幕',
			'transcribe.busy': '转写中…',
			'transcribe.done': '{name} 的转写已完成。',
			'transcribe.captionsAdded': '{name} 的转写已完成，字幕已添加到时间线。',
			'transcribe.captionsCreated': '已根据 {name} 创建字幕片段。',
			'transcribe.noCaptions': '{name} 的转写已完成。',
			'transcribe.noTranscriptPreview': '转写已保存，但无法显示预览。',
			'transcribe.emptyTranscript': '转写没有可用的分段。',
			'transcribe.error': '{name} 转写失败：{message}',
			'transcribe.preview': '转写 · {name}',
			'transcribe.closePreview': '关闭转写预览',
			'transcribe.asrTitle': '语音识别',
			'transcribe.asrReady': '已配置',
			'transcribe.asrMissing': '未配置',
			'transcribe.asrHint': '请在 Host 上配置 ASR：设置 {keyRef}（API 密钥）或 OPENTAKE_STUDIO_ASR_URL 指向本地 Whisper 兼容端点，然后重启 Host。',
			'transcribe.asrUnknown': '无法读取 ASR 状态；如果 Host 已配置，转写仍可能可用。',
			'transcribe.endpoint': '端点',
			'transcribe.model': '模型',
			'transcribe.language': '语言',
			'transcribe.keyRef': '密钥引用',
			'transcribe.loopback': '回环',
			'transcribe.transcriptsTitle': '转写记录',
			'transcribe.refresh': '刷新',
			'transcribe.loading': '正在加载转写…',
			'transcribe.empty': '还没有转写',
			'transcribe.emptyHint': '在“工程”标签中对视频或音频执行转写。',
			'transcribe.segmentCount': '{count} 个分段',
			'transcribe.createCaptions': '创建字幕',
			'transcribe.loadError': '加载转写失败：{message}',
			'search.placeholder': '搜索媒体与转写',
			'search.action': '搜索',
			'search.clear': '清除',
			'search.loading': '正在搜索…',
			'search.error': '搜索失败：{message}',
			'search.noResults': '没有找到“{query}”的结果。',
			'search.transcripts': '转写',
			'search.media': '媒体',
			'generate.tab': '生成',
			'generate.providers': '生成服务',
			'generate.imageProvider': '图像',
			'generate.speechProvider': '语音',
			'generate.configured': '已配置',
			'generate.notConfigured': '未配置',
			'generate.unknown': '无法读取生成服务状态。',
			'generate.hint': '请在 Host 上配置 OpenAI 生成服务：设置 OPENAI_API_KEY（可选 OPENAI_BASE_URL）或在 DSH 中保存凭据，然后重启 Host。',
			'generate.working': '正在生成…',
			'generate.imageTitle': '生成图像',
			'generate.imagePrompt': '图像提示词',
			'generate.imagePromptPlaceholder': '描述要生成的图像…',
			'generate.imageSize': '尺寸',
			'generate.imageAction': '生成图像',
			'generate.imageDone': '图像已生成并添加到工程媒体。',
			'generate.speechTitle': '生成语音',
			'generate.speechText': '语音文本',
			'generate.speechTextPlaceholder': '输入要朗读的文本…',
			'generate.voice': '音色',
			'generate.model': '模型（可选）',
			'generate.modelPlaceholder': '使用服务默认模型',
			'generate.speechAction': '生成语音',
			'generate.speechDone': '语音已生成并添加到工程媒体。',
			'generate.error': '生成失败：{message}',
			'inspector.crop': '裁剪',
			'inspector.cropReset': '重置裁剪',
			'inspector.cropX': '裁剪 X',
			'inspector.cropY': '裁剪 Y',
			'inspector.cropWidth': '裁剪宽度',
			'inspector.cropHeight': '裁剪高度',
			'inspector.cropHint': '归一化的源裁剪区域，与变换相互独立。裁剪片段会从真正的转场回退为淡入淡出近似。',
			'export.codecProres': 'ProRes（.mov）',
			'export.codecVp9': 'VP9 / WebM（.webm）',
			'export.extensionHint': '输出扩展名：{ext}',
			'export.proresHint': 'ProRes 会忽略 CRF 值（基于 profile/码率）。',
			'inspector.mask': '遮罩',
			'inspector.maskReset': '重置遮罩',
			'inspector.maskShape': '形状',
			'inspector.maskX': '遮罩 X',
			'inspector.maskY': '遮罩 Y',
			'inspector.maskWidth': '遮罩宽度',
			'inspector.maskHeight': '遮罩高度',
			'inspector.maskFeather': '羽化',
			'inspector.maskInvert': '反转遮罩',
			'inspector.maskHint': '遮罩在裁剪/缩放之后、叠加之前应用于变换框内部。画布预览中的羽化为近似效果。',
			'inspector.blend': '混合',
			'inspector.blendMode': '混合模式',
			'inspector.blendHint': '全帧片段（无变换/裁剪/遮罩）会在预览中与下方图层混合。',
			'inspector.blendFallback': '该片段存在变换/裁剪/遮罩，预览回退为普通叠加；导出在适用时会尝试真实混合。',
			'mask.rect': '矩形',
			'mask.ellipse': '椭圆',
			'blend.normal': '正常',
			'blend.screen': '滤色',
			'blend.multiply': '正片叠底',
			'blend.overlay': '叠加',
			'blend.darken': '变暗',
			'blend.lighten': '变亮',
			'blend.add': '相加',
			'blend.difference': '差值',
			'timeline.trackVolume': '轨道音量',
			'library.folders': '文件夹',
			'library.newFolder': '新建文件夹',
			'library.allFolders': '全部',
			'library.rootFolder': '根目录',
			'library.expandFolder': '展开文件夹',
			'library.collapseFolder': '收起文件夹',
			'library.renameFolder': '重命名文件夹',
			'library.deleteFolder': '删除文件夹',
			'library.createFolderTitle': '新建文件夹',
			'library.renameFolderTitle': '重命名文件夹',
			'library.folderName': '文件夹名称',
			'library.folderParent': '上级文件夹',
			'library.createFolder': '创建',
			'library.deleteFolderTitle': '删除文件夹',
			'library.deleteFolderHint': '子文件夹和项目会移动到上级文件夹。',
			'library.deleteFolderConfirm': '删除文件夹',
			'library.move': '移动到文件夹',
			'library.moveTitle': '移动到文件夹',
			'library.moveTo': '目标位置',
			'library.moveConfirm': '移动',
			'library.moved': '已移动 {name}。',
			'library.folderCreated': '文件夹已创建。',
			'library.folderUpdated': '文件夹已更新。',
			'library.folderDeleted': '文件夹已删除。',
			'timeline.trackRole': '轨道角色',
			'timeline.ducking': '闪避',
			'timeline.duckingHint': '播放头处有人声轨道音频时，自动降低本轨道音量。',
			'role.voice': '人声',
			'role.music': '音乐',
			'role.sfx': '音效',
			'role.other': '其他',
			'role.short.voice': '人',
			'role.short.music': '乐',
			'role.short.sfx': '效',
			'role.short.other': '他',
			'generate.videoProvider': '视频',
			'generate.videoTitle': '生成视频',
			'generate.videoPrompt': '视频提示词',
			'generate.videoPromptPlaceholder': '描述要生成的镜头…',
			'generate.aspectRatio': '画幅比例',
			'generate.duration': '时长',
			'generate.duration5': '5 秒',
			'generate.duration10': '10 秒',
			'generate.videoAction': '生成视频',
			'generate.videoDone': '视频已生成并添加到工程媒体。',
			'vision.title': '视觉描述',
			'vision.index': '描述',
			'vision.indexTitle': '使用已配置的视觉模型描述该画面，并加入搜索。',
			'vision.indexing': '正在描述…',
			'vision.indexed': '已添加 {name} 的视觉描述。',
			'vision.error': '视觉索引失败：{message}',
			'vision.hint': '请在 Host 上配置 OPENAI_API_KEY（或 DSH 凭据）以描述和搜索画面。',
			'vision.refresh': '刷新',
			'search.vision': '视觉匹配',
			'proxy.toggle': '代理预览',
			'proxy.toggleTitle': '通过低分辨率代理预览视频（导出仍使用原始文件）。',
			'proxy.badge': '代理',
			'proxy.badgeTitle': '预览正在使用低分辨率代理；导出使用原始文件。',
			'proxy.fallback': '{name} 的代理预览失败，已回退到原始文件。',
			'proxy.generate': '代理',
			'proxy.generating': '代理…',
			'proxy.generateTitle': '立即生成低分辨率预览代理（导出使用原始文件）。',
			'proxy.generated': '{name} 的预览代理已就绪。',
			'proxy.generateError': '无法为 {name} 生成代理：{message}',
			'media.offline': '离线',
			'media.missingPreview': '媒体缺失',
			'media.missingPreviewHint': '请在媒体面板中重新链接该素材以恢复预览。',
			'media.missingInspector': '媒体缺失——请在媒体面板中重新链接该素材。',
			'media.missingDetected': '媒体文件缺失：{name}。',
			'media.relink': '重新链接',
			'media.relinkError': '重新链接失败：{message}',
			'media.relinkTitle': '重新链接媒体',
			'media.relinkPath': '新文件路径',
			'media.relinkPathRequired': '请输入绝对文件路径。',
			'media.relinkConfirm': '重新链接',
			'media.relinkHint': '输入现有媒体文件的绝对路径。片段会保留相同的 id 与时间。',
			'media.relinked': '已重新链接 {name}。',
			'export.codecProres4444': 'ProRes 4444（.mov，带 Alpha）',
			'export.transparent': '透明背景',
			'export.transparentHint': '渲染透明底色；ProRes 4444 会保留 Alpha 通道。',
			'export.bitDepth10': '10 位',
			'export.bitDepthHint': '10 位输出支持 H.265、VP9 和 ProRes（H.264 会忽略）。',
			'export.colorPrimaries': '色原色',
			'export.colorTrc': '传递函数',
			'export.colorspace': '色彩空间',
			'export.colorAuto': '默认',
			'export.primaries709': 'BT.709',
			'export.primaries2020': 'BT.2020',
			'export.trcSdr': 'SDR（BT.709）',
			'export.trcPq': 'PQ（HDR10）',
			'export.trcHlg': 'HLG',
			'export.space709': 'BT.709',
			'export.space2020': 'BT.2020',
			'export.colorHint': '可选的色彩元数据标签；除非交付需要，否则保持“默认”。',
			'preview.stepBack': '后退一帧',
			'preview.stepForward': '前进一帧',
			'inspector.shortcutStep': '← / → — 单帧步进',
			'media.lottie': 'Lottie',
			'lottie.loading': '正在加载 Lottie…',
			'lottie.unavailable': 'Lottie 不可用',
			'status.preparingLottie': '正在为 {name} 渲染 Lottie 帧 {index}/{total}…',
			'inspector.kindLottie': 'Lottie 片段',
			'welcome.recentTitle': '最近项目',
			'welcome.recentRefresh': '刷新',
			'welcome.recentClear': '清除',
			'welcome.recentLoading': '正在加载最近项目…',
			'welcome.recentEmpty': '还没有最近项目。',
			'welcome.recentMissing': '缺失',
			'welcome.recentMissingHint': '项目文件夹或 opentake-studio.json 不存在。',
			'welcome.recentClearConfirm': '清除最近项目列表？',
			'welcome.recentCleared': '最近项目已清除。',
			'welcome.recentOpened': '已打开 {name}。',
			'preview.exportFrame': '导出帧',
			'preview.exportFrameTitle': '将当前合成预览帧导出为 PNG。',
			'preview.frameExported': '已导出 {file}。',
			'preview.exportFrameError': '无法导出帧：{message}',
			'timeline.addMotion': '添加动效',
			'motion.addTitle': '添加动效模板',
			'motion.addAction': '添加动效',
			'motion.added': '动效片段已添加。',
			'motion.addFailed': '无法添加动效片段。',
			'motion.template': '模板',
			'motion.templateTitle': '标题',
			'motion.templateLowerThird': '下三分之一',
			'motion.templateCallout': '标注卡片',
			'motion.text': '文本',
			'motion.textPlaceholder': '动效文本…',
			'motion.textDefault': '你的标题',
			'motion.subtitle': '副标题',
			'motion.subtitlePlaceholder': '可选副标题…',
			'motion.color': '文字颜色',
			'motion.accentColor': '强调色',
			'motion.fontSize': '字号',
			'motion.align': '对齐',
			'motion.alignLeft': '左',
			'motion.alignCenter': '居中',
			'motion.alignRight': '右',
			'motion.background': '背景面板',
			'motion.duration': '时长（帧）',
			'motion.durationSeconds': '时长（秒）',
			'motion.hint': 'Canvas 渲染的模板片段；导出前会像 Lottie 一样逐帧预渲染。',
			'inspector.motion': '动效模板',
			'inspector.kindMotion': '动效片段',
			'status.preparingMotion': '正在为 {name} 渲染动效帧 {index}/{total}…',
			'status.preparingText': '正在准备文本…',
			'dialog.preparingText': '正在为导出渲染文本层…',
		};

		// -------------------------------------------------------------------
		// Presentation helpers
		// -------------------------------------------------------------------

		function Glyph(props) {
			const size = props && props.size ? props.size : 18;
			const active = Boolean(props && props.active);
			return h(
				'svg',
				{
					className: 'ots-glyph',
					width: size,
					height: size,
					viewBox: '0 0 20 20',
					fill: 'none',
					'aria-hidden': 'true',
					focusable: 'false',
					'data-active': active ? 'true' : 'false',
				},
				h('rect', {
					x: 2.5,
					y: 3.5,
					width: 15,
					height: 13,
					rx: 3,
					stroke: 'currentColor',
					strokeWidth: 1.4,
				}),
				h('path', {
					d: 'M8.2 7.3v5.4l4.4-2.7z',
					fill: 'currentColor',
				}),
				h('path', {
					d: 'M2.5 12.6h15',
					stroke: 'currentColor',
					strokeWidth: 1.1,
					opacity: 0.55,
				}),
			);
		}

		function Btn(props) {
			const rest = Object.assign({}, props);
			const variant = rest.variant || 'ghost';
			const active = rest.active;
			const className = rest.className;
			delete rest.variant;
			delete rest.active;
			delete rest.className;
			delete rest.children;
			const classes = ['ots-btn', `ots-btn-${variant}`];
			if (className) classes.push(className);
			const attributes = Object.assign({}, rest, {
				type: 'button',
				className: classes.join(' '),
			});
			if (active !== undefined) attributes['data-active'] = active ? 'true' : 'false';
			return h('button', attributes, props.children);
		}

		function Field(props) {
			return h(
				'label',
				{ className: 'ots-field' },
				h('span', { className: 'ots-field-label' }, props.label),
				props.children,
				props.hint ? h('span', { className: 'ots-field-hint' }, props.hint) : null,
			);
		}

		function RangeField(props) {
			const percent = Math.round(clamp01(finiteNumber(props.value, 0)) * 100);
			return h(
				'div',
				{ className: 'ots-field' },
				h(
					'div',
					{ className: 'ots-field-row' },
					h('span', { className: 'ots-field-label' }, props.label),
					h('span', { className: 'ots-value' }, `${percent}%`),
				),
				h('input', {
					className: 'ots-range',
					type: 'range',
					min: 0,
					max: 1,
					step: 0.01,
					value: clamp01(finiteNumber(props.value, 0)),
					'aria-label': props.label,
					onChange: (event) => props.onChange(Number(event.target.value)),
					onPointerUp: props.onCommit,
					onKeyUp: props.onCommit,
					onBlur: props.onCommit,
				}),
			);
		}

		function NumberField(props) {
			return h(
				'label',
				{ className: 'ots-field' },
				h('span', { className: 'ots-field-label' }, props.label),
				h('input', {
					className: 'ots-input',
					type: 'number',
					step: props.step === undefined ? 0.01 : props.step,
					min: props.min,
					max: props.max,
					value: props.value,
					'aria-label': props.label,
					title: props.label,
					onChange: (event) => props.onChange(event.target.value),
					onBlur: props.onBlur,
					onKeyDown: (event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							if (props.onBlur) props.onBlur();
						}
					},
				}),
			);
		}

		function SelectField(props) {
			return h(
				'label',
				{ className: 'ots-field' },
				h('span', { className: 'ots-field-label' }, props.label),
				h(
					'select',
					{
						className: 'ots-select',
						value: props.value,
						'aria-label': props.label,
						title: props.label,
						onChange: (event) => props.onChange(event.target.value),
					},
					props.options.map((option) =>
						h('option', { key: option.value, value: option.value }, option.label),
					),
				),
			);
		}

		function Banner(props) {
			if (!props.message) return null;
			const tone = props.tone || 'info';
			return h(
				'div',
				{ className: `ots-banner ots-banner-${tone}`, role: tone === 'error' ? 'alert' : 'status' },
				h('span', { className: 'ots-banner-text' }, props.message),
				props.onDismiss
					? h(
							'button',
							{
								type: 'button',
								className: 'ots-banner-close',
								onClick: props.onDismiss,
								'aria-label': props.dismissLabel || 'Dismiss',
								title: props.dismissLabel || 'Dismiss',
							},
							'×',
						)
					: null,
			);
		}

		function LottieThumb(props) {
			const { media, t } = props;
			const [dataUrl, setDataUrl] = React.useState(null);
			const [failed, setFailed] = React.useState(false);
			React.useEffect(() => {
				let active = true;
				renderLottieThumb(media)
					.then((url) => {
						if (active) setDataUrl(url);
					})
					.catch(() => {
						if (active) setFailed(true);
					});
				return () => {
					active = false;
				};
			}, [media.id, media.fileName]);
			if (failed) {
				return h('span', { className: 'ots-lottie-fallback', title: t('lottie.unavailable') }, t('lottie.unavailable'));
			}
			if (dataUrl) {
				return h('img', { className: 'ots-lottie-thumb', src: dataUrl, alt: '', draggable: false });
			}
			return h('span', { className: 'ots-lottie-fallback', title: t('lottie.loading') }, t('lottie.loading'));
		}

		function MediaThumb(props) {
			const [failed, setFailed] = React.useState(false);
			const media = props.media;
			if (media.kind === 'lottie') {
				return h(LottieThumb, { media, t: props.t });
			}
			if (media.kind === 'audio' || failed) {
				const glyph = media.kind === 'audio' ? 'media.glyphAudio' : media.kind === 'image' ? 'media.glyphImage' : 'media.glyphVideo';
				return h('span', { className: 'ots-media-glyph', 'aria-hidden': 'true' }, props.t(glyph));
			}
			return h('img', {
				src: mediaThumbUrl(media.id),
				alt: '',
				loading: 'lazy',
				draggable: false,
				onError: () => setFailed(true),
			});
		}

		// -------------------------------------------------------------------
		// Top bar
		// -------------------------------------------------------------------

		function TopBar(props) {
			const { t, snapshot, project, projectRoot, busy, onNew, onOpen, onSave, onUndo, onRedo, onExport, onCancelExport, proxyPreview, onToggleProxyPreview } = props;
			const ffmpeg = snapshot ? snapshot.ffmpeg : null;
			const exportState = snapshot ? snapshot.export : null;
			const exporting = exportState && exportState.state === 'running';
			const progress = exportState ? clamp01(finiteNumber(exportState.progress, 0)) : 0;
			const canSave = Boolean(project) && busy === 0;
			return h(
				'header',
				{ className: 'ots-topbar' },
				h(
					'div',
					{ className: 'ots-brand' },
					h('span', { className: 'ots-brand-glyph' }, h(Glyph, { size: 22 })),
					h(
						'div',
						{ className: 'ots-brand-text' },
						h('span', { className: 'ots-project-name', title: project ? project.name : t('project.noProject') }, project ? project.name : t('project.noProject')),
						h(
							'span',
							{ className: 'ots-project-path', title: projectRoot || '' },
							projectRoot || t('project.noProjectHint'),
						),
					),
				),
				h(
					'div',
					{ className: 'ots-top-actions' },
					h(Btn, { variant: 'outline', onClick: onNew }, t('actions.new')),
					h(Btn, { variant: 'outline', onClick: onOpen }, t('actions.open')),
					h(Btn, { onClick: onSave, disabled: !canSave, title: t('actions.save') }, t('actions.save')),
					h(Btn, { onClick: onUndo, disabled: !project || !snapshot.canUndo || busy > 0, title: t('actions.undo') }, t('actions.undo')),
					h(Btn, { onClick: onRedo, disabled: !project || !snapshot.canRedo || busy > 0, title: t('actions.redo') }, t('actions.redo')),
					h(
						Btn,
						{
							variant: 'ghost',
							active: proxyPreview,
							onClick: onToggleProxyPreview,
							title: t('proxy.toggleTitle'),
							'aria-pressed': proxyPreview ? 'true' : 'false',
							'aria-label': t('proxy.toggle'),
						},
						t('proxy.toggle'),
					),
					h(
						Btn,
						{
							variant: 'primary',
							onClick: onExport,
							disabled: !project || busy > 0 || exporting || !ffmpeg || !ffmpeg.available,
							title: !ffmpeg || !ffmpeg.available ? t('ffmpeg.missingTitle') : t('actions.export'),
						},
						t('actions.export'),
					),
				),
				h(
					'div',
					{ className: 'ots-status' },
					exporting
						? h(
								'div',
								{ className: 'ots-export-progress', 'aria-live': 'polite' },
								h(
									'div',
									{
										className: 'ots-export-track',
										role: 'progressbar',
										'aria-valuemin': 0,
										'aria-valuemax': 100,
										'aria-valuenow': Math.round(progress * 100),
										'aria-label': t('status.exporting', { percent: Math.round(progress * 100) }),
									},
									h('div', { className: 'ots-export-bar', style: { width: `${Math.round(progress * 100)}%` } }),
								),
								h('span', { className: 'ots-export-text' }, t('status.exporting', { percent: Math.round(progress * 100) })),
								h(Btn, { variant: 'ghost', onClick: onCancelExport }, t('actions.cancelExport')),
							)
						: null,
					h(
						'span',
						{
							className: 'ots-pill',
							'data-ok': ffmpeg && ffmpeg.available ? 'true' : 'false',
							title: ffmpeg && ffmpeg.available ? t('ffmpeg.readyTitle', { version: ffmpeg.version || ffmpeg.ffmpeg || 'ffmpeg' }) : t('ffmpeg.missingTitle'),
						},
						h('span', { className: 'ots-pill-dot' }),
						ffmpeg && ffmpeg.available ? t('ffmpeg.ready') : t('ffmpeg.missing'),
					),
				),
			);
		}

		function RecentProjects(props) {
			const { t, projects, loading, error, onOpen, onClear, onRefresh, compact } = props;
			const [confirmClear, setConfirmClear] = React.useState(false);
			const rows = Array.isArray(projects) ? projects : [];
			const clear = () => {
				setConfirmClear(false);
				onClear();
			};
			return h(
				'div',
				{ className: 'ots-recent', 'data-compact': compact ? 'true' : 'false' },
				h(
					'div',
					{ className: 'ots-recent-head' },
					h('span', { className: 'ots-recent-title' }, t('welcome.recentTitle')),
					h(
						'div',
						{ className: 'ots-recent-actions' },
						h(Btn, { variant: 'ghost', onClick: onRefresh, disabled: loading }, t('welcome.recentRefresh')),
						h(
							Btn,
							{ variant: 'ghost', onClick: () => setConfirmClear(true), disabled: loading || rows.length === 0 },
							t('welcome.recentClear'),
						),
					),
				),
				loading ? h('p', { className: 'ots-note', role: 'status' }, t('welcome.recentLoading')) : null,
				error ? h('p', { className: 'ots-note', 'data-warn': 'true', role: 'alert' }, error) : null,
				!loading && !error && rows.length === 0
					? h('p', { className: 'ots-note' }, t('welcome.recentEmpty'))
					: null,
				rows.length > 0
					? h(
							'div',
							{ className: 'ots-recent-list' },
							rows.map((entry) =>
								h(
									'button',
									{
										type: 'button',
										key: entry.root,
										className: 'ots-recent-row',
										'data-missing': entry.missing === true ? 'true' : 'false',
										disabled: entry.missing === true,
										title: entry.missing === true ? t('welcome.recentMissingHint') : entry.root,
										onClick: () => onOpen(entry),
									},
									h(
										'span',
										{ className: 'ots-recent-main' },
										h('span', { className: 'ots-recent-name' }, entry.name || entry.root),
										h('span', { className: 'ots-recent-path' }, entry.root),
										h(
											'span',
											{ className: 'ots-recent-meta' },
											[
												Number.isFinite(Number(entry.fps)) ? `${entry.fps} fps` : null,
												Number.isFinite(Number(entry.width)) && Number.isFinite(Number(entry.height))
													? `${entry.width} × ${entry.height}`
													: null,
												Number.isFinite(Number(entry.updatedAt)) && Number(entry.updatedAt) > 0
													? new Date(Number(entry.updatedAt)).toLocaleString()
													: null,
											]
												.filter(Boolean)
												.join(' · '),
										),
									),
									entry.missing === true
										? h('span', { className: 'ots-recent-missing' }, t('welcome.recentMissing'))
										: null,
								),
							),
						)
					: null,
				confirmClear
					? h(
							'div',
							{ className: 'ots-recent-confirm', role: 'alertdialog' },
							h('span', {}, t('welcome.recentClearConfirm')),
							h(
								'div',
								{ className: 'ots-recent-actions' },
								h(Btn, { variant: 'ghost', onClick: () => setConfirmClear(false) }, t('actions.cancel')),
								h(Btn, { variant: 'outline', onClick: clear }, t('welcome.recentClear') ),
							),
						)
					: null,
			);
		}

		function Welcome(props) {
			const { t, snapshot, onNew, onOpen, recentProjects, recentLoading, recentError, onOpenRecent, onClearRecent, onRefreshRecent } = props;
			const ffmpeg = snapshot ? snapshot.ffmpeg : null;
			const missing = Boolean(ffmpeg && !ffmpeg.available);
			return h(
				'div',
				{ className: 'ots-welcome' },
				h(
					'div',
					{ className: 'ots-welcome-card' },
					h('span', { className: 'ots-welcome-glyph' }, h(Glyph, { size: 46 })),
					h('h1', { className: 'ots-welcome-title' }, t('welcome.title')),
					h('p', { className: 'ots-welcome-lead' }, t('welcome.lead')),
					h(
						'div',
						{ className: 'ots-welcome-actions' },
						h(Btn, { variant: 'primary', onClick: onNew }, t('welcome.new')),
						h(Btn, { variant: 'outline', onClick: onOpen }, t('welcome.open')),
					),
					h('p', { className: 'ots-welcome-note', 'data-warn': missing ? 'true' : 'false' }, missing ? t('welcome.ffmpegMissing') : t('welcome.dependency')),
					h(RecentProjects, {
						t,
						projects: recentProjects,
						loading: recentLoading,
						error: recentError,
						onOpen: onOpenRecent,
						onClear: onClearRecent,
						onRefresh: onRefreshRecent,
					}),
				),
			);
		}

		// -------------------------------------------------------------------
		// Media library
		// -------------------------------------------------------------------

		function LibraryThumb(props) {
			const [failed, setFailed] = React.useState(false);
			const item = props.item;
			if (item.kind === 'audio' || failed) {
				const glyph = item.kind === 'audio' ? 'media.glyphAudio' : item.kind === 'image' ? 'media.glyphImage' : 'media.glyphVideo';
				return h('span', { className: 'ots-media-glyph', 'aria-hidden': 'true' }, props.t(glyph));
			}
			return h('img', {
				src: libraryThumbUrl(item.id),
				alt: '',
				loading: 'lazy',
				draggable: false,
				onError: () => setFailed(true),
			});
		}

		function LibraryPanel(props) {
			const { t, pickDirectory, onState, showNotice, ffmpegAvailable, projectAvailable } = props;
			const [items, setItems] = React.useState([]);
			const [folders, setFolders] = React.useState([]);
			const [query, setQuery] = React.useState('');
			const [kind, setKind] = React.useState('all');
			const [favoritesOnly, setFavoritesOnly] = React.useState(false);
			const [selectedFolderId, setSelectedFolderId] = React.useState(undefined);
			const [expandedFolders, setExpandedFolders] = React.useState(() => new Set());
			const [folderDialog, setFolderDialog] = React.useState(null);
			const [deletingFolder, setDeletingFolder] = React.useState(null);
			const [moving, setMoving] = React.useState(null);
			const [loading, setLoading] = React.useState(true);
			const [error, setError] = React.useState(null);
			const [importing, setImporting] = React.useState(false);
			const [busyId, setBusyId] = React.useState(null);
			const [editing, setEditing] = React.useState(null);
			const [deleting, setDeleting] = React.useState(null);
			const [importPath, setImportPath] = React.useState(null);
			const importSeq = React.useRef(0);

			const errorText = (issue) => {
				const raw = issue && issue.message ? issue.message : String(issue || '');
				return t('library.error', { message: raw });
			};

			const fetchLibrary = async () => {
				const data = await hostRequest(libraryItemsQuery(query, kind, favoritesOnly, selectedFolderId));
				const nextItems = data && Array.isArray(data.items) ? data.items : [];
				const nextFolders = data && Array.isArray(data.folders) ? data.folders : [];
				setItems(nextItems);
				setFolders(nextFolders);
				return data;
			};

			React.useEffect(() => {
				const seq = importSeq.current + 1;
				importSeq.current = seq;
				setLoading(true);
				setError(null);
				fetchLibrary()
					.catch((issue) => {
						if (importSeq.current === seq) setError(errorText(issue));
					})
					.finally(() => {
						if (importSeq.current === seq) setLoading(false);
					});
			}, [query, kind, favoritesOnly, selectedFolderId]);

			const reload = async () => {
				setError(null);
				try {
					await fetchLibrary();
				} catch (issue) {
					setError(errorText(issue));
				}
			};
			const replaceItem = (nextItem) => {
				if (!nextItem || typeof nextItem.id !== 'string') return;
				setItems((previous) => previous.map((item) => (item.id === nextItem.id ? nextItem : item)));
			};
			const doImport = async (folder) => {
				const folderPath = typeof folder === 'string' ? folder.trim() : '';
				if (folderPath.length === 0) {
					setImportPath('');
					return;
				}
				setImporting(true);
				setError(null);
				try {
					const body = { path: folderPath };
					if (typeof selectedFolderId === 'string') body.folderId = selectedFolderId;
					const data = await hostPost('library/import', body);
					const imported = data && Array.isArray(data.imported) ? data.imported.length : 0;
					const skipped = data && Array.isArray(data.skipped) ? data.skipped.length : 0;
					setImportPath(null);
					await reload();
					showNotice(t('library.imported', { count: imported, skipped }));
				} catch (issue) {
					setError(errorText(issue));
				} finally {
					setImporting(false);
				}
			};
			const chooseImportFolder = async () => {
				let picked;
				try {
					picked = pickDirectory ? await pickDirectory() : undefined;
				} catch (issue) {
					setError(errorText(issue));
					return;
				}
				if (picked === undefined) {
					setImportPath('');
					return;
				}
				if (picked === null) return;
				await doImport(picked);
			};
			const toggleFavorite = async (item) => {
				setBusyId(item.id);
				setError(null);
				try {
					const data = await hostPost('library/update', {
						id: item.id,
						patch: { favorite: item.favorite !== true },
					});
					if (data && data.item) replaceItem(data.item);
					if (favoritesOnly && data && data.item && data.item.favorite !== true) {
						setItems((previous) => previous.filter((entry) => entry.id !== item.id));
					}
				} catch (issue) {
					setError(errorText(issue));
				} finally {
					setBusyId(null);
				}
			};
			const addToProject = async (item) => {
				setBusyId(item.id);
				setError(null);
				try {
					const payload = await hostPost('library/add-to-project', { id: item.id });
					if (typeof onState === 'function') onState(payload);
					showNotice(t('library.added', { name: item.name }));
				} catch (issue) {
					setError(errorText(issue));
				} finally {
					setBusyId(null);
				}
			};
			const saveEdit = async () => {
				if (!editing) return;
				const name = String(editing.name || '').trim();
				if (name.length === 0) {
					setEditing(Object.assign({}, editing, { error: t('library.nameRequired') }));
					return;
				}
				const tags = String(editing.tags || '')
					.split(',')
					.map((tag) => tag.trim())
					.filter((tag) => tag.length > 0);
				setBusyId(editing.id);
				setError(null);
				try {
					const data = await hostPost('library/update', {
						id: editing.id,
						patch: { name, category: String(editing.category || '').trim(), tags },
					});
					if (data && data.item) replaceItem(data.item);
					setEditing(null);
					showNotice(t('library.updated'));
				} catch (issue) {
					setEditing(Object.assign({}, editing, { error: errorText(issue) }));
				} finally {
					setBusyId(null);
				}
			};
			const confirmDelete = async () => {
				if (!deleting) return;
				setBusyId(deleting.id);
				setError(null);
				try {
					await hostPost('library/delete', { id: deleting.id });
					setItems((previous) => previous.filter((item) => item.id !== deleting.id));
					setDeleting(null);
					showNotice(t('library.deleted'));
				} catch (issue) {
					setError(errorText(issue));
				} finally {
					setBusyId(null);
				}
			};

			const openCreateFolder = () => {
				setFolderDialog({
					mode: 'create',
					id: null,
					name: '',
					parentId: typeof selectedFolderId === 'string' ? selectedFolderId : null,
					error: null,
				});
			};
			const openRenameFolder = (folder) => {
				setFolderDialog({
					mode: 'rename',
					id: folder.id,
					name: folder.name || '',
					parentId: folder.parentId ?? null,
					error: null,
				});
			};
			const saveFolder = async () => {
				if (!folderDialog) return;
				const name = String(folderDialog.name || '').trim();
				if (name.length === 0) {
					setFolderDialog(Object.assign({}, folderDialog, { error: t('library.nameRequired') }));
					return;
				}
				setFolderDialog(Object.assign({}, folderDialog, { error: null }));
				try {
					if (folderDialog.mode === 'create') {
						const body = { name };
						if (typeof folderDialog.parentId === 'string' && folderDialog.parentId.length > 0) body.parentId = folderDialog.parentId;
						await hostPost('library/folders/create', body);
						showNotice(t('library.folderCreated'));
					} else {
						await hostPost('library/folders/update', {
							id: folderDialog.id,
							patch: { name, parentId: folderDialog.parentId ?? null },
						});
						showNotice(t('library.folderUpdated'));
					}
					setFolderDialog(null);
					await reload();
				} catch (issue) {
					setFolderDialog(Object.assign({}, folderDialog, { error: errorText(issue) }));
				}
			};
			const confirmDeleteFolder = async () => {
				if (!deletingFolder) return;
				const target = deletingFolder;
				setDeletingFolder(null);
				setError(null);
				try {
					const data = await hostPost('library/folders/delete', { id: target.id });
					const deleted = data && data.folder ? data.folder : target;
					if (selectedFolderId === target.id) {
						setSelectedFolderId(typeof deleted.parentId === 'string' ? deleted.parentId : null);
					}
					showNotice(t('library.folderDeleted'));
					await reload();
				} catch (issue) {
					setError(errorText(issue));
				}
			};
			const saveMove = async () => {
				if (!moving) return;
				const target = moving.item;
				try {
					await hostPost('library/move', { id: target.id, folderId: moving.folderId ?? null });
					setMoving(null);
					showNotice(t('library.moved', { name: target.name }));
					await reload();
				} catch (issue) {
					setMoving(Object.assign({}, moving, { error: errorText(issue) }));
				}
			};
			const toggleFolder = (folderId) => {
				setExpandedFolders((previous) => {
					const next = new Set(previous);
					if (next.has(folderId)) next.delete(folderId);
					else next.add(folderId);
					return next;
				});
			};
			const folderOptions = libraryFolderOptions(folders);
			const renderSpecialFolder = (label, value) =>
				h(
					'div',
					{ className: 'ots-folder-row', 'data-active': selectedFolderId === value ? 'true' : 'false' },
					h('span', { className: 'ots-folder-toggle' }, '•'),
					h(
						'button',
						{
							type: 'button',
							className: 'ots-folder-name',
							onClick: () => setSelectedFolderId(value),
							title: label,
						},
						label,
					),
				);
			const renderFolderNode = (folder, depth) => {
				const children = libraryFolderChildren(folders, folder.id);
				const expanded = expandedFolders.has(folder.id);
				return h(
					React.Fragment,
					{ key: folder.id },
					h(
						'div',
						{
							className: 'ots-folder-row',
							'data-active': selectedFolderId === folder.id ? 'true' : 'false',
							style: { paddingLeft: `${4 + depth * 10}px` },
						},
						children.length > 0
							? h(
									'button',
									{
										type: 'button',
										className: 'ots-folder-toggle',
										title: expanded ? t('library.collapseFolder') : t('library.expandFolder'),
										'aria-label': expanded ? t('library.collapseFolder') : t('library.expandFolder'),
										onClick: () => toggleFolder(folder.id),
									},
									expanded ? '▾' : '▸',
								)
							: h('span', { className: 'ots-folder-toggle' }, '·'),
						h(
							'button',
							{
								type: 'button',
								className: 'ots-folder-name',
								title: folder.name,
								onClick: () => setSelectedFolderId(folder.id),
							},
							folder.name || folder.id,
						),
						h(
							'div',
							{ className: 'ots-folder-actions' },
							h(
								'button',
								{
									type: 'button',
									className: 'ots-mini',
									title: t('library.renameFolder'),
									'aria-label': t('library.renameFolder'),
									'data-folder-id': folder.id,
									onClick: () => openRenameFolder(folder),
								},
								'✎',
							),
							h(
								'button',
								{
									type: 'button',
									className: 'ots-mini',
									'data-danger': 'true',
									title: t('library.deleteFolder'),
									'aria-label': t('library.deleteFolder'),
									'data-folder-id': folder.id,
									onClick: () => setDeletingFolder(folder),
								},
								'×',
							),
						),
					),
					expanded ? children.map((child) => renderFolderNode(child, depth + 1)) : null,
				);
			};
			const folderTree = h(
				'div',
				{ className: 'ots-library-folders' },
				h(
					'div',
					{ className: 'ots-library-folder-head' },
					h('span', { className: 'ots-library-group-title' }, t('library.folders')),
					h(
						'button',
						{
							type: 'button',
							className: 'ots-mini',
							title: t('library.newFolder'),
							'aria-label': t('library.newFolder'),
							onClick: openCreateFolder,
						},
						'+',
					),
				),
				h(
					'div',
					{ className: 'ots-folder-list' },
					renderSpecialFolder(t('library.allFolders'), undefined),
					renderSpecialFolder(t('library.rootFolder'), null),
					libraryFolderChildren(folders, null).map((folder) => renderFolderNode(folder, 0)),
				),
			);

			const toolbar = h(
				'div',
				{ className: 'ots-library-toolbar' },
				h(
					'div',
					{ className: 'ots-library-search-row' },
					h('input', {
						className: 'ots-input',
						type: 'search',
						value: query,
						placeholder: t('library.search'),
						'aria-label': t('library.search'),
						onChange: (event) => setQuery(event.target.value),
					}),
					h(
						'select',
						{
							className: 'ots-select',
							value: kind,
							'aria-label': t('library.kind'),
							onChange: (event) => setKind(event.target.value),
						},
						h('option', { value: 'all' }, t('library.kindAll')),
						['video', 'audio', 'image'].map((value) => h('option', { key: value, value }, t(`media.${value}`))),
					),
					h(
						'button',
						{
							type: 'button',
							className: 'ots-mini',
							'data-active': favoritesOnly ? 'true' : 'false',
							title: t('library.favoritesOnly'),
							'aria-label': t('library.favoritesOnly'),
							'aria-pressed': favoritesOnly ? 'true' : 'false',
							onClick: () => setFavoritesOnly((value) => !value),
						},
						'★',
					),
				),
				h(
					'div',
					{ className: 'ots-library-actions-row' },
					h(
						Btn,
						{
							variant: 'outline',
							onClick: chooseImportFolder,
							disabled: importing || !ffmpegAvailable,
							title: ffmpegAvailable ? t('library.import') : t('ffmpeg.missingTitle'),
						},
						importing ? t('library.importing') : t('library.import'),
					),
					importing ? h('span', { className: 'ots-panel-sub', role: 'status' }, t('library.importing')) : null,
				),
			);

			const grid = loading
				? h('div', { className: 'ots-library-status', role: 'status', 'aria-live': 'polite' }, t('library.loading'))
				: error
					? h(
							'div',
							{ className: 'ots-library-status ots-library-error', role: 'alert' },
							h('span', {}, error),
							h(Btn, { variant: 'outline', onClick: () => void reload() }, t('library.retry')),
						)
					: items.length === 0
						? h(
								'div',
								{ className: 'ots-media-empty' },
								h('span', { className: 'ots-media-empty-title' }, t('library.empty')),
								h('span', {}, t('library.emptyHint')),
							)
						: h(
								'div',
								{ className: 'ots-media-grid' },
								items.map((item) =>
									h(
										'div',
										{ key: item.id, className: 'ots-media-card ots-library-card', title: item.name },
										h(
											'div',
											{ className: 'ots-media-thumb' },
											h(LibraryThumb, { item, t }),
											h(
												'button',
												{
													type: 'button',
													className: 'ots-library-star',
													'data-active': item.favorite === true ? 'true' : 'false',
													title: item.favorite === true ? t('library.unfavorite') : t('library.favorite'),
													'aria-label': item.favorite === true ? t('library.unfavorite') : t('library.favorite'),
													'aria-pressed': item.favorite === true ? 'true' : 'false',
													disabled: busyId === item.id,
													onClick: () => void toggleFavorite(item),
												},
												item.favorite === true ? '★' : '☆',
											),
										),
										h(
											'div',
											{ className: 'ots-media-meta' },
											h('span', { className: 'ots-media-name' }, item.name),
											h(
												'span',
												{ className: 'ots-media-sub' },
												h('span', {}, t(`media.${item.kind}`)),
												h(
													'span',
													{},
													item.durationSeconds === null || item.durationSeconds === undefined
														? t('media.still')
														: formatClock(finiteNumber(item.durationSeconds, 0)),
												),
												item.category ? h('span', { className: 'ots-library-category', title: item.category }, item.category) : null,
											),
										),
										h(
											'div',
											{ className: 'ots-library-actions-row' },
											h(
												'button',
												{
													type: 'button',
													className: 'ots-mini',
													disabled: busyId === item.id || !projectAvailable,
													title: t('library.addToProject'),
													onClick: () => void addToProject(item),
												},
												busyId === item.id ? t('library.working') : t('library.addToProject'),
											),
											h(
												'button',
												{
													type: 'button',
													className: 'ots-mini',
													title: t('library.move'),
													'aria-label': t('library.move'),
													disabled: busyId === item.id,
													onClick: () => setMoving({ item, folderId: item.folderId ?? null, error: null }),
												},
												'↪',
											),
											h(
												'button',
												{
													type: 'button',
													className: 'ots-mini',
													title: t('library.edit'),
													'aria-label': t('library.edit'),
													onClick: () =>
														setEditing({
															id: item.id,
															name: item.name || '',
															category: item.category || '',
															tags: Array.isArray(item.tags) ? item.tags.join(', ') : '',
															error: null,
														}),
												},
												'✎',
											),
											h(
												'button',
												{
													type: 'button',
													className: 'ots-mini',
													'data-danger': 'true',
													title: t('library.delete'),
													'aria-label': t('library.delete'),
													onClick: () => setDeleting(item),
												},
												'×',
											),
										),
									),
								),
							);

			const editDialog = editing
				? h(
						'div',
						{
							className: 'ots-modal-backdrop ots-modal-fixed',
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': t('library.editTitle'),
							onPointerDown: (event) => {
								if (event.target === event.currentTarget) setEditing(null);
							},
						},
						h(
							'div',
							{ className: 'ots-modal' },
							h('h2', { className: 'ots-modal-title' }, t('library.editTitle')),
							h(
								'div',
								{ className: 'ots-modal-body' },
								h(
									'label',
									{ className: 'ots-field' },
									h('span', { className: 'ots-field-label' }, t('library.name')),
									h('input', {
										className: 'ots-input',
										type: 'text',
										value: editing.name,
										'aria-label': t('library.name'),
										onChange: (event) => setEditing(Object.assign({}, editing, { name: event.target.value })),
									}),
								),
								h(
									'label',
									{ className: 'ots-field' },
									h('span', { className: 'ots-field-label' }, t('library.category')),
									h('input', {
										className: 'ots-input',
										type: 'text',
										value: editing.category,
										'aria-label': t('library.category'),
										onChange: (event) => setEditing(Object.assign({}, editing, { category: event.target.value })),
									}),
								),
								h(
									'label',
									{ className: 'ots-field' },
									h('span', { className: 'ots-field-label' }, t('library.tags')),
									h('input', {
										className: 'ots-input',
										type: 'text',
										value: editing.tags,
										placeholder: t('library.tagsPlaceholder'),
										'aria-label': t('library.tags'),
										onChange: (event) => setEditing(Object.assign({}, editing, { tags: event.target.value })),
									}),
								),
								editing.error ? h('p', { className: 'ots-modal-error', role: 'alert' }, editing.error) : null,
							),
							h(
								'div',
								{ className: 'ots-modal-actions' },
								h(Btn, { variant: 'ghost', onClick: () => setEditing(null) }, t('actions.cancel')),
								h(Btn, { variant: 'primary', onClick: saveEdit, disabled: busyId === editing.id }, t('library.save')),
							),
						),
					)
				: null;
			const deleteDialog = deleting
				? h(
						'div',
						{
							className: 'ots-modal-backdrop ots-modal-fixed',
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': t('library.deleteTitle'),
							onPointerDown: (event) => {
								if (event.target === event.currentTarget) setDeleting(null);
							},
						},
						h(
							'div',
							{ className: 'ots-modal' },
							h('h2', { className: 'ots-modal-title' }, t('library.deleteTitle')),
							h('p', { className: 'ots-modal-hint' }, deleting.name),
							h(
								'div',
								{ className: 'ots-modal-actions' },
								h(Btn, { variant: 'ghost', onClick: () => setDeleting(null) }, t('actions.cancel')),
								h(Btn, { variant: 'primary', onClick: confirmDelete, disabled: busyId === deleting.id }, t('library.deleteConfirm')),
							),
						),
					)
				: null;
			const importDialog =
				importPath !== null
					? h(
							'div',
							{
								className: 'ots-modal-backdrop ots-modal-fixed',
								role: 'dialog',
								'aria-modal': 'true',
								'aria-label': t('library.import'),
								onPointerDown: (event) => {
									if (event.target === event.currentTarget && !importing) setImportPath(null);
								},
							},
							h(
								'div',
								{ className: 'ots-modal' },
								h('h2', { className: 'ots-modal-title' }, t('library.import')),
								h(
									'label',
									{ className: 'ots-field' },
									h('span', { className: 'ots-field-label' }, t('library.importFolder')),
									h('input', {
										className: 'ots-input',
										type: 'text',
										value: importPath,
										placeholder: t('dialog.pathPlaceholder'),
										'aria-label': t('library.importFolder'),
										onChange: (event) => setImportPath(event.target.value),
									}),
								),
								h('p', { className: 'ots-modal-hint' }, t('library.importHint')),
								h(
									'div',
									{ className: 'ots-modal-actions' },
									h(Btn, { variant: 'ghost', onClick: () => setImportPath(null), disabled: importing }, t('actions.cancel')),
									h(Btn, { variant: 'primary', onClick: () => void doImport(importPath), disabled: importing }, importing ? t('library.importing') : t('library.importConfirm')),
								),
							),
						)
					: null;

			const folderDialogElement = folderDialog
				? h(
						'div',
						{
							className: 'ots-modal-backdrop ots-modal-fixed',
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': folderDialog.mode === 'create' ? t('library.createFolderTitle') : t('library.renameFolderTitle'),
							onPointerDown: (event) => {
								if (event.target === event.currentTarget) setFolderDialog(null);
							},
						},
						h(
							'div',
							{ className: 'ots-modal' },
							h('h2', { className: 'ots-modal-title' }, folderDialog.mode === 'create' ? t('library.createFolderTitle') : t('library.renameFolderTitle')),
							h(
								'div',
								{ className: 'ots-modal-body' },
								h(
									'label',
									{ className: 'ots-field' },
									h('span', { className: 'ots-field-label' }, t('library.folderName')),
									h('input', {
										className: 'ots-input',
										type: 'text',
										value: folderDialog.name,
										'aria-label': t('library.folderName'),
										onChange: (event) => setFolderDialog(Object.assign({}, folderDialog, { name: event.target.value })),
									}),
								),
								h(
									'label',
									{ className: 'ots-field' },
									h('span', { className: 'ots-field-label' }, t('library.folderParent')),
									h(
										'select',
										{
											className: 'ots-select',
											value: folderDialog.parentId ?? '',
											'aria-label': t('library.folderParent'),
											onChange: (event) =>
												setFolderDialog(
													Object.assign({}, folderDialog, { parentId: event.target.value === '' ? null : event.target.value }),
												),
										},
										h('option', { value: '' }, t('library.rootFolder')),
										folderOptions
											.filter((folder) => folderDialog.mode !== 'rename' || folder.id !== folderDialog.id)
											.map((folder) =>
												h('option', { key: folder.id, value: folder.id }, `${'  '.repeat(folder.depth)}${folder.name}`),
											),
									),
								),
								folderDialog.error ? h('p', { className: 'ots-modal-error', role: 'alert' }, folderDialog.error) : null,
							),
							h(
								'div',
								{ className: 'ots-modal-actions' },
								h(Btn, { variant: 'ghost', onClick: () => setFolderDialog(null) }, t('actions.cancel')),
								h(
									Btn,
									{ variant: 'primary', onClick: saveFolder },
									folderDialog.mode === 'create' ? t('library.createFolder') : t('library.save'),
								),
							),
						),
					)
				: null;
			const deleteFolderDialog = deletingFolder
				? h(
						'div',
						{
							className: 'ots-modal-backdrop ots-modal-fixed',
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': t('library.deleteFolderTitle'),
							onPointerDown: (event) => {
								if (event.target === event.currentTarget) setDeletingFolder(null);
							},
						},
						h(
							'div',
							{ className: 'ots-modal' },
							h('h2', { className: 'ots-modal-title' }, t('library.deleteFolderTitle')),
							h('p', { className: 'ots-modal-hint' }, deletingFolder.name),
							h('p', { className: 'ots-modal-hint' }, t('library.deleteFolderHint')),
							h(
								'div',
								{ className: 'ots-modal-actions' },
								h(Btn, { variant: 'ghost', onClick: () => setDeletingFolder(null) }, t('actions.cancel')),
								h(Btn, { variant: 'primary', onClick: confirmDeleteFolder }, t('library.deleteFolderConfirm')),
							),
						),
					)
				: null;
			const moveDialog = moving
				? h(
						'div',
						{
							className: 'ots-modal-backdrop ots-modal-fixed',
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': t('library.moveTitle'),
							onPointerDown: (event) => {
								if (event.target === event.currentTarget) setMoving(null);
							},
						},
						h(
							'div',
							{ className: 'ots-modal' },
							h('h2', { className: 'ots-modal-title' }, t('library.moveTitle')),
							h('p', { className: 'ots-modal-hint' }, moving.item.name),
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('library.moveTo')),
								h(
									'select',
									{
										className: 'ots-select',
										value: moving.folderId ?? '',
										'aria-label': t('library.moveTo'),
										onChange: (event) =>
											setMoving(Object.assign({}, moving, { folderId: event.target.value === '' ? null : event.target.value })),
									},
									h('option', { value: '' }, t('library.rootFolder')),
									folderOptions.map((folder) =>
										h('option', { key: folder.id, value: folder.id }, `${'  '.repeat(folder.depth)}${folder.name}`),
									),
								),
							),
							moving.error ? h('p', { className: 'ots-modal-error', role: 'alert' }, moving.error) : null,
							h(
								'div',
								{ className: 'ots-modal-actions' },
								h(Btn, { variant: 'ghost', onClick: () => setMoving(null) }, t('actions.cancel')),
								h(Btn, { variant: 'primary', onClick: saveMove }, t('library.moveConfirm')),
							),
						),
					)
				: null;

			return h(
				'div',
				{ className: 'ots-library-panel' },
				folderTree,
				toolbar,
				grid,
				editDialog,
				deleteDialog,
				importDialog,
				folderDialogElement,
				deleteFolderDialog,
				moveDialog,
			);
		}

		function ProjectSearch(props) {
			const { t, onOpenResult } = props;
			const [query, setQuery] = React.useState('');
			const [submitted, setSubmitted] = React.useState('');
			const [results, setResults] = React.useState(null);
			const [loading, setLoading] = React.useState(false);
			const [error, setError] = React.useState(null);
			const runSearch = async (event) => {
				if (event && typeof event.preventDefault === 'function') event.preventDefault();
				const needle = query.trim();
				if (needle.length === 0) {
					setSubmitted('');
					setResults(null);
					setError(null);
					return;
				}
				setLoading(true);
				setError(null);
				try {
					const data = await hostPost('search', { query: needle });
					setResults(data && Array.isArray(data.results) ? data.results : []);
					setSubmitted(needle);
				} catch (issue) {
					setError(t('search.error', { message: issue && issue.message ? issue.message : String(issue) }));
					setResults(null);
				} finally {
					setLoading(false);
				}
			};
			const clearSearch = () => {
				setQuery('');
				setSubmitted('');
				setResults(null);
				setError(null);
			};
			const renderGroup = (title, list) =>
				list.length === 0
					? null
					: h(
							'div',
							{ className: 'ots-search-group' },
							h('div', { className: 'ots-search-group-title' }, title),
							list.map((result, index) =>
								h(
									'button',
									{
										type: 'button',
										key: `${result.kind || 'result'}-${result.mediaId || ''}-${index}`,
										className: 'ots-search-result',
										title: result.snippet || result.name,
										onClick: () => onOpenResult(result),
									},
									h('span', { className: 'ots-search-result-name' }, result.name || result.mediaId || ''),
									h('span', { className: 'ots-search-result-snippet' }, result.snippet || ''),
									Number.isFinite(Number(result.startSeconds))
										? h('span', { className: 'ots-search-result-time' }, formatClock(Number(result.startSeconds)))
										: null,
								),
							),
						);
			const mediaResults = results ? results.filter((result) => result.kind !== 'transcript' && result.kind !== 'vision') : [];
			const transcriptResults = results ? results.filter((result) => result.kind === 'transcript') : [];
			const visionResults = results ? results.filter((result) => result.kind === 'vision') : [];
			return h(
				'div',
				{ className: 'ots-search' },
				h(
					'form',
					{ className: 'ots-search-row', onSubmit: runSearch },
					h('input', {
						className: 'ots-input',
						type: 'search',
						value: query,
						placeholder: t('search.placeholder'),
						'aria-label': t('search.placeholder'),
						onChange: (event) => setQuery(event.target.value),
					}),
					h(
						'button',
						{ type: 'submit', className: 'ots-btn ots-btn-outline', disabled: loading },
						loading ? t('search.loading') : t('search.action'),
					),
					submitted.length > 0 ? h(Btn, { variant: 'ghost', onClick: clearSearch }, t('search.clear')) : null,
				),
				loading ? h('div', { className: 'ots-library-status', role: 'status' }, t('search.loading')) : null,
				error ? h('div', { className: 'ots-search-error', role: 'alert' }, error) : null,
				results && !loading
					? results.length === 0
						? h('div', { className: 'ots-library-status' }, t('search.noResults', { query: submitted }))
						: h(
								'div',
								{ className: 'ots-search-results' },
								renderGroup(t('search.transcripts'), transcriptResults),
								renderGroup(t('search.vision'), visionResults),
								renderGroup(t('search.media'), mediaResults),
							)
					: null,
			);
		}

		function TranscriptsPanel(props) {
			const { t, asr, onCreateCaptions } = props;
			const [transcripts, setTranscripts] = React.useState([]);
			const [loading, setLoading] = React.useState(true);
			const [error, setError] = React.useState(null);
			const load = async () => {
				setLoading(true);
				setError(null);
				try {
					const data = await hostRequest('transcripts');
					setTranscripts(data && Array.isArray(data.transcripts) ? data.transcripts : []);
				} catch (issue) {
					setError(t('transcribe.loadError', { message: issue && issue.message ? issue.message : String(issue) }));
				} finally {
					setLoading(false);
				}
			};
			React.useEffect(() => {
				void load();
			}, []);
			const configured = asrConfigured(asr);
			const keyRef = asrKeyRef(asr);
			const asrDetails = asr
				? [
						{ key: t('transcribe.endpoint'), value: asr.url || '—' },
						{ key: t('transcribe.model'), value: asr.model || '—' },
						{ key: t('transcribe.language'), value: asr.language || 'auto' },
						{ key: t('transcribe.keyRef'), value: asr.keyRef || keyRef },
						{ key: t('transcribe.loopback'), value: asr.loopback ? t('common.yes') : t('common.no') },
					]
				: [];
			return h(
				'div',
				{ className: 'ots-transcripts' },
				h(
					'div',
					{ className: 'ots-asr-card', 'data-configured': configured ? 'true' : 'false' },
					h(
						'div',
						{ className: 'ots-asr-head' },
						h('span', { className: 'ots-asr-title' }, t('transcribe.asrTitle')),
						h(
							'span',
							{ className: 'ots-pill', 'data-ok': configured ? 'true' : 'false' },
							h('span', { className: 'ots-pill-dot' }),
							configured ? t('transcribe.asrReady') : t('transcribe.asrMissing'),
						),
					),
					asr && asr.error ? h('p', { className: 'ots-note', 'data-warn': 'true' }, asr.error) : null,
					!configured ? h('p', { className: 'ots-note', 'data-warn': 'true' }, t('transcribe.asrHint', { keyRef })) : null,
					asr
						? h(
								'div',
								{ className: 'ots-asr-details' },
								asrDetails.map((row) =>
									h(
										'div',
										{ className: 'ots-asr-row', key: row.key },
										h('span', { className: 'ots-asr-key' }, row.key),
										h('span', { className: 'ots-asr-value', title: row.value }, row.value),
									),
								),
							)
						: h('p', { className: 'ots-note' }, t('transcribe.asrUnknown')),
				),
				h(
					'div',
					{ className: 'ots-library-actions-row' },
					h('span', { className: 'ots-library-group-title' }, t('transcribe.transcriptsTitle')),
					h(Btn, { variant: 'outline', onClick: () => void load(), disabled: loading }, t('transcribe.refresh')),
				),
				loading
					? h('div', { className: 'ots-library-status', role: 'status' }, t('transcribe.loading'))
					: error
						? h(
								'div',
								{ className: 'ots-library-status ots-library-error', role: 'alert' },
								h('span', {}, error),
								h(Btn, { variant: 'outline', onClick: () => void load() }, t('library.retry')),
							)
						: transcripts.length === 0
							? h(
									'div',
									{ className: 'ots-media-empty' },
									h('span', { className: 'ots-media-empty-title' }, t('transcribe.empty')),
									h('span', {}, t('transcribe.emptyHint')),
								)
							: h(
									'div',
									{ className: 'ots-transcript-list' },
									transcripts.map((transcript) => {
										const created = Number(transcript.createdAt);
										return h(
											'div',
											{ className: 'ots-transcript-row', key: transcript.mediaId || transcript.mediaName },
											h(
												'div',
												{ className: 'ots-transcript-row-head' },
												h('span', { className: 'ots-transcript-name', title: transcript.mediaName }, transcript.mediaName || transcript.mediaId || ''),
												h('span', { className: 'ots-transcript-meta' }, t('transcribe.segmentCount', { count: Array.isArray(transcript.segments) ? transcript.segments.length : 0 })),
											),
											h(
												'div',
												{ className: 'ots-transcript-meta' },
												[transcript.language || null, transcript.model || null, Number.isFinite(created) && created > 0 ? new Date(created).toLocaleString() : null]
													.filter(Boolean)
													.join(' · '),
											),
											typeof transcript.text === 'string' && transcript.text.length > 0
												? h('p', { className: 'ots-transcript-snippet' }, transcript.text.slice(0, 220))
												: null,
											h(
												ButtonRow,
												null,
												h(Btn, { variant: 'outline', onClick: () => onCreateCaptions(transcript) }, t('transcribe.createCaptions')),
											),
										);
									}),
								),
			);
		}

		function ButtonRow(props) {
			return h('div', { className: 'ots-library-actions-row' }, props.children);
		}

		function GeneratePanel(props) {
			const { t, generation, onState, showNotice, onGenerated } = props;
			const [providers, setProviders] = React.useState(generation || null);
			const [imagePrompt, setImagePrompt] = React.useState('');
			const [imageSize, setImageSize] = React.useState('1024x1024');
			const [videoPrompt, setVideoPrompt] = React.useState('');
			const [videoAspect, setVideoAspect] = React.useState('16:9');
			const [videoDuration, setVideoDuration] = React.useState('5');
			const [speechText, setSpeechText] = React.useState('');
			const [voice, setVoice] = React.useState('alloy');
			const [speechModel, setSpeechModel] = React.useState('');
			const [busy, setBusy] = React.useState(null);
			const [error, setError] = React.useState(null);
			React.useEffect(() => {
				let active = true;
				hostRequest('generate/providers')
					.then((data) => {
						if (active) setProviders(data);
					})
					.catch(() => {
						/* fall back to state.generation */
					});
				return () => {
					active = false;
				};
			}, []);
			const current = providers || generation || null;
			const imageInfo = current && current.image ? current.image : null;
			const speechInfo = current && current.speech ? current.speech : null;
			const videoInfo = current && current.video ? current.video : null;
			const imageConfigured = !imageInfo || imageInfo.configured !== false;
			const speechConfigured = !speechInfo || speechInfo.configured !== false;
			const videoConfigured = !videoInfo || videoInfo.configured !== false;
			const anyMissing =
				(imageInfo && imageInfo.configured === false) ||
				(speechInfo && speechInfo.configured === false) ||
				(videoInfo && videoInfo.configured === false);
			const renderProvider = (label, info) =>
				h(
					'div',
					{ className: 'ots-generate-provider' },
					h('span', { className: 'ots-generate-provider-name' }, label),
					h(
						'span',
						{ className: 'ots-generate-provider-id', title: info && info.baseUrl ? info.baseUrl : '' },
						info ? `${info.model || '—'}${info.baseUrl ? ` · ${info.baseUrl}` : ''}` : t('generate.unknown'),
					),
					h(
						'span',
						{ className: 'ots-pill', 'data-ok': info && info.configured === false ? 'false' : 'true' },
						h('span', { className: 'ots-pill-dot' }),
						info && info.configured === false ? t('generate.notConfigured') : t('generate.configured'),
					),
				);
			const runImage = async () => {
				const prompt = imagePrompt.trim();
				if (prompt.length === 0 || busy !== null) return;
				setBusy('image');
				setError(null);
				try {
					const payload = await hostPost('generate/image', { prompt, size: imageSize });
					if (typeof onState === 'function') onState(payload);
					setImagePrompt('');
					showNotice(t('generate.imageDone'));
					if (typeof onGenerated === 'function') onGenerated();
				} catch (issue) {
					setError(t('generate.error', { message: issue && issue.message ? issue.message : String(issue) }));
				} finally {
					setBusy(null);
				}
			};
			const runVideo = async () => {
				const prompt = videoPrompt.trim();
				if (prompt.length === 0 || busy !== null) return;
				setBusy('video');
				setError(null);
				try {
					const payload = await hostPost('generate/video', {
						prompt,
						aspectRatio: videoAspect,
						duration: videoDuration,
					});
					if (typeof onState === 'function') onState(payload);
					setVideoPrompt('');
					showNotice(t('generate.videoDone'));
					if (typeof onGenerated === 'function') onGenerated();
				} catch (issue) {
					setError(t('generate.error', { message: issue && issue.message ? issue.message : String(issue) }));
				} finally {
					setBusy(null);
				}
			};
			const runSpeech = async () => {
				const text = speechText.trim();
				if (text.length === 0 || busy !== null) return;
				setBusy('speech');
				setError(null);
				try {
					const body = { text, voice };
					if (speechModel.trim().length > 0) body.model = speechModel.trim();
					const payload = await hostPost('generate/tts', body);
					if (typeof onState === 'function') onState(payload);
					setSpeechText('');
					showNotice(t('generate.speechDone'));
					if (typeof onGenerated === 'function') onGenerated();
				} catch (issue) {
					setError(t('generate.error', { message: issue && issue.message ? issue.message : String(issue) }));
				} finally {
					setBusy(null);
				}
			};
			return h(
				'div',
				{ className: 'ots-generate' },
				h(
					'div',
					{ className: 'ots-generate-card' },
					h(
						'div',
						{ className: 'ots-generate-head' },
						h('span', { className: 'ots-generate-title' }, t('generate.providers')),
					),
					renderProvider(t('generate.imageProvider'), imageInfo),
					renderProvider(t('generate.videoProvider'), videoInfo),
					renderProvider(t('generate.speechProvider'), speechInfo),
					!current ? h('p', { className: 'ots-note' }, t('generate.unknown')) : null,
					anyMissing ? h('p', { className: 'ots-note', 'data-warn': 'true' }, t('generate.hint')) : null,
				),
				error ? h('div', { className: 'ots-generate-error', role: 'alert' }, error) : null,
				busy ? h('div', { className: 'ots-library-status', role: 'status', 'aria-live': 'polite' }, t('generate.working')) : null,
				h(
					'div',
					{ className: 'ots-generate-card' },
					h(
						'div',
						{ className: 'ots-generate-head' },
						h('span', { className: 'ots-generate-title' }, t('generate.imageTitle')),
						h(
							'span',
							{ className: 'ots-pill', 'data-ok': imageConfigured ? 'true' : 'false' },
							h('span', { className: 'ots-pill-dot' }),
							imageConfigured ? t('generate.configured') : t('generate.notConfigured'),
						),
					),
					h('textarea', {
						className: 'ots-textarea',
						value: imagePrompt,
						placeholder: t('generate.imagePromptPlaceholder'),
						'aria-label': t('generate.imagePrompt'),
						onChange: (event) => setImagePrompt(event.target.value),
					}),
					h(
						'label',
						{ className: 'ots-field' },
						h('span', { className: 'ots-field-label' }, t('generate.imageSize')),
						h(
							'select',
							{
								className: 'ots-select',
								value: imageSize,
								'aria-label': t('generate.imageSize'),
								onChange: (event) => setImageSize(event.target.value),
							},
							['1024x1024', '1024x1536', '1536x1024'].map((size) =>
								h('option', { key: size, value: size }, size.replace('x', ' × ')),
							),
						),
					),
					h(
						'div',
						{ className: 'ots-generate-actions' },
						h(
							'button',
							{
								type: 'button',
								className: 'ots-btn ots-btn-primary',
								disabled: busy !== null || imagePrompt.trim().length === 0 || !imageConfigured,
								onClick: runImage,
							},
							busy === 'image' ? t('generate.working') : t('generate.imageAction'),
						),
					),
				),
				h(
					'div',
					{ className: 'ots-generate-card' },
					h(
						'div',
						{ className: 'ots-generate-head' },
						h('span', { className: 'ots-generate-title' }, t('generate.videoTitle')),
						h(
							'span',
							{ className: 'ots-pill', 'data-ok': videoConfigured ? 'true' : 'false' },
							h('span', { className: 'ots-pill-dot' }),
							videoConfigured ? t('generate.configured') : t('generate.notConfigured'),
						),
					),
					h('textarea', {
						className: 'ots-textarea',
						value: videoPrompt,
						placeholder: t('generate.videoPromptPlaceholder'),
						'aria-label': t('generate.videoPrompt'),
						onChange: (event) => setVideoPrompt(event.target.value),
					}),
					h(
						'div',
						{ className: 'ots-field-grid' },
						h(
							'label',
							{ className: 'ots-field' },
							h('span', { className: 'ots-field-label' }, t('generate.aspectRatio')),
							h(
								'select',
								{
									className: 'ots-select',
									value: videoAspect,
									'aria-label': t('generate.aspectRatio'),
									onChange: (event) => setVideoAspect(event.target.value),
								},
								['16:9', '9:16', '1:1'].map((value) => h('option', { key: value, value }, value)),
							),
						),
						h(
							'label',
							{ className: 'ots-field' },
							h('span', { className: 'ots-field-label' }, t('generate.duration')),
							h(
								'select',
								{
									className: 'ots-select',
									value: videoDuration,
									'aria-label': t('generate.duration'),
									onChange: (event) => setVideoDuration(event.target.value),
								},
								[
									{ value: '5', label: t('generate.duration5') },
									{ value: '10', label: t('generate.duration10') },
								].map((option) => h('option', { key: option.value, value: option.value }, option.label)),
							),
						),
					),
					h(
						'div',
						{ className: 'ots-generate-actions' },
						h(
							'button',
							{
								type: 'button',
								className: 'ots-btn ots-btn-primary',
								disabled: busy !== null || videoPrompt.trim().length === 0 || !videoConfigured,
								onClick: runVideo,
							},
							busy === 'video' ? t('generate.working') : t('generate.videoAction'),
						),
					),
				),
				h(
					'div',
					{ className: 'ots-generate-card' },
					h(
						'div',
						{ className: 'ots-generate-head' },
						h('span', { className: 'ots-generate-title' }, t('generate.speechTitle')),
						h(
							'span',
							{ className: 'ots-pill', 'data-ok': speechConfigured ? 'true' : 'false' },
							h('span', { className: 'ots-pill-dot' }),
							speechConfigured ? t('generate.configured') : t('generate.notConfigured'),
						),
					),
					h('textarea', {
						className: 'ots-textarea',
						value: speechText,
						placeholder: t('generate.speechTextPlaceholder'),
						'aria-label': t('generate.speechText'),
						onChange: (event) => setSpeechText(event.target.value),
					}),
					h(
						'div',
						{ className: 'ots-field-grid' },
						h(
							'label',
							{ className: 'ots-field' },
							h('span', { className: 'ots-field-label' }, t('generate.voice')),
							h(
								'select',
								{
									className: 'ots-select',
									value: voice,
									'aria-label': t('generate.voice'),
									onChange: (event) => setVoice(event.target.value),
								},
								['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((name) =>
									h('option', { key: name, value: name }, name),
								),
							),
						),
						h(
							'label',
							{ className: 'ots-field' },
							h('span', { className: 'ots-field-label' }, t('generate.model')),
							h('input', {
								className: 'ots-input',
								type: 'text',
								value: speechModel,
								placeholder: speechInfo && speechInfo.model ? speechInfo.model : t('generate.modelPlaceholder'),
								'aria-label': t('generate.model'),
								onChange: (event) => setSpeechModel(event.target.value),
							}),
						),
					),
					h(
						'div',
						{ className: 'ots-generate-actions' },
						h(
							'button',
							{
								type: 'button',
								className: 'ots-btn ots-btn-primary',
								disabled: busy !== null || speechText.trim().length === 0 || !speechConfigured,
								onClick: runSpeech,
							},
							busy === 'speech' ? t('generate.working') : t('generate.speechAction'),
						),
					),
				),
			);
		}

		function MediaLibrary(props) {
			const {
				t,
				project,
				onImport,
				onAddMedia,
				onDropFiles,
				importing,
				uploading,
				ffmpegAvailable,
				pickDirectory,
				onLibraryState,
				showNotice,
				asr,
				generation,
				onOpenSearchResult,
				onCreateCaptionsFromTranscript,
				missingMediaIds,
				onMediaRelinked,
			} = props;
			const [tab, setTab] = React.useState('project');
			const [transcribingId, setTranscribingId] = React.useState(null);
			const [transcribeError, setTranscribeError] = React.useState(null);
			const [transcriptPreview, setTranscriptPreview] = React.useState(null);
			const [visionRecords, setVisionRecords] = React.useState([]);
			const [visionBusyId, setVisionBusyId] = React.useState(null);
			const [visionError, setVisionError] = React.useState(null);
			const [proxyBusyId, setProxyBusyId] = React.useState(null);
			const [proxyKnownIds, setProxyKnownIds] = React.useState(() => new Set());
			const [relinking, setRelinking] = React.useState(null);
			const [relinkBusy, setRelinkBusy] = React.useState(false);
			const media = project ? project.media : [];
			const fps = project ? project.fps : 30;
			const asrReady = !asr || asrConfigured(asr);
			const fetchTranscriptFor = async (mediaId) => {
				const data = await hostRequest('transcripts');
				const list = data && Array.isArray(data.transcripts) ? data.transcripts : [];
				return list.find((transcript) => transcript && transcript.mediaId === mediaId) || null;
			};
			const runTranscribe = async (item, createCaptions) => {
				if (transcribingId !== null) return;
				setTranscribingId(item.id);
				setTranscribeError(null);
				try {
					const response = await hostPost('transcribe', {
						mediaId: item.id,
						createCaptions: createCaptions === true,
					});
					let transcript = response && response.transcript ? response.transcript : null;
					if (response && response.version === 1 && 'project' in response) {
						if (typeof onLibraryState === 'function') onLibraryState(response);
						try {
							transcript = await fetchTranscriptFor(item.id);
						} catch (issue) {
							transcript = null;
						}
						showNotice(t('transcribe.captionsAdded', { name: item.name }));
					} else if (transcript) {
						showNotice(t('transcribe.done', { name: item.name }));
					} else {
						showNotice(t('transcribe.noCaptions', { name: item.name }));
					}
					setTranscriptPreview({ mediaId: item.id, mediaName: item.name, transcript });
				} catch (issue) {
					const raw = issue && issue.message ? issue.message : String(issue);
					setTranscribeError(t('transcribe.error', { name: item.name, message: raw }));
				} finally {
					setTranscribingId(null);
				}
			};
			const handleDrop = (event) => {
				event.preventDefault();
				if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
					onDropFiles(event.dataTransfer.files);
				}
			};
			const visionReady = !generation || !generation.image || generation.image.configured !== false;
			const loadVision = async () => {
				try {
					const data = await hostRequest('vision');
					setVisionRecords(data && Array.isArray(data.records) ? data.records : []);
				} catch (issue) {
					/* vision is optional; keep the panel usable */
				}
			};
			React.useEffect(() => {
				void loadVision();
			}, []);
			const indexVision = async (item) => {
				if (visionBusyId !== null) return;
				setVisionBusyId(item.id);
				setVisionError(null);
				try {
					const data = await hostPost('vision/index', { mediaId: item.id });
					const record = data && data.record ? data.record : null;
					if (record) {
						setVisionRecords((previous) => [record, ...previous.filter((entry) => entry.mediaId !== record.mediaId)]);
					}
					showNotice(t('vision.indexed', { name: item.name }));
				} catch (issue) {
					setVisionError(t('vision.error', { message: issue && issue.message ? issue.message : String(issue) }));
				} finally {
					setVisionBusyId(null);
				}
			};
			const relinkErrorText = (issue) =>
				t('media.relinkError', { message: issue && issue.message ? issue.message : String(issue) });
			const relinkMedia = async () => {
				if (!relinking || relinkBusy) return;
				const path = String(relinking.path || '').trim();
				if (path.length === 0) {
					setRelinking(Object.assign({}, relinking, { error: t('media.relinkPathRequired') }));
					return;
				}
				setRelinkBusy(true);
				setRelinking(Object.assign({}, relinking, { error: null }));
				try {
					const payload = await hostPost('media/relink', { mediaId: relinking.item.id, path });
					if (typeof onLibraryState === 'function') onLibraryState(payload);
					if (typeof onMediaRelinked === 'function') onMediaRelinked(relinking.item.id);
					showNotice(t('media.relinked', { name: relinking.item.name }));
					setRelinking(null);
				} catch (issue) {
					setRelinking(Object.assign({}, relinking, { error: relinkErrorText(issue) }));
				} finally {
					setRelinkBusy(false);
				}
			};
			const generateProxy = async (item) => {
				if (proxyBusyId !== null) return;
				setProxyBusyId(item.id);
				try {
					const response = await fetch(mediaProxyUrl(item.id), { method: 'HEAD' });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					setProxyKnownIds((previous) => {
						const next = new Set(previous);
						next.add(item.id);
						return next;
					});
					showNotice(t('proxy.generated', { name: item.name }));
				} catch (issue) {
					showNotice(t('proxy.generateError', { name: item.name, message: issue && issue.message ? issue.message : String(issue) }));
				} finally {
					setProxyBusyId(null);
				}
			};
			const transcriptPreviewPanel = transcriptPreview
				? h(
						'div',
						{ className: 'ots-transcript-preview' },
						h(
							'div',
							{ className: 'ots-transcript-preview-head' },
							h('strong', {}, t('transcribe.preview', { name: transcriptPreview.mediaName || '' })),
							h(
								'button',
								{
									type: 'button',
									className: 'ots-mini',
									onClick: () => setTranscriptPreview(null),
									title: t('transcribe.closePreview'),
									'aria-label': t('transcribe.closePreview'),
								},
								'\u00d7',
							),
						),
						transcriptPreview.transcript
							? transcriptPreviewLines(transcriptPreview.transcript, 4).map((line, index) =>
									h(
										'div',
										{ className: 'ots-transcript-preview-seg', key: index },
										h('span', { className: 'ots-transcript-preview-time' }, line.time),
										h('span', {}, line.text),
									),
								)
							: h('p', { className: 'ots-note' }, t('transcribe.noTranscriptPreview')),
					)
				: null;
			const visionPanel =
				visionRecords.length > 0 || visionError || !visionReady
					? h(
							'div',
							{ className: 'ots-vision-panel' },
							h(
								'div',
								{ className: 'ots-subhead' },
								h('span', { className: 'ots-section-title' }, t('vision.title')),
								h(Btn, { variant: 'ghost', onClick: () => void loadVision() }, t('vision.refresh')),
							),
							!visionReady ? h('p', { className: 'ots-note' }, t('vision.hint')) : null,
							visionError ? h('div', { className: 'ots-generate-error', role: 'alert' }, visionError) : null,
							visionRecords.map((record) =>
								h(
									'div',
									{ className: 'ots-vision-row', key: record.mediaId },
									h('span', { className: 'ots-vision-name', title: record.mediaName }, record.mediaName || record.mediaId || ''),
									h('span', { className: 'ots-vision-desc' }, record.description || ''),
								),
							),
						)
					: null;
			const projectContent =
				media.length === 0
					? h(
							'div',
							{ className: 'ots-media-empty' },
							h('span', { className: 'ots-media-empty-title' }, t('media.empty')),
							h('span', {}, t('media.emptyHint')),
							h('div', { className: 'ots-drop-hint' }, t('media.dropHint')),
						)
					: h(
							'div',
							{ className: 'ots-media-grid' },
							media.map((item) =>
								h(
									'div',
									{
										key: item.id,
										className: 'ots-media-card',
										title: item.name,
										draggable: true,
										'data-media-id': item.id,
										'data-missing':
											mediaMissingOf(item) || (missingMediaIds && missingMediaIds.has(item.id)) ? 'true' : 'false',
										onDragStart: (event) => {
											if (!event.dataTransfer) return;
											event.dataTransfer.effectAllowed = 'copy';
											event.dataTransfer.setData('application/x-opentake-media', item.id);
											event.dataTransfer.setData('text/plain', item.id);
										},
										onDoubleClick: () => onAddMedia(item.id, null, null),
									},
									h(
										'div',
										{ className: 'ots-media-thumb' },
										h(MediaThumb, { media: item, t }),
										item.hasProxy === true || proxyKnownIds.has(item.id)
											? h('span', { className: 'ots-proxy-chip', title: t('proxy.badgeTitle') }, t('proxy.badge'))
											: null,
										mediaMissingOf(item) || (missingMediaIds && missingMediaIds.has(item.id))
											? h('span', { className: 'ots-media-offline', title: t('media.offline') }, t('media.offline'))
											: null,
										h(
											'button',
											{
												type: 'button',
												className: 'ots-media-add',
												onClick: (event) => {
													event.stopPropagation();
													onAddMedia(item.id, null, null);
												},
												title: t('media.addToTimeline'),
												'aria-label': t('media.addToTimeline'),
											},
											'+',
										),
									),
									h(
										'div',
										{ className: 'ots-media-meta' },
										h('span', { className: 'ots-media-name' }, item.name),
										h(
											'span',
											{ className: 'ots-media-sub' },
											h('span', {}, t(`media.${item.kind}`)),
											h(
												'span',
												{},
												item.durationFrames === null
													? t('media.still')
													: formatDurationFrames(item.durationFrames, fps),
											),
										),
									),
									item.kind === 'video' || item.kind === 'audio' || item.kind === 'image'
										? h(
												'div',
												{ className: 'ots-media-actions' },
												item.kind === 'video' || item.kind === 'audio'
													? h(
															React.Fragment,
															null,
															h(
																'button',
																{
																	type: 'button',
																	className: 'ots-mini',
																	disabled: transcribingId !== null || !asrReady,
																	title: asrReady ? t('transcribe.actionTitle') : t('transcribe.asrHint', { keyRef: asrKeyRef(asr) }),
																	onClick: () => void runTranscribe(item, true),
																},
																transcribingId === item.id ? t('transcribe.busy') : t('transcribe.action'),
																),
																h(
																	'button',
																	{
																		type: 'button',
																		className: 'ots-mini',
																		disabled: transcribingId !== null || !asrReady,
																		title: t('transcribe.onlyTitle'),
																		'aria-label': t('transcribe.onlyTitle'),
																		onClick: () => void runTranscribe(item, false),
																	},
																	'T',
																),
														)
													: null,
												mediaMissingOf(item) || (missingMediaIds && missingMediaIds.has(item.id))
													? h(
															'button',
															{
																type: 'button',
																className: 'ots-mini',
																'data-danger': 'true',
																title: t('media.relinkTitle'),
																'aria-label': t('media.relink'),
																onClick: () => setRelinking({ item, path: '', error: null }),
															},
															t('media.relink'),
														)
													: null,
												item.kind === 'video'
													? h(
															'button',
															{
																type: 'button',
																className: 'ots-mini',
																disabled: proxyBusyId !== null,
																title: t('proxy.generateTitle'),
																'aria-label': t('proxy.generate'),
																onClick: () => void generateProxy(item),
															},
															proxyBusyId === item.id ? t('proxy.generating') : t('proxy.generate'),
														)
													: null,
												item.kind === 'video' || item.kind === 'image'
													? h(
															'button',
															{
																type: 'button',
																className: 'ots-mini',
																disabled: visionBusyId !== null || !visionReady,
																title: visionReady ? t('vision.indexTitle') : t('vision.hint'),
																'aria-label': t('vision.index'),
																onClick: () => void indexVision(item),
															},
															visionBusyId === item.id ? t('vision.indexing') : t('vision.index'),
														)
													: null,
												)
										: null,
								),
							),
						);
			const relinkDialog = relinking
				? h(
						'div',
						{
							className: 'ots-modal-backdrop ots-modal-fixed',
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': t('media.relinkTitle'),
							onPointerDown: (event) => {
								if (event.target === event.currentTarget && !relinkBusy) setRelinking(null);
							},
						},
						h(
							'div',
							{ className: 'ots-modal' },
							h('h2', { className: 'ots-modal-title' }, t('media.relinkTitle')),
							h('p', { className: 'ots-modal-hint' }, relinking.item.name),
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('media.relinkPath')),
								h('input', {
									className: 'ots-input',
									type: 'text',
									value: relinking.path,
									placeholder: t('dialog.pathPlaceholder'),
									'aria-label': t('media.relinkPath'),
									onChange: (event) => setRelinking(Object.assign({}, relinking, { path: event.target.value })),
								}),
							),
							h('p', { className: 'ots-modal-hint' }, t('media.relinkHint')),
							relinking.error ? h('p', { className: 'ots-modal-error', role: 'alert' }, relinking.error) : null,
							h(
								'div',
								{ className: 'ots-modal-actions' },
								h(Btn, { variant: 'ghost', onClick: () => setRelinking(null), disabled: relinkBusy }, t('actions.cancel')),
								h(Btn, { variant: 'primary', onClick: relinkMedia, disabled: relinkBusy }, t('media.relinkConfirm')),
							),
						),
					)
				: null;
			return h(
				'aside',
				{ className: 'ots-panel ots-media', 'aria-label': t('media.title') },
				h(
					'div',
					{ className: 'ots-panel-head' },
					h('span', { className: 'ots-panel-title' }, t('media.title')),
					importing ? h('span', { className: 'ots-panel-sub', role: 'status' }, t('media.importing')) : null,
					tab === 'project'
						? h(
								Btn,
								{
									variant: 'outline',
									onClick: onImport,
									disabled: importing || !ffmpegAvailable,
									title: ffmpegAvailable ? t('media.import') : t('ffmpeg.missingTitle'),
								},
								t('media.import'),
							)
						: null,
				),
				h(
					'div',
					{ className: 'ots-media-tabs', role: 'tablist', 'aria-label': t('media.title') },
					h(
						'button',
						{
							type: 'button',
							role: 'tab',
							className: 'ots-media-tab',
							'data-active': tab === 'project' ? 'true' : 'false',
							'aria-selected': tab === 'project' ? 'true' : 'false',
							onClick: () => setTab('project'),
						},
						t('library.tabProject'),
					),
					h(
						'button',
						{
							type: 'button',
							role: 'tab',
							className: 'ots-media-tab',
							'data-active': tab === 'library' ? 'true' : 'false',
							'aria-selected': tab === 'library' ? 'true' : 'false',
							onClick: () => setTab('library'),
						},
						t('library.tabLibrary'),
					),
					h(
						'button',
						{
							type: 'button',
							role: 'tab',
							className: 'ots-media-tab',
							'data-active': tab === 'transcripts' ? 'true' : 'false',
							'aria-selected': tab === 'transcripts' ? 'true' : 'false',
							onClick: () => setTab('transcripts'),
						},
						t('transcribe.tabTranscripts'),
					),
					h(
						'button',
						{
							type: 'button',
							role: 'tab',
							className: 'ots-media-tab',
							'data-active': tab === 'generate' ? 'true' : 'false',
							'aria-selected': tab === 'generate' ? 'true' : 'false',
							onClick: () => setTab('generate'),
						},
						t('generate.tab'),
					),
				),
				h(
					'div',
					{
						className: 'ots-panel-body',
						onDragOver: (event) => {
							if (tab === 'project') event.preventDefault();
						},
						onDrop: (event) => {
							if (tab === 'project') handleDrop(event);
						},
					},
					tab === 'library'
						? h(LibraryPanel, {
								t,
								pickDirectory,
								onState: onLibraryState,
								showNotice,
								ffmpegAvailable,
								projectAvailable: Boolean(project),
							})
						: tab === 'generate'
							? h(GeneratePanel, {
									t,
									generation,
									onState: onLibraryState,
									showNotice,
									onGenerated: () => setTab('project'),
								})
							: h(
								ReactFragment,
								null,
								h(ProjectSearch, { t, onOpenResult: onOpenSearchResult }),
								tab === 'project'
									? h(
											ReactFragment,
											null,
											!asrReady
												? h(
														'p',
														{ className: 'ots-media-note', role: 'status' },
														t('transcribe.asrHint', { keyRef: asrKeyRef(asr) }),
													)
												: null,
											transcribeError
												? h(Banner, {
														message: transcribeError,
														tone: 'error',
														onDismiss: () => setTranscribeError(null),
														dismissLabel: t('error.dismiss'),
													})
												: null,
											transcriptPreviewPanel,
											visionPanel,
											projectContent,
											uploading
												? h('div', { className: 'ots-panel-sub', role: 'status' }, uploading)
												: null,
										)
									: h(TranscriptsPanel, {
											t,
											asr,
											onCreateCaptions: onCreateCaptionsFromTranscript,
										}),
							),
				),
				relinkDialog,
			);
		}

		// -------------------------------------------------------------------
		// Preview
		// -------------------------------------------------------------------

		function PreviewPanel(props) {
			const {
				t,
				project,
				playing,
				currentFrame,
				duration,
				loop,
				monitorVolume,
				canvasRef,
				stageRef,
				canvasSize,
				emptyFrame,
				onTogglePlay,
				onToggleLoop,
				onVolumeChange,
				onStepFrame,
				onExportFrame,
				proxyPreview,
				missingMediaIds,
			} = props;
			const fps = project ? project.fps : 30;
			const missingFrame = Boolean(
				project &&
					activeClipsAt(project, currentFrame).some((row) => {
						if (!row.clip.mediaId || row.clip.type === 'audio') return false;
						const media = findMedia(project, row.clip.mediaId);
						return media
							? mediaMissingOf(media) || (missingMediaIds && missingMediaIds.has(media.id))
							: false;
					}),
			);
			return h(
				'section',
				{ className: 'ots-center', 'aria-label': t('preview.canvas') },
				h(
					'div',
					{ className: 'ots-stage', ref: stageRef },
					h(
						'div',
						{
							className: 'ots-canvas-wrap',
							style: { width: canvasSize.width, height: canvasSize.height },
						},
						h('canvas', {
							ref: canvasRef,
							className: 'ots-canvas',
							width: project ? project.width : 16,
							height: project ? project.height : 9,
							'aria-label': t('preview.canvas'),
							role: 'img',
						}),
						emptyFrame ? h('span', { className: 'ots-canvas-hint' }, t('preview.emptyFrame')) : null,
						missingFrame
							? h(
									'div',
									{ className: 'ots-missing-overlay' },
									h('span', { className: 'ots-missing-overlay-title' }, t('media.missingPreview')),
									h('span', { className: 'ots-missing-overlay-hint' }, t('media.missingPreviewHint')),
								)
							: null,
					),
				),
				h(
					'div',
					{ className: 'ots-preview-controls', 'aria-label': t('preview.controls') },
					h(
						Btn,
						{
							variant: 'ghost',
							onClick: () => onStepFrame(-1),
							disabled: !project || duration <= 0,
							title: t('preview.stepBack'),
							'aria-label': t('preview.stepBack'),
						},
						'−1',
					),
					h(
						Btn,
						{
							variant: 'toolbar',
							onClick: onTogglePlay,
							disabled: !project || duration <= 0,
							title: playing ? t('preview.pause') : t('preview.play'),
							'aria-label': playing ? t('preview.pause') : t('preview.play'),
						},
						playing ? '❚❚' : '▶',
					),
					h(
						Btn,
						{
							variant: 'ghost',
							onClick: () => onStepFrame(1),
							disabled: !project || duration <= 0,
							title: t('preview.stepForward'),
							'aria-label': t('preview.stepForward'),
						},
						'+1',
					),
					h(
						Btn,
						{
							variant: 'ghost',
							onClick: onExportFrame,
							disabled: !project,
							title: t('preview.exportFrameTitle'),
							'aria-label': t('preview.exportFrame'),
						},
						t('preview.exportFrame'),
					),
					h(
						Btn,
						{
							variant: 'ghost',
							active: loop,
							onClick: onToggleLoop,
							title: t('preview.loop'),
							'aria-pressed': loop ? 'true' : 'false',
						},
						t('preview.loop'),
					),
					h('span', { className: 'ots-timecode' }, `${formatTimecode(currentFrame, fps)} / ${formatTimecode(duration, fps)}`),
					h('span', { className: 'ots-frame-count' }, `${Math.round(currentFrame)} / ${Math.round(duration)}`),
					proxyPreview
						? h('span', { className: 'ots-proxy-badge', title: t('proxy.badgeTitle') }, t('proxy.badge'))
						: null,
					h('span', { className: 'ots-control-spacer' }),
					h(
						'div',
						{ className: 'ots-volume' },
						h('input', {
							className: 'ots-range',
							type: 'range',
							min: 0,
							max: 1,
							step: 0.01,
							value: monitorVolume,
							'aria-label': t('preview.volume'),
							title: t('preview.volume'),
							onChange: (event) => onVolumeChange(Number(event.target.value)),
						}),
					),
				),
			);
		}

		// -------------------------------------------------------------------
		// Inspector
		// -------------------------------------------------------------------

		function effectLabelKey(type) {
			return `effect.type${type.charAt(0).toUpperCase()}${type.slice(1)}`;
		}

		function effectParamDefs(type) {
			switch (type) {
				case 'brightness':
				case 'contrast':
				case 'saturation':
					return [{ key: 'amount', label: 'effect.paramAmount', min: 0, max: 2, step: 0.01, kind: 'number' }];
				case 'temperature':
					return [{ key: 'amount', label: 'effect.paramAmount', min: -1, max: 1, step: 0.01, kind: 'number' }];
				case 'blur':
					return [{ key: 'radius', label: 'effect.paramRadius', min: 0, max: 30, step: 1, kind: 'number' }];
				case 'sharpen':
					return [{ key: 'amount', label: 'effect.paramAmount', min: 0, max: 2, step: 0.01, kind: 'number' }];
				case 'chromaKey':
					return [
						{ key: 'keyColor', label: 'effect.paramKeyColor', kind: 'color' },
						{ key: 'similarity', label: 'effect.paramSimilarity', min: 0.01, max: 0.5, step: 0.01, kind: 'number' },
						{ key: 'blend', label: 'effect.paramBlend', min: 0, max: 0.5, step: 0.01, kind: 'number' },
					];
				case 'lut':
					return [{ key: 'file', label: 'effect.paramFile', kind: 'text' }];
				default:
					return [];
			}
		}

		function effectPreviewSkipKey(type) {
			if (type === 'chromaKey') return 'effect.previewSkipChromaKey';
			if (type === 'lut') return 'effect.previewSkipLut';
			return null;
		}

		function staticPropertyValue(clip, property) {
			const base = baseTransformForClip(clip);
			if (property === 'volume') return clamp01(finiteNumber(clip.volume, 1));
			if (property === 'opacity') return clamp01(finiteNumber(clip.opacity, 1));
			if (property === 'x') return base.x;
			if (property === 'y') return base.y;
			if (property === 'width') return base.width;
			if (property === 'height') return base.height;
			if (property === 'rotation') return base.rotation;
			return 0;
		}

		function normalizeKeyframeRows(rows, property, duration) {
			const limit = Math.max(1, Math.round(duration));
			const byFrame = new Map();
			for (const row of rows) {
				const frame = clamp(Math.round(finiteNumber(row.frame, 0)), 0, limit);
				let value = finiteNumber(row.value, staticPropertyValueForProperty(property));
				if (property === 'volume' || property === 'opacity' || property === 'x' || property === 'y' || property === 'width' || property === 'height') {
					value = clamp01(value);
				}
				byFrame.set(frame, {
					frame,
					value,
					easing: KEYFRAME_EASINGS.includes(row.easing) ? row.easing : 'linear',
				});
			}
			return Array.from(byFrame.values()).sort((a, b) => a.frame - b.frame);
		}

		function staticPropertyValueForProperty(property) {
			if (property === 'volume' || property === 'opacity') return 1;
			if (property === 'rotation') return 0;
			return 0;
		}

		function KeyframeEditor(props) {
			const { t, clip, currentFrame, onSetKeyframes } = props;
			const [property, setProperty] = React.useState(clip.type === 'audio' ? 'volume' : 'opacity');
			const signature = JSON.stringify(keyframesOf(clip, property));
			const [rows, setRows] = React.useState(() => keyframesOf(clip, property));
			const syncKey = `${clip.id}:${property}:${signature}`;
			React.useEffect(() => {
				setRows(keyframesOf(clip, property));
			}, [syncKey]);
			const commit = (nextRows) => {
				const normalized = normalizeKeyframeRows(nextRows, property, clip.durationFrames);
				setRows(normalized);
				onSetKeyframes(property, normalized);
			};
			const updateRow = (index, patch, commitNow) => {
				const next = rows.map((row, rowIndex) => (rowIndex === index ? Object.assign({}, row, patch) : row));
				setRows(next);
				if (commitNow) {
					const normalized = normalizeKeyframeRows(next, property, clip.durationFrames);
					setRows(normalized);
					onSetKeyframes(property, normalized);
				}
			};
			const addAtPlayhead = () => {
				const relative = clamp(Math.round(currentFrame - clip.startFrame), 0, Math.max(1, clip.durationFrames));
				const value = evaluateKeyframes(
					keyframesOf(clip, property),
					relative,
					staticPropertyValue(clip, property),
				);
				const existing = rows.findIndex((row) => Math.round(finiteNumber(row.frame, 0)) === relative);
				const next =
					existing >= 0
						? rows.map((row, index) => (index === existing ? Object.assign({}, row, { value }) : row))
						: rows.concat([{ frame: relative, value, easing: 'linear' }]);
				commit(next);
			};
			const valueStep = property === 'rotation' ? 1 : 0.01;
			return h(
				'div',
				{ className: 'ots-section', key: 'keyframes' },
				h('h3', { className: 'ots-section-title' }, t('inspector.keyframes')),
				h(
					'label',
					{ className: 'ots-field' },
					h('span', { className: 'ots-field-label' }, t('inspector.keyframeProperty')),
					h(
						'select',
						{
							className: 'ots-select',
							value: property,
							onChange: (event) => setProperty(event.target.value),
						},
						KEYFRAME_PROPERTIES.map((name) =>
							h('option', { key: name, value: name }, t(`inspector.${name}`)),
						),
					),
				),
				h(
					Btn,
					{ variant: 'outline', onClick: addAtPlayhead },
					t('inspector.addKeyframe'),
				),
				rows.length === 0
					? h('p', { className: 'ots-hint' }, t('inspector.keyframesEmpty'))
					: h(
							'div',
							{ className: 'ots-effect' },
							rows.map((row, index) =>
								h(
									'div',
									{ className: 'ots-keyframe-row', key: index },
									h('input', {
										className: 'ots-input',
										type: 'number',
										min: 0,
										max: clip.durationFrames,
										step: 1,
										'aria-label': t('inspector.keyframeFrame'),
										title: t('inspector.keyframeFrame'),
										value: row.frame,
										onChange: (event) => updateRow(index, { frame: event.target.value }, false),
										onBlur: () => commit(rows),
									}),
									h('input', {
										className: 'ots-input',
										type: 'number',
										step: valueStep,
										'aria-label': t('inspector.keyframeValue'),
										title: t('inspector.keyframeValue'),
										value: row.value,
										onChange: (event) => updateRow(index, { value: event.target.value }, false),
										onBlur: () => commit(rows),
									}),
									h(
										'select',
										{
											className: 'ots-select',
											value: row.easing,
											'aria-label': t('inspector.keyframeEasing'),
											title: t('inspector.keyframeEasing'),
											onChange: (event) => updateRow(index, { easing: event.target.value }, true),
										},
										KEYFRAME_EASINGS.map((easing) =>
											h('option', { key: easing, value: easing }, t(`easing.${camelEasing(easing)}`)),
										),
									),
									h(
										'button',
										{
											type: 'button',
											className: 'ots-mini',
											'data-danger': 'true',
											'aria-label': t('inspector.removeKeyframe'),
											title: t('inspector.removeKeyframe'),
											onClick: () => commit(rows.filter((unused, rowIndex) => rowIndex !== index)),
										},
										'×',
									),
								),
							),
						),
				h('p', { className: 'ots-hint' }, t('inspector.keyframesHint')),
			);
		}

		function camelEasing(easing) {
			if (easing === 'ease-in') return 'easeIn';
			if (easing === 'ease-out') return 'easeOut';
			if (easing === 'ease-in-out') return 'easeInOut';
			return 'linear';
		}

		function EffectsEditor(props) {
			const { t, clip, onAddEffect, onUpdateEffect, onRemoveEffect, onReorderEffects } = props;
			const [typeToAdd, setTypeToAdd] = React.useState('brightness');
			const effects = clipEffects(clip);
			const move = (index, offset) => {
				const target = index + offset;
				if (target < 0 || target >= effects.length) return;
				const ids = effects.map((effect) => effect.id);
				const swap = ids[index];
				ids[index] = ids[target];
				ids[target] = swap;
				onReorderEffects(ids);
			};
			return h(
				'div',
				{ className: 'ots-section', key: 'effects' },
				h('h3', { className: 'ots-section-title' }, t('inspector.effects')),
				h(
					'div',
					{ className: 'ots-field-row' },
					h(
						'select',
						{
							className: 'ots-select',
							value: typeToAdd,
							'aria-label': t('inspector.effectsAdd'),
							onChange: (event) => setTypeToAdd(event.target.value),
						},
						EFFECT_TYPES.map((type) => h('option', { key: type, value: type }, t(effectLabelKey(type)))),
					),
					h(
						Btn,
						{ variant: 'outline', onClick: () => onAddEffect(typeToAdd) },
						t('inspector.effectsAdd'),
					),
				),
				effects.length === 0
					? h('p', { className: 'ots-hint' }, t('inspector.effectsEmpty'))
					: effects.map((effect, index) => {
							if (!effect) return null;
							const params = effect.params && typeof effect.params === 'object' ? effect.params : {};
							const skipKey = effectPreviewSkipKey(effect.type);
							return h(
								'div',
								{ className: 'ots-effect', key: effect.id || `${effect.type}-${index}` },
								h(
									'div',
									{ className: 'ots-effect-head' },
									h(
										'label',
										{ className: 'ots-check', title: t('inspector.effectsEnable') },
										h('input', {
											type: 'checkbox',
											checked: effect.enabled !== false,
											onChange: (event) => onUpdateEffect(effect.id, { enabled: event.target.checked }),
										}),
									),
									h('span', { className: 'ots-effect-name' }, t(effectLabelKey(effect.type))),
									h(
										'button',
										{
											type: 'button',
											className: 'ots-mini',
											disabled: index === 0,
											title: t('inspector.effectsUp'),
											'aria-label': t('inspector.effectsUp'),
											onClick: () => move(index, -1),
										},
										'↑',
									),
									h(
										'button',
										{
											type: 'button',
											className: 'ots-mini',
											disabled: index === effects.length - 1,
											title: t('inspector.effectsDown'),
											'aria-label': t('inspector.effectsDown'),
											onClick: () => move(index, 1),
										},
										'↓',
									),
									h(
										'button',
										{
											type: 'button',
											className: 'ots-mini',
											'data-danger': 'true',
											title: t('inspector.effectsRemove'),
											'aria-label': t('inspector.effectsRemove'),
											onClick: () => onRemoveEffect(effect.id),
										},
										'×',
									),
								),
								h(
									'div',
									{ className: 'ots-effect-params' },
									effectParamDefs(effect.type).map((definition) =>
										definition.kind === 'color'
											? h(
													'label',
													{ className: 'ots-field', key: definition.key },
													h('span', { className: 'ots-field-label' }, t(definition.label)),
													h('input', {
														className: 'ots-input',
														type: 'color',
														value: typeof params[definition.key] === 'string' ? params[definition.key] : '#00ff00',
														onChange: (event) =>
															onUpdateEffect(effect.id, {
																params: Object.assign({}, params, { [definition.key]: event.target.value }),
															}),
													}),
												)
											: definition.kind === 'text'
												? h(
														'label',
														{ className: 'ots-field', key: definition.key },
														h('span', { className: 'ots-field-label' }, t(definition.label)),
														h('input', {
															className: 'ots-input',
															type: 'text',
															defaultValue: typeof params[definition.key] === 'string' ? params[definition.key] : '',
															spellCheck: false,
															onBlur: (event) => {
																const nextValue = event.target.value.trim();
																if (nextValue.length === 0) return;
																onUpdateEffect(effect.id, {
																	params: Object.assign({}, params, { [definition.key]: nextValue }),
																});
															},
														}),
													)
												: h(
														'label',
														{ className: 'ots-field', key: definition.key },
														h('span', { className: 'ots-field-label' }, t(definition.label)),
														h('input', {
															className: 'ots-input',
															type: 'number',
															min: definition.min,
															max: definition.max,
															step: definition.step,
															defaultValue: finiteNumber(params[definition.key], 0),
															onBlur: (event) =>
																onUpdateEffect(effect.id, {
																	params: Object.assign({}, params, {
																		[definition.key]: clamp(
																			finiteNumber(event.target.value, finiteNumber(params[definition.key], 0)),
																			definition.min,
																			definition.max,
																		),
																	}),
																}),
														}),
													),
									),
								),
								skipKey ? h('p', { className: 'ots-effect-note' }, t(skipKey)) : null,
							);
						}),
			);
		}

		function TransitionsEditor(props) {
			const { t, project, track, clip, onAddTransition, onUpdateTransition, onRemoveTransition } = props;
			if (!track || !clip) return null;
			const clips = track.clips.slice().sort((a, b) => a.startFrame - b.startFrame);
			const index = clips.findIndex((candidate) => candidate.id === clip.id);
			if (index < 0) return null;
			const previous = index > 0 ? clips[index - 1] : null;
			const next = index < clips.length - 1 ? clips[index + 1] : null;
			const eligible = (other) =>
				other &&
				clip.type !== 'text' &&
				clip.type !== 'caption' &&
				other.type !== 'text' &&
				other.type !== 'caption';
			const transitions = projectTransitions(project);
			const boundaryTransition = (fromClip, toClip) =>
				transitions.find(
					(candidate) =>
						candidate &&
						candidate.trackId === track.id &&
						candidate.fromClipId === fromClip.id &&
						candidate.toClipId === toClip.id,
				) || null;
			const renderBoundary = (label, fromClip, toClip) => {
				if (!eligible(fromClip) || !eligible(toClip)) return null;
				const adjacent = fromClip.startFrame + fromClip.durationFrames === toClip.startFrame;
				if (!adjacent) return null;
				const existing = boundaryTransition(fromClip, toClip);
				const defaultDuration = Math.max(
					1,
					Math.min(30, Math.floor(Math.min(fromClip.durationFrames, toClip.durationFrames) / 2)),
				);
				return h(
					'div',
					{ className: 'ots-transition-row' },
					h(
						'div',
						{ className: 'ots-transition-head' },
						h('span', { className: 'ots-transition-name' }, label),
						existing
							? h(
									'button',
									{
										type: 'button',
										className: 'ots-mini',
										'data-danger': 'true',
										title: t('inspector.transitionsRemove'),
										'aria-label': t('inspector.transitionsRemove'),
										onClick: () => onRemoveTransition(existing.id),
									},
									'×',
								)
							: h(
									Btn,
									{
										variant: 'outline',
										onClick: () =>
											onAddTransition({
												id: newId(),
												trackId: track.id,
												fromClipId: fromClip.id,
												toClipId: toClip.id,
												type: 'dissolve',
												durationFrames: defaultDuration,
											}),
									},
									t('inspector.transitionsAdd'),
								),
					),
					existing
						? h(
								'div',
								{ className: 'ots-field-grid' },
								h(
									'label',
									{ className: 'ots-field' },
									h('span', { className: 'ots-field-label' }, t('inspector.transitionsDuration')),
									h('input', {
										className: 'ots-input',
										type: 'number',
										min: 1,
										max: Math.min(fromClip.durationFrames, toClip.durationFrames),
										step: 1,
										defaultValue: existing.durationFrames,
										onBlur: (event) =>
											onUpdateTransition(existing.id, {
												durationFrames: clamp(
													Math.round(finiteNumber(event.target.value, existing.durationFrames)),
													1,
													Math.min(fromClip.durationFrames, toClip.durationFrames),
												),
											}),
									}),
								),
								h(
									'label',
									{ className: 'ots-field' },
									h('span', { className: 'ots-field-label' }, t('inspector.transitionsType')),
									h(
										'select',
										{
											className: 'ots-select',
											value: TRANSITION_TYPES.includes(existing.type) ? existing.type : 'dissolve',
											onChange: (event) => onUpdateTransition(existing.id, { type: event.target.value }),
										},
										TRANSITION_TYPES.map((type) =>
											h('option', { key: type, value: type }, t(`transition.${type}`)),
										),
									),
								),
							)
						: null,
				);
			};
			const before = previous ? renderBoundary(t('inspector.transitionsBefore'), previous, clip) : null;
			const after = next ? renderBoundary(t('inspector.transitionsAfter'), clip, next) : null;
			if (!before && !after) {
				return h(
					'div',
					{ className: 'ots-section', key: 'transitions' },
					h('h3', { className: 'ots-section-title' }, t('inspector.transitions')),
					h('p', { className: 'ots-hint' }, t('inspector.transitionsEmpty')),
				);
			}
			return h(
				'div',
				{ className: 'ots-section', key: 'transitions' },
				h('h3', { className: 'ots-section-title' }, t('inspector.transitions')),
				before,
				after,
				h('p', { className: 'ots-hint' }, t('inspector.transitionsHint')),
			);
		}

		function CaptionEditor(props) {
			const { t, clip, onUpdateCaption, onAddCaption, onImportCaption, onExportCaption } = props;
			const caption = captionOf(clip);
			const segments = captionSegmentsOf(clip);
			const style = captionStyleOf(clip);
			const signature = JSON.stringify(segments);
			const [rows, setRows] = React.useState(() => segments);
			const fileRef = React.useRef(null);
			React.useEffect(() => {
				setRows(captionSegmentsOf(clip));
			}, [clip.id, signature]);
			const normalizeRows = (nextRows) => {
				const duration = Math.max(1, Math.round(clip.durationFrames));
				return nextRows
					.map((row) => {
						const startFrame = clamp(Math.round(finiteNumber(row.startFrame, 0)), 0, duration - 1);
						const durationFrames = clamp(
							Math.round(finiteNumber(row.durationFrames, 1)),
							1,
							Math.max(1, duration - startFrame),
						);
						return { startFrame, durationFrames, text: String(row.text === undefined ? '' : row.text) };
					})
					.sort((a, b) => a.startFrame - b.startFrame)
					.map((row) => ({ startFrame: row.startFrame, durationFrames: row.durationFrames, text: row.text }));
			};
			const commitSegments = (nextRows) => onUpdateCaption({ segments: normalizeRows(nextRows) });
			const updateSegment = (index, patch, commitNow) => {
				setRows((previous) => {
					const next = previous.map((row, rowIndex) => (rowIndex === index ? Object.assign({}, row, patch) : row));
					if (commitNow) commitSegments(next);
					return next;
				});
			};
			const addSegment = () => {
				const last = rows.length > 0 ? rows[rows.length - 1] : null;
				const clipDuration = Math.max(1, Math.round(clip.durationFrames));
				const start = last ? finiteNumber(last.startFrame, 0) + Math.max(1, finiteNumber(last.durationFrames, 30)) : 0;
				const clampedStart = clamp(Math.round(start), 0, Math.max(0, clipDuration - 1));
				const durationFrames = Math.max(1, Math.min(30, clipDuration - clampedStart));
				const next = rows.concat([{ startFrame: clampedStart, durationFrames, text: '' }]);
				setRows(next);
				commitSegments(next);
			};
			const handleFile = (event) => {
				const file = event.target.files && event.target.files[0];
				event.target.value = '';
				if (!file || typeof FileReader === 'undefined') return;
				const reader = new FileReader();
				reader.onload = () => {
					const format = /\.vtt$/i.test(file.name) ? 'vtt' : 'srt';
					onImportCaption(String(reader.result || ''), format);
				};
				reader.readAsText(file);
			};
			const updateStyle = (patch, commitNow) => {
				if (commitNow) onUpdateCaption({ style: Object.assign({}, style, patch) });
			};
			return h(
				'div',
				{ className: 'ots-section', key: 'captions' },
				h(
					'div',
					{ className: 'ots-subhead' },
					h('h3', { className: 'ots-section-title' }, t('inspector.captions')),
					h(
						'div',
						{ className: 'ots-inline-group' },
						h(
							Btn,
							{ variant: 'outline', onClick: onAddCaption },
							t('inspector.captionsAdd'),
						),
						h(
							Btn,
							{ variant: 'ghost', onClick: () => fileRef.current && fileRef.current.click() },
							t('inspector.captionsImport'),
						),
						h(
							Btn,
							{ variant: 'ghost', onClick: () => onExportCaption('srt') },
							t('inspector.captionsExportSrt'),
						),
						h(
							Btn,
							{ variant: 'ghost', onClick: () => onExportCaption('vtt') },
							t('inspector.captionsExportVtt'),
						),
						h('input', {
							ref: fileRef,
							type: 'file',
							accept: '.srt,.vtt,text/plain',
							style: { display: 'none' },
							onChange: handleFile,
						}),
					),
				),
				h('h3', { className: 'ots-section-title' }, t('inspector.captionsSegments')),
				rows.length === 0 ? h('p', { className: 'ots-hint' }, t('inspector.captionsEmpty')) : null,
				rows.map((segment, index) =>
					h(
						'div',
						{ className: 'ots-caption-segment', key: index },
						h(
							'div',
							{ className: 'ots-field-grid' },
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('inspector.captionsSegmentStart')),
								h('input', {
									className: 'ots-input',
									type: 'number',
									min: 0,
									step: 1,
									value: segment.startFrame,
									onChange: (event) => updateSegment(index, { startFrame: event.target.value }, false),
									onBlur: () => commitSegments(rows),
								}),
							),
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('inspector.captionsSegmentDuration')),
								h('input', {
									className: 'ots-input',
									type: 'number',
									min: 1,
									step: 1,
									value: segment.durationFrames,
									onChange: (event) => updateSegment(index, { durationFrames: event.target.value }, false),
									onBlur: () => commitSegments(rows),
								}),
							),
						),
						h('textarea', {
							className: 'ots-textarea',
							value: segment.text || '',
							placeholder: t('inspector.captionsSegmentText'),
							'aria-label': t('inspector.captionsSegmentText'),
							onChange: (event) => updateSegment(index, { text: event.target.value }, false),
							onBlur: () => commitSegments(rows),
						}),
						h(
							'div',
							{ className: 'ots-inline-group' },
							h(
								'button',
								{
									type: 'button',
									className: 'ots-mini',
									'data-danger': 'true',
									onClick: () => {
										const next = rows.filter((unused, rowIndex) => rowIndex !== index);
										setRows(next);
										commitSegments(next);
									},
									title: t('inspector.captionsRemoveSegment'),
									'aria-label': t('inspector.captionsRemoveSegment'),
								},
								'×',
							),
						),
					),
				),
				h(
					Btn,
					{ variant: 'outline', onClick: addSegment },
					t('inspector.captionsAddSegment'),
				),
				h('h3', { className: 'ots-section-title' }, t('inspector.captionsStyle')),
				h(
					'div',
					{ className: 'ots-field-grid' },
					h(
						'label',
						{ className: 'ots-field' },
						h('span', { className: 'ots-field-label' }, t('inspector.captionsFontSize')),
						h('input', {
							className: 'ots-input',
							type: 'number',
							min: 1,
							step: 1,
							defaultValue: style.fontSize,
							onBlur: (event) => updateStyle({ fontSize: Math.max(1, finiteNumber(event.target.value, style.fontSize)) }, true),
						}),
					),
					h(
						'label',
						{ className: 'ots-field' },
						h('span', { className: 'ots-field-label' }, t('inspector.captionsColor')),
						h('input', {
							className: 'ots-input',
							type: 'color',
							value: style.color,
							onChange: (event) => updateStyle({ color: event.target.value }, true),
						}),
					),
					h(
						'label',
						{ className: 'ots-field' },
						h('span', { className: 'ots-field-label' }, t('inspector.captionsWeight')),
						h(
							'select',
							{
								className: 'ots-select',
								value: style.fontWeight,
								onChange: (event) => updateStyle({ fontWeight: event.target.value }, true),
							},
							['400', '600', '700'].map((weight) =>
								h('option', { key: weight, value: weight }, t(`inspector.weight${weight === '400' ? 'Regular' : weight === '700' ? 'Bold' : 'Semibold'}`)),
							),
						),
					),
					h(
						'label',
						{ className: 'ots-field' },
						h('span', { className: 'ots-field-label' }, t('inspector.captionsAlign')),
						h(
							'select',
							{
								className: 'ots-select',
								value: style.align,
								onChange: (event) => updateStyle({ align: event.target.value }, true),
							},
							['left', 'center', 'right'].map((align) =>
								h('option', { key: align, value: align }, t(`inspector.align${align.charAt(0).toUpperCase()}${align.slice(1)}`)),
							),
						),
					),
				),
				h(
					'label',
					{ className: 'ots-field' },
					h('span', { className: 'ots-field-label' }, t('inspector.captionsBackground')),
					h('input', {
						className: 'ots-input',
						type: 'text',
						defaultValue: typeof style.background === 'string' ? style.background : '',
						spellCheck: false,
						onBlur: (event) =>
							updateStyle({ background: event.target.value.trim().length > 0 ? event.target.value.trim() : 'transparent' }, true),
					}),
				),
				h('p', { className: 'ots-hint' }, t('inspector.captionsHint')),
			);
		}

		function MarkersEditor(props) {
			const { t, project, currentFrame, onAddMarker, onUpdateMarker, onRemoveMarker, onSeek } = props;
			const markers = projectMarkers(project).slice().sort((a, b) => a.frame - b.frame);
			return h(
				'div',
				{ className: 'ots-section', key: 'markers' },
				h(
					'div',
					{ className: 'ots-subhead' },
					h('h3', { className: 'ots-section-title' }, t('inspector.markers')),
					h(
						Btn,
						{ variant: 'outline', onClick: onAddMarker },
						t('inspector.markersAdd'),
					),
				),
				markers.length === 0 ? h('p', { className: 'ots-hint' }, t('inspector.markersEmpty')) : null,
				markers.map((marker) =>
					h(
						'div',
						{ className: 'ots-marker-row', key: marker.id },
						h('input', {
							className: 'ots-input',
							type: 'number',
							min: 0,
							step: 1,
							defaultValue: marker.frame,
							title: t('inspector.markersFrame'),
							'aria-label': t('inspector.markersFrame'),
							onBlur: (event) =>
								onUpdateMarker(marker.id, {
									frame: Math.max(0, Math.round(finiteNumber(event.target.value, marker.frame))),
								}),
						}),
						h('input', {
							className: 'ots-input',
							type: 'text',
							defaultValue: marker.label || '',
							placeholder: t('inspector.markersLabel'),
							title: t('inspector.markersLabel'),
							'aria-label': t('inspector.markersLabel'),
							onBlur: (event) => onUpdateMarker(marker.id, { label: event.target.value }),
						}),
						h('input', {
							className: 'ots-input',
							type: 'color',
							defaultValue: marker.color || '#f5b301',
							title: t('inspector.markersColor'),
							'aria-label': t('inspector.markersColor'),
							onChange: (event) => onUpdateMarker(marker.id, { color: event.target.value }),
						}),
						h(
							'button',
							{
								type: 'button',
								className: 'ots-mini',
								title: t('inspector.markersJump'),
								'aria-label': t('inspector.markersJump'),
								onClick: () => onSeek(marker.frame),
							},
							'↦',
						),
						h(
							'button',
							{
								type: 'button',
								className: 'ots-mini',
								'data-danger': 'true',
								title: t('inspector.markersRemove'),
								'aria-label': t('inspector.markersRemove'),
								onClick: () => onRemoveMarker(marker.id),
							},
							'×',
						),
					),
				),
			);
		}

		function SpeedField(props) {
			const { t, clip, onChange } = props;
			const [value, setValue] = React.useState(() => clipSpeedOf(clip));
			const signature = String(clipSpeedOf(clip));
			React.useEffect(() => {
				setValue(clipSpeedOf(clip));
			}, [clip.id, signature]);
			const commit = () => onChange(clamp(finiteNumber(value, 1), 0.25, 4));
			return h(
				'div',
				{ className: 'ots-field' },
				h(
					'div',
					{ className: 'ots-field-row' },
					h('span', { className: 'ots-field-label' }, t('inspector.speed')),
					h('span', { className: 'ots-value' }, t('inspector.speedValue', { value: finiteNumber(value, 1).toFixed(2) })),
				),
				h('input', {
					className: 'ots-range',
					type: 'range',
					min: 0.25,
					max: 4,
					step: 0.05,
					value,
					'aria-label': t('inspector.speed'),
					onChange: (event) => setValue(Number(event.target.value)),
					onPointerUp: commit,
					onKeyUp: commit,
					onBlur: commit,
				}),
				h('p', { className: 'ots-field-hint' }, t('inspector.speedHint')),
			);
		}

		function CropEditor(props) {
			const { t, clip, onSetCrop } = props;
			const signature = JSON.stringify(clip.crop || null);
			const [draft, setDraft] = React.useState(() => cropDraftFromClip(clip));
			const syncKey = `${clip.id}:${signature}`;
			React.useEffect(() => {
				setDraft(cropDraftFromClip(clip));
			}, [syncKey]);
			const update = (patch) => setDraft((previous) => Object.assign({}, previous, patch));
			const commit = () => onSetCrop(normalizeCropDraft(draft));
			const reset = () => {
				setDraft({ x: 0, y: 0, width: 1, height: 1 });
				onSetCrop(null);
			};
			const activeCrop = clipCropOf(clip);
			return h(
				'div',
				{ className: 'ots-section', key: 'crop' },
				h(
					'div',
					{ className: 'ots-subhead' },
					h('h3', { className: 'ots-section-title' }, t('inspector.crop')),
					h(
						Btn,
						{ variant: 'ghost', onClick: reset, disabled: !activeCrop },
						t('inspector.cropReset'),
					),
				),
				h(
					'div',
					{ className: 'ots-field-grid' },
					h(NumberField, {
						label: t('inspector.cropX'),
						value: draft.x,
						min: 0,
						max: 1,
						onChange: (value) => update({ x: value }),
						onBlur: commit,
					}),
					h(NumberField, {
						label: t('inspector.cropY'),
						value: draft.y,
						min: 0,
						max: 1,
						onChange: (value) => update({ y: value }),
						onBlur: commit,
					}),
					h(NumberField, {
						label: t('inspector.cropWidth'),
						value: draft.width,
						min: 0.01,
						max: 1,
						onChange: (value) => update({ width: value }),
						onBlur: commit,
					}),
					h(NumberField, {
						label: t('inspector.cropHeight'),
						value: draft.height,
						min: 0.01,
						max: 1,
						onChange: (value) => update({ height: value }),
						onBlur: commit,
					}),
				),
				h('p', { className: 'ots-field-hint' }, t('inspector.cropHint')),
			);
		}

		function MaskEditor(props) {
			const { t, clip, onSetMask } = props;
			const signature = JSON.stringify(clip.mask || null);
			const [draft, setDraft] = React.useState(() => maskDraftFromClip(clip));
			const syncKey = `${clip.id}:${signature}`;
			React.useEffect(() => {
				setDraft(maskDraftFromClip(clip));
			}, [syncKey]);
			const update = (patch) => setDraft((previous) => Object.assign({}, previous, patch));
			const commit = () => onSetMask(normalizeMaskDraft(draft));
			const updateAndCommit = (patch) => {
				const next = Object.assign({}, draft, patch);
				setDraft(next);
				onSetMask(normalizeMaskDraft(next));
			};
			const reset = () => {
				setDraft(maskDraftFromClip({ mask: null }));
				onSetMask(null);
			};
			const activeMask = clipMaskOf(clip);
			return h(
				'div',
				{ className: 'ots-section', key: 'mask' },
				h(
					'div',
					{ className: 'ots-subhead' },
					h('h3', { className: 'ots-section-title' }, t('inspector.mask')),
					h(Btn, { variant: 'ghost', onClick: reset, disabled: !activeMask }, t('inspector.maskReset')),
				),
				h(
					'div',
					{ className: 'ots-field-grid' },
					h(SelectField, {
						label: t('inspector.maskShape'),
						value: draft.shape,
						onChange: (value) => updateAndCommit({ shape: value }),
						options: [
							{ value: 'rect', label: t('mask.rect') },
							{ value: 'ellipse', label: t('mask.ellipse') },
						],
					}),
					h(NumberField, {
						label: t('inspector.maskX'),
						value: draft.x,
						min: 0,
						max: 1,
						onChange: (value) => update({ x: value }),
						onBlur: commit,
					}),
					h(NumberField, {
						label: t('inspector.maskY'),
						value: draft.y,
						min: 0,
						max: 1,
						onChange: (value) => update({ y: value }),
						onBlur: commit,
					}),
					h(NumberField, {
						label: t('inspector.maskWidth'),
						value: draft.width,
						min: 0.01,
						max: 1,
						onChange: (value) => update({ width: value }),
						onBlur: commit,
					}),
					h(NumberField, {
						label: t('inspector.maskHeight'),
						value: draft.height,
						min: 0.01,
						max: 1,
						onChange: (value) => update({ height: value }),
						onBlur: commit,
					}),
				),
				h(RangeField, {
					label: t('inspector.maskFeather'),
					value: draft.feather,
					onChange: (value) => update({ feather: value }),
					onCommit: commit,
				}),
				h(
					'label',
					{ className: 'ots-check' },
					h('input', {
						type: 'checkbox',
						checked: draft.invert === true,
						'aria-label': t('inspector.maskInvert'),
						onChange: (event) => updateAndCommit({ invert: event.target.checked }),
					}),
					t('inspector.maskInvert'),
				),
				h('p', { className: 'ots-field-hint' }, t('inspector.maskHint')),
			);
		}

		function BlendEditor(props) {
			const { t, clip, onSetBlendMode } = props;
			const mode = clipBlendMode(clip);
			const fullFrame = isFullFrameBlendClip(clip);
			return h(
				'div',
				{ className: 'ots-section', key: 'blend' },
				h('h3', { className: 'ots-section-title' }, t('inspector.blend')),
				h(
					'label',
					{ className: 'ots-field' },
					h('span', { className: 'ots-field-label' }, t('inspector.blendMode')),
					h(
						'select',
						{
							className: 'ots-select',
							value: mode,
							'aria-label': t('inspector.blendMode'),
							onChange: (event) => onSetBlendMode(event.target.value),
						},
						BLEND_MODES.map((value) =>
							h('option', { key: value, value }, t(`blend.${value}`)),
						),
					),
				),
				h(
					'p',
					{ className: 'ots-field-hint' },
					mode !== 'normal' && !fullFrame ? t('inspector.blendFallback') : t('inspector.blendHint'),
				),
			);
		}

		function MotionEditor(props) {
			const { t, clip, onUpdateMotion, onSetDuration } = props;
			const signature = JSON.stringify(clip.motion || null);
			const [draft, setDraft] = React.useState(() => motionOf(clip));
			const [durationDraft, setDurationDraft] = React.useState(() => Math.max(1, Math.round(finiteNumber(clip.durationFrames, 1))));
			const syncKey = `${clip.id}:${signature}`;
			React.useEffect(() => {
				setDraft(motionOf(clip));
			}, [syncKey]);
			React.useEffect(() => {
				setDurationDraft(Math.max(1, Math.round(finiteNumber(clip.durationFrames, 1))));
			}, [clip.id, clip.durationFrames]);
			const commit = () => onUpdateMotion(draft);
			const update = (patch, commitNow) => {
				const next = Object.assign({}, draft, patch);
				setDraft(next);
				if (commitNow) onUpdateMotion(next);
			};
			return h(
				'div',
				{ className: 'ots-section', key: 'motion' },
				h('h3', { className: 'ots-section-title' }, t('inspector.motion')),
				h(
					'div',
					{ className: 'ots-field-grid' },
					h(SelectField, {
						label: t('motion.template'),
						value: draft.template,
						onChange: (value) => update({ template: value }, true),
						options: MOTION_TEMPLATES.map((value) => ({
							value,
							label: t(`motion.template${value.charAt(0).toUpperCase()}${value.slice(1)}`),
						})),
					}),
					h(SelectField, {
						label: t('motion.align'),
						value: draft.align,
						onChange: (value) => update({ align: value }, true),
						options: ['left', 'center', 'right'].map((value) => ({
							value,
							label: t(`motion.align${value.charAt(0).toUpperCase()}${value.slice(1)}`),
						})),
					}),
				),
				h(
					'label',
					{ className: 'ots-field' },
					h('span', { className: 'ots-field-label' }, t('motion.text')),
					h('textarea', {
						className: 'ots-textarea',
						value: draft.text,
						'aria-label': t('motion.text'),
						onChange: (event) => update({ text: event.target.value }),
						onBlur: commit,
					}),
				),
				h(
					'label',
					{ className: 'ots-field' },
					h('span', { className: 'ots-field-label' }, t('motion.subtitle')),
					h('input', {
						className: 'ots-input',
						type: 'text',
						value: draft.subtitle,
						'aria-label': t('motion.subtitle'),
						onChange: (event) => update({ subtitle: event.target.value }),
						onBlur: commit,
					}),
				),
				h(
					'div',
					{ className: 'ots-field-grid' },
					h(
						'label',
						{ className: 'ots-field' },
						h('span', { className: 'ots-field-label' }, t('motion.color')),
						h('input', {
							className: 'ots-color-input',
							type: 'color',
							value: draft.color,
							'aria-label': t('motion.color'),
							onChange: (event) => update({ color: event.target.value }, true),
						}),
					),
					h(
						'label',
						{ className: 'ots-field' },
						h('span', { className: 'ots-field-label' }, t('motion.accentColor')),
						h('input', {
							className: 'ots-color-input',
							type: 'color',
							value: draft.accentColor,
							'aria-label': t('motion.accentColor'),
							onChange: (event) => update({ accentColor: event.target.value }, true),
						}),
					),
					h(NumberField, {
						label: t('motion.fontSize'),
						value: draft.fontSize,
						min: 18,
						max: 200,
						step: 1,
						onChange: (value) => update({ fontSize: value }),
						onBlur: commit,
					}),
					h(
						'label',
						{ className: 'ots-field' },
						h('span', { className: 'ots-field-label' }, t('motion.duration')),
						h('input', {
							className: 'ots-input',
							type: 'number',
							min: 1,
							step: 1,
							value: durationDraft,
							'aria-label': t('motion.duration'),
							onChange: (event) => setDurationDraft(event.target.value),
							onBlur: () => onSetDuration(Math.max(1, Math.round(finiteNumber(durationDraft, clip.durationFrames)))),
						}),
					),
				),
				h(
					'label',
					{ className: 'ots-check' },
					h('input', {
						type: 'checkbox',
						checked: draft.background === true,
						'aria-label': t('motion.background'),
						onChange: (event) => update({ background: event.target.checked }, true),
					}),
					t('motion.background'),
				),
				h('p', { className: 'ots-field-hint' }, t('motion.hint')),
			);
		}

		function Inspector(props) {
			const {
				t,
				project,
				projectRoot,
				snapshot,
				selected,
				draft,
				currentFrame,
				selectedCount,
				onPropertyChange,
				onPropertyCommit,
				onTextChange,
				onTextCommit,
				onSetCrop,
				onSetMask,
				onSetBlendMode,
				onUpdateMotion,
				onSetMotionDuration,
				onAddText,
				onSpeedChange,
				onFadeChange,
				onSetKeyframes,
				onAddEffect,
				onUpdateEffect,
				onRemoveEffect,
				onReorderEffects,
				onAddTransition,
				onUpdateTransition,
				onRemoveTransition,
				onAddCaption,
				onUpdateCaption,
				onImportCaption,
				onExportCaption,
				onAddMarker,
				onUpdateMarker,
				onRemoveMarker,
				missingMediaIds,
			} = props;
			const title = selected ? t(`inspector.kind${selected.clip.type.charAt(0).toUpperCase()}${selected.clip.type.slice(1)}`) : t('inspector.project');
			const selectedMedia =
				selected && selected.clip.mediaId && project ? findMedia(project, selected.clip.mediaId) : null;
			const selectedMissing = Boolean(
				selectedMedia &&
					(mediaMissingOf(selectedMedia) || (missingMediaIds && missingMediaIds.has(selectedMedia.id))),
			);
			const body = [];
			if (!selected) {
				const projectInfo = project
					? [
							{ key: t('project.folder'), value: projectRoot || '' },
							{ key: t('project.fps'), value: String(project.fps) },
							{ key: t('project.resolution'), value: `${project.width} × ${project.height}` },
							{ key: t('project.duration'), value: formatTimecode(timelineDurationFrames(project), project.fps) },
							{ key: t('project.tracks'), value: String(project.tracks.length) },
							{ key: t('project.media'), value: String(project.media.length) },
						]
					: [];
				body.push(
					h(
						'div',
						{ className: 'ots-section', key: 'project' },
						h('h3', { className: 'ots-section-title' }, t('inspector.project')),
						h(
							'div',
							{ className: 'ots-kv' },
							projectInfo.map((row) =>
								h(
									'div',
									{ className: 'ots-kv-row', key: row.key },
									h('span', { className: 'ots-kv-key' }, row.key),
									h('span', { className: 'ots-kv-value', title: row.value }, row.value),
								),
							),
						),
						h('p', { className: 'ots-hint' }, t('inspector.nothingHint')),
						h(
							Btn,
							{ variant: 'outline', onClick: onAddText, disabled: !project },
							t('inspector.addText'),
						),
					),
				);
				body.push(
					h(
						'div',
						{ className: 'ots-section', key: 'captions-project' },
						h(
							'div',
							{ className: 'ots-subhead' },
							h('h3', { className: 'ots-section-title' }, t('inspector.captions')),
							h(
								Btn,
								{ variant: 'outline', onClick: onAddCaption, disabled: !project },
								t('inspector.captionsAdd'),
							),
						),
						h('p', { className: 'ots-hint' }, t('inspector.captionsHint')),
					),
				);
				body.push(
					h(
						'div',
						{ className: 'ots-section', key: 'shortcuts' },
						h('h3', { className: 'ots-section-title' }, t('inspector.shortcuts')),
						h(Shortcut, { t, shortcutKey: 'Space', label: t('inspector.shortcutPlay') }),
						h(Shortcut, { t, shortcutKey: '← / →', label: t('inspector.shortcutStep') }),
						h(Shortcut, { t, shortcutKey: 'Del', label: t('inspector.shortcutDelete') }),
						h(Shortcut, { t, shortcutKey: '⌘Z', label: t('inspector.shortcutUndo') }),
						h(Shortcut, { t, shortcutKey: '⇧⌘Z', label: t('inspector.shortcutRedo') }),
						h(Shortcut, { t, shortcutKey: '⌘K', label: t('inspector.shortcutSplit') }),
					),
				);
			} else {
				const clip = selected.clip;
				const track = selected.track;
				const media = findMedia(project, clip.mediaId);
				const fps = project.fps;
				const isText = clip.type === 'text';
				const isAudio = clip.type === 'audio';
				const isMotion = clip.type === 'motion';
				const isVisual = !isAudio;
				const mediaHasAudio = media ? Boolean(media.hasAudio) : false;
				const timing = [
					{ key: t('inspector.start'), value: `${clip.startFrame}` },
					{ key: t('inspector.duration'), value: `${clip.durationFrames}` },
					{ key: t('inspector.trim'), value: `${clip.trimStartFrame}` },
					{ key: t('inspector.end'), value: `${clip.startFrame + clip.durationFrames}` },
				];
				body.push(
					h(
						'div',
						{ className: 'ots-section', key: 'identity' },
						h('h3', { className: 'ots-section-title' }, title),
						media ? h('span', { className: 'ots-value', title: media.name }, media.name) : null,
						h(
							'div',
							{ className: 'ots-kv' },
							timing.map((row) =>
								h(
									'div',
									{ className: 'ots-kv-row', key: row.key },
									h('span', { className: 'ots-kv-key' }, row.key),
									h('span', { className: 'ots-kv-value' }, `${row.value} · ${formatTimecode(Number(row.value), fps)}`),
								),
							),
						),
						selectedCount > 1 ? h('p', { className: 'ots-note' }, t('inspector.multiHint', { count: selectedCount })) : null,
						h('p', { className: 'ots-hint' }, t('inspector.readonly')),
					),
				);
				if (clip.type === 'video' || clip.type === 'audio') {
					body.push(
						h(
							'div',
							{ className: 'ots-section', key: 'speed' },
							h('h3', { className: 'ots-section-title' }, t('inspector.speed')),
							h(SpeedField, { t, clip, onChange: onSpeedChange }),
						),
					);
				}
				if (clip.type !== 'caption') {
					body.push(
						h(
							'div',
							{ className: 'ots-section', key: 'fades' },
							h('h3', { className: 'ots-section-title' }, t('inspector.fades')),
							h(
								'div',
								{ className: 'ots-field-grid' },
								h('label', { className: 'ots-field' },
									h('span', { className: 'ots-field-label' }, t('inspector.fadeIn')),
									h('input', {
										key: `${clip.id}-fadein`,
										className: 'ots-input',
										type: 'number',
										min: 0,
										max: clip.durationFrames,
										step: 1,
										defaultValue: clipFadeInFrames(clip),
										onBlur: (event) =>
											onFadeChange({ fadeInFrames: clamp(Math.round(finiteNumber(event.target.value, 0)), 0, clip.durationFrames) }),
									}),
								),
								h('label', { className: 'ots-field' },
									h('span', { className: 'ots-field-label' }, t('inspector.fadeOut')),
									h('input', {
										key: `${clip.id}-fadeout`,
										className: 'ots-input',
										type: 'number',
										min: 0,
										max: clip.durationFrames,
										step: 1,
										defaultValue: clipFadeOutFrames(clip),
										onBlur: (event) =>
											onFadeChange({ fadeOutFrames: clamp(Math.round(finiteNumber(event.target.value, 0)), 0, clip.durationFrames) }),
									}),
								),
							),
							h('p', { className: 'ots-field-hint' }, t('inspector.fadesHint')),
						),
					);
				}
				body.push(h(KeyframeEditor, { t, clip, currentFrame, onSetKeyframes }));
				body.push(
					h(EffectsEditor, {
						t,
						clip,
						onAddEffect,
						onUpdateEffect,
						onRemoveEffect,
						onReorderEffects,
					}),
				);
				if (track && track.type === 'video' && clip.type !== 'caption') {
					body.push(
						h(TransitionsEditor, {
							t,
							project,
							track,
							clip,
							onAddTransition,
							onUpdateTransition,
							onRemoveTransition,
						}),
					);
				}
				if (clip.type === 'caption') {
					body.push(
						h(CaptionEditor, {
							t,
							clip,
							onUpdateCaption,
							onAddCaption,
							onImportCaption,
							onExportCaption,
						}),
					);
				}
				if (!isText) {
					body.push(
						h(
							'div',
							{ className: 'ots-section', key: 'levels' },
							(isAudio || mediaHasAudio)
								? h(RangeField, {
										label: t('inspector.volume'),
										value: draft ? draft.volume : clip.volume,
										onChange: (value) => onPropertyChange({ volume: value }),
										onCommit: onPropertyCommit,
									})
								: null,
							isVisual
								? h(RangeField, {
										label: t('inspector.opacity'),
										value: draft ? draft.opacity : clip.opacity,
										onChange: (value) => onPropertyChange({ opacity: value }),
										onCommit: onPropertyCommit,
									})
								: null,
						),
					);
				}
				if (isVisual) {
					const source = draft || normalizeTransform(clip.transform);
					body.push(
						h(
							'div',
							{ className: 'ots-section', key: 'transform' },
							h('h3', { className: 'ots-section-title' }, t('inspector.transform')),
							h(
								'div',
								{ className: 'ots-field-grid' },
								h(NumberField, {
									label: t('inspector.x'),
									value: source.x,
									min: 0,
									max: 1,
									onChange: (value) => onPropertyChange({ transform: { x: value } }),
									onBlur: onPropertyCommit,
								}),
								h(NumberField, {
									label: t('inspector.y'),
									value: source.y,
									min: 0,
									max: 1,
									onChange: (value) => onPropertyChange({ transform: { y: value } }),
									onBlur: onPropertyCommit,
								}),
								h(NumberField, {
									label: t('inspector.width'),
									value: source.width,
									min: 0,
									max: 1,
									onChange: (value) => onPropertyChange({ transform: { width: value } }),
									onBlur: onPropertyCommit,
								}),
								h(NumberField, {
									label: t('inspector.height'),
									value: source.height,
									min: 0,
									max: 1,
									onChange: (value) => onPropertyChange({ transform: { height: value } }),
									onBlur: onPropertyCommit,
								}),
							),
							h(NumberField, {
								label: t('inspector.rotation'),
								value: source.rotation,
								min: -360,
								max: 360,
								step: 1,
								onChange: (value) => onPropertyChange({ transform: { rotation: value } }),
								onBlur: onPropertyCommit,
							}),
							h('p', { className: 'ots-field-hint' }, t('inspector.normalized')),
						),
					);
					body.push(h(CropEditor, { t, clip, onSetCrop }));
					body.push(h(MaskEditor, { t, clip, onSetMask }));
					body.push(h(BlendEditor, { t, clip, onSetBlendMode }));
				}
				if (isMotion) {
					body.push(
						h(MotionEditor, {
							t,
							clip,
							onUpdateMotion,
							onSetDuration: onSetMotionDuration,
						}),
					);
				}
				if (isText) {
					const text = draft || draftFromClip(clip);
					body.push(
						h(
							'div',
							{ className: 'ots-section', key: 'text' },
							h('h3', { className: 'ots-section-title' }, t('inspector.text')),
							h(
								Field,
								{ label: t('inspector.content') },
								h('textarea', {
									className: 'ots-textarea',
									value: text.content,
									onChange: (event) => onTextChange({ content: event.target.value }),
									onBlur: onTextCommit,
								}),
							),
							h(
								'div',
								{ className: 'ots-field-grid' },
								h(NumberField, {
									label: t('inspector.fontSize'),
									value: text.fontSize,
									min: 1,
									step: 1,
									onChange: (value) => onTextChange({ fontSize: value }),
									onBlur: onTextCommit,
								}),
								h(
									Field,
									{ label: t('inspector.color') },
									h('input', {
										className: 'ots-input',
										type: 'color',
										value: text.color,
										onChange: (event) => {
											onTextChange({ color: event.target.value });
											onTextCommit();
										},
									}),
								),
							),
							h(
								'div',
								{ className: 'ots-field-grid' },
								h(SelectField, {
									label: t('inspector.fontWeight'),
									value: text.fontWeight,
									onChange: (value) => {
										onTextChange({ fontWeight: value });
										onTextCommit();
									},
									options: [
										{ value: '400', label: t('inspector.weightRegular') },
										{ value: '600', label: t('inspector.weightSemibold') },
										{ value: '700', label: t('inspector.weightBold') },
									],
								}),
								h(SelectField, {
									label: t('inspector.align'),
									value: text.align,
									onChange: (value) => {
										onTextChange({ align: value });
										onTextCommit();
									},
									options: [
										{ value: 'left', label: t('inspector.alignLeft') },
										{ value: 'center', label: t('inspector.alignCenter') },
										{ value: 'right', label: t('inspector.alignRight') },
									],
								}),
							),
						),
					);
				} else if (media) {
					body.push(
						h(
							'div',
							{ className: 'ots-section', key: 'media-meta' },
							h('h3', { className: 'ots-section-title' }, t('media.title')),
							h(
								'div',
								{ className: 'ots-kv' },
								h(
									'div',
									{ className: 'ots-kv-row' },
									h('span', { className: 'ots-kv-key' }, t('media.title')),
									h('span', { className: 'ots-kv-value' }, media.name),
								),
								media.width && media.height
									? h(
											'div',
											{ className: 'ots-kv-row' },
											h('span', { className: 'ots-kv-key' }, t('project.resolution')),
											h('span', { className: 'ots-kv-value' }, `${media.width} × ${media.height}`),
										)
									: null,
								h(
									'div',
									{ className: 'ots-kv-row' },
									h('span', { className: 'ots-kv-key' }, t('inspector.duration')),
									h(
										'span',
										{ className: 'ots-kv-value' },
										media.durationFrames === null ? t('media.still') : formatDurationFrames(media.durationFrames, fps),
									),
								),
							),
						),
					);
				}
			}
			body.push(
				h(MarkersEditor, {
					t,
					project,
					currentFrame,
					onAddMarker,
					onUpdateMarker,
					onRemoveMarker,
					onSeek: props.onSeek,
				}),
			);
			return h(
				'aside',
				{ className: 'ots-panel ots-inspector', 'aria-label': t('inspector.title') },
				h('div', { className: 'ots-panel-head' }, h('span', { className: 'ots-panel-title' }, t('inspector.title'))),
				selectedMissing
					? h('div', { className: 'ots-media-warning', role: 'status' }, t('media.missingInspector'))
					: null,
				h('div', { className: 'ots-panel-body' }, body),
			);
		}

		function Shortcut(props) {
			return h(
				'div',
				{ className: 'ots-shortcut' },
				h('span', { className: 'ots-shortcut-key' }, props.shortcutKey),
				h('span', {}, props.label),
			);
		}

		// -------------------------------------------------------------------
		// Timeline
		// -------------------------------------------------------------------

		function TrackRoleControl(props) {
			const { t, track, onUpdateTrack } = props;
			const role = trackRoleOf(track);
			const ducking = trackDuckingOf(track);
			const duckable = isDuckableRole(role);
			const changeRole = (nextRole) => {
				const patch = { role: nextRole };
				if (!isDuckableRole(nextRole) && track.ducking === true) patch.ducking = false;
				onUpdateTrack(track.id, patch);
			};
			return h(
				'span',
				{ className: 'ots-track-role' },
				h(
					'select',
					{
						className: 'ots-select ots-track-role-select',
						value: role,
						'aria-label': t('timeline.trackRole'),
						title: t('timeline.trackRole'),
						onChange: (event) => changeRole(event.target.value),
					},
					TRACK_ROLES.map((value) => h('option', { key: value, value }, t(`role.${value}`))),
				),
				duckable
					? h(
							'button',
							{
								type: 'button',
								className: 'ots-mini ots-track-ducking',
								'data-active': ducking ? 'true' : 'false',
								'aria-pressed': ducking ? 'true' : 'false',
								'aria-label': t('timeline.ducking'),
								title: t('timeline.duckingHint'),
								onClick: () => onUpdateTrack(track.id, { ducking: !ducking }),
							},
							'D',
						)
					: null,
			);
		}

		function TrackVolumeControl(props) {
			const { t, track, onUpdateTrack } = props;
			const [value, setValue] = React.useState(() => clamp(finiteNumber(track.volume, 1), 0, 2));
			const signature = String(clamp(finiteNumber(track.volume, 1), 0, 2));
			React.useEffect(() => {
				setValue(clamp(finiteNumber(track.volume, 1), 0, 2));
			}, [track.id, signature]);
			const commit = () => onUpdateTrack(track.id, { volume: clamp(finiteNumber(value, 1), 0, 2) });
			return h(
				'div',
				{ className: 'ots-track-volume' },
				h('input', {
					className: 'ots-track-volume-range',
					type: 'range',
					min: 0,
					max: 2,
					step: 0.01,
					value,
					'aria-label': t('timeline.trackVolume'),
					title: t('timeline.trackVolume'),
					onChange: (event) => setValue(Number(event.target.value)),
					onPointerUp: commit,
					onKeyUp: commit,
					onBlur: commit,
				}),
				h('span', { className: 'ots-track-volume-label' }, `${Math.round(finiteNumber(value, 1) * 100)}%`),
			);
		}

		function Timeline(props) {
			const {
				t,
				project,
				zoom,
				currentFrame,
				playing,
				selectedClipIds,
				onSelectClip,
				onSeek,
				onMoveClip,
				onTrimClip,
				onDropMedia,
				onSetZoom,
				onSplit,
				onDelete,
				onDeleteRipple,
				onCopy,
				onPaste,
				canSplit,
				canDelete,
				canCopy,
				canPaste,
				snapping,
				onToggleSnapping,
				onAddMarker,
				onAddTrack,
				onAddText,
				onAddMotion,
				onUpdateTrack,
				onRemoveTrack,
				missingMediaIds,
			} = props;
			const scrollRef = React.useRef(null);
			const rowRefs = React.useRef({});
			const dragRef = React.useRef(null);
			const [dragState, setDragState] = React.useState(null);
			const [editingTrackId, setEditingTrackId] = React.useState(null);
			const [trackNameDraft, setTrackNameDraft] = React.useState('');
			const [confirmTrackId, setConfirmTrackId] = React.useState(null);
			const scrollSize = useElementSize(scrollRef);
			const fps = project ? project.fps : 30;
			const duration = project ? timelineDurationFrames(project) : 0;
			const contentFrames = Math.max(duration + Math.round(fps * 2), Math.round(fps * 8));
			const laneWidth = Math.max(Math.round(contentFrames * zoom), Math.max(0, (scrollSize.width || 0) - HEAD_WIDTH));
			const stepSeconds = rulerStepSeconds(zoom, fps);
			const stepFrames = Math.max(1, Math.round(stepSeconds * fps));
			const tickCount = Math.min(500, Math.ceil(contentFrames / stepFrames) + 1);
			const tracks = project ? project.tracks : [];

			const frameFromClientX = (clientX) => {
				const element = scrollRef.current;
				if (!element) return 0;
				const rect = element.getBoundingClientRect();
				const x = clientX - rect.left + element.scrollLeft - HEAD_WIDTH;
				return Math.max(0, Math.round(x / Math.max(0.0001, zoom)));
			};

			const beginScrub = (event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				onSeek(frameFromClientX(event.clientX));
				const move = (moveEvent) => onSeek(frameFromClientX(moveEvent.clientX));
				const finish = () => {
					window.removeEventListener('pointermove', move);
					window.removeEventListener('pointerup', finish);
					window.removeEventListener('pointercancel', finish);
				};
				window.addEventListener('pointermove', move);
				window.addEventListener('pointerup', finish);
				window.addEventListener('pointercancel', finish);
			};

			const trackForClientY = (clientY, clip) => {
				const wanted = clipTrackType(clip);
				for (const track of tracks) {
					if (track.type !== wanted) continue;
					const element = rowRefs.current[track.id];
					if (!element) continue;
					const rect = element.getBoundingClientRect();
					if (clientY >= rect.top && clientY <= rect.bottom) return track;
				}
				return null;
			};

			const previousEnd = (clip, siblings) => {
				let end = 0;
				for (const other of siblings) {
					const otherEnd = other.startFrame + other.durationFrames;
					if (otherEnd <= clip.startFrame) end = Math.max(end, otherEnd);
				}
				return end;
			};

			const nextStart = (clip, siblings) => {
				let start = Infinity;
				const clipEnd = clip.startFrame + clip.durationFrames;
				for (const other of siblings) {
					if (other.startFrame >= clipEnd) start = Math.min(start, other.startFrame);
				}
				return start;
			};

			const snapThresholdFrames = () => Math.max(1, Math.round(6 / Math.max(0.0001, zoom)));
			const snapTargets = (excludeClipId) => {
				const targets = [0, Math.round(currentFrame)];
				for (const marker of projectMarkers(project)) {
					if (marker) targets.push(Math.round(finiteNumber(marker.frame, 0)));
				}
				for (const track of tracks) {
					for (const clip of track.clips) {
						if (clip.id === excludeClipId) continue;
						targets.push(clip.startFrame);
						targets.push(clip.startFrame + clip.durationFrames);
					}
				}
				return targets;
			};
			const snapEdge = (value, excludeClipId) => {
				if (!snapping) return value;
				const threshold = snapThresholdFrames();
				let best = value;
				let bestDistance = threshold + 1;
				for (const target of snapTargets(excludeClipId)) {
					const distance = Math.abs(value - target);
					if (distance <= threshold && distance < bestDistance) {
						best = target;
						bestDistance = distance;
					}
				}
				return best;
			};
			const snapMoveStart = (start, duration, excludeClipId) => {
				if (!snapping) return start;
				const threshold = snapThresholdFrames();
				let best = start;
				let bestDistance = threshold + 1;
				for (const target of snapTargets(excludeClipId)) {
					const startDistance = Math.abs(start - target);
					if (startDistance <= threshold && startDistance < bestDistance) {
						best = target;
						bestDistance = startDistance;
					}
					const endDistance = Math.abs(start + duration - target);
					if (endDistance <= threshold && endDistance < bestDistance) {
						best = target - duration;
						bestDistance = endDistance;
					}
				}
				return Math.max(0, best);
			};

			const beginClipDrag = (event, track, clip) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				onSelectClip(clip.id, event);
				const siblings = track.clips.filter((item) => item.id !== clip.id);
				dragRef.current = {
					kind: 'move',
					clip,
					track,
					startX: event.clientX,
					startY: event.clientY,
					siblings,
					zoom,
					preview: {
						startFrame: clip.startFrame,
						durationFrames: clip.durationFrames,
						trimStartFrame: clip.trimStartFrame,
						trackId: track.id,
					},
				};
				setDragState(dragRef.current);
				const move = (moveEvent) => {
					const current = dragRef.current;
					if (!current) return;
					const delta = Math.round((moveEvent.clientX - current.startX) / Math.max(0.0001, current.zoom));
					const targetTrack = trackForClientY(moveEvent.clientY, current.clip);
					current.preview = Object.assign({}, current.preview, {
						startFrame: snapMoveStart(
							Math.max(0, current.clip.startFrame + delta),
							current.clip.durationFrames,
							current.clip.id,
						),
						trackId: targetTrack ? targetTrack.id : current.track.id,
					});
					setDragState(Object.assign({}, current));
				};
				const finish = () => {
					window.removeEventListener('pointermove', move);
					window.removeEventListener('pointerup', finish);
					window.removeEventListener('pointercancel', finish);
					const current = dragRef.current;
					dragRef.current = null;
					setDragState(null);
					if (!current) return;
					const preview = current.preview;
					if (preview.trackId !== current.track.id || preview.startFrame !== current.clip.startFrame) {
						onMoveClip(current.clip, preview.startFrame, preview.trackId);
					}
				};
				window.addEventListener('pointermove', move);
				window.addEventListener('pointerup', finish);
				window.addEventListener('pointercancel', finish);
			};

			const beginTrim = (event, track, clip, edge) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				onSelectClip(clip.id, event);
				const siblings = track.clips.filter((item) => item.id !== clip.id);
				dragRef.current = {
					kind: 'trim',
					edge,
					clip,
					track,
					startX: event.clientX,
					startY: event.clientY,
					siblings,
					zoom,
					preview: {
						startFrame: clip.startFrame,
						durationFrames: clip.durationFrames,
						trimStartFrame: clip.trimStartFrame,
						trackId: track.id,
					},
				};
				setDragState(dragRef.current);
				const move = (moveEvent) => {
					const current = dragRef.current;
					if (!current) return;
					const delta = Math.round((moveEvent.clientX - current.startX) / Math.max(0.0001, current.zoom));
					const clipValue = current.clip;
					if (current.edge === 'end') {
						const limitByNext = nextStart(clipValue, current.siblings) - clipValue.startFrame;
						const media = findMedia(project, clipValue.mediaId);
						const limitByMedia =
							media && media.durationFrames !== null
								? media.durationFrames - clipValue.trimStartFrame
								: Infinity;
						const maxDuration = Math.max(1, Math.min(limitByNext, limitByMedia));
						const proposedDuration = clamp(clipValue.durationFrames + delta, 1, maxDuration);
						const snappedEnd = snapEdge(clipValue.startFrame + proposedDuration, clipValue.id);
						current.preview = Object.assign({}, current.preview, {
							durationFrames: clamp(snappedEnd - clipValue.startFrame, 1, maxDuration),
						});
					} else {
						const media = findMedia(project, clipValue.mediaId);
						const trimLimit = media && media.durationFrames !== null && clipValue.type !== 'text' ? clipValue.trimStartFrame : 0;
						const minDelta = Math.max(-trimLimit, previousEnd(clipValue, current.siblings) - clipValue.startFrame, -clipValue.startFrame);
						const maxDelta = clipValue.durationFrames - 1;
						const applied = clamp(delta, minDelta, maxDelta);
						const snappedStart = snapEdge(clipValue.startFrame + applied, clipValue.id);
						const finalDelta = clamp(snappedStart - clipValue.startFrame, minDelta, maxDelta);
						current.preview = Object.assign({}, current.preview, {
							startFrame: clipValue.startFrame + finalDelta,
							durationFrames: clipValue.durationFrames - finalDelta,
							trimStartFrame: clipValue.type === 'video' || clipValue.type === 'audio' ? clipValue.trimStartFrame + finalDelta : clipValue.trimStartFrame,
						});
					}
					setDragState(Object.assign({}, current));
				};
				const finish = () => {
					window.removeEventListener('pointermove', move);
					window.removeEventListener('pointerup', finish);
					window.removeEventListener('pointercancel', finish);
					const current = dragRef.current;
					dragRef.current = null;
					setDragState(null);
					if (!current) return;
					const preview = current.preview;
					if (
						preview.startFrame === current.clip.startFrame &&
						preview.durationFrames === current.clip.durationFrames &&
						preview.trimStartFrame === current.clip.trimStartFrame
					) {
						return;
					}
					onTrimClip(current.clip, preview);
				};
				window.addEventListener('pointermove', move);
				window.addEventListener('pointerup', finish);
				window.addEventListener('pointercancel', finish);
			};

			React.useEffect(() => {
				const element = scrollRef.current;
				if (!element) return undefined;
				const onWheel = (event) => {
					if (event.ctrlKey || event.metaKey) {
						event.preventDefault();
						const factor = event.deltaY < 0 ? 1.25 : 0.8;
						onSetZoom(clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM));
						return;
					}
					if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
						event.preventDefault();
						element.scrollLeft += event.deltaY;
					}
				};
				element.addEventListener('wheel', onWheel, { passive: false });
				return () => element.removeEventListener('wheel', onWheel);
			}, [zoom, onSetZoom]);

			React.useEffect(() => {
				const element = scrollRef.current;
				if (!element) return;
				const x = HEAD_WIDTH + currentFrame * zoom;
				const visibleStart = element.scrollLeft + HEAD_WIDTH;
				const visibleEnd = element.scrollLeft + element.clientWidth;
				if (x < visibleStart + 24) {
					element.scrollLeft = Math.max(0, x - HEAD_WIDTH - 24);
				} else if (x > visibleEnd - 32) {
					element.scrollLeft = Math.max(0, x - element.clientWidth + 64);
				}
			}, [currentFrame, zoom, playing]);

			const handleDrop = (event, track) => {
				if (!event.dataTransfer) return;
				const mediaId =
					event.dataTransfer.getData('application/x-opentake-media') || event.dataTransfer.getData('text/plain');
				if (!mediaId) return;
				event.preventDefault();
				event.stopPropagation();
				let trackId = track ? track.id : null;
				const media = project ? project.media.find((item) => item.id === mediaId) : null;
				if (track && media) {
					const wanted = media.kind === 'audio' ? 'audio' : 'video';
					if (track.type !== wanted) trackId = null;
				}
				onDropMedia(mediaId, trackId, frameFromClientX(event.clientX));
			};

			const startRenameTrack = (track) => {
				setConfirmTrackId(null);
				setEditingTrackId(track.id);
				setTrackNameDraft(track.name || '');
			};
			const cancelRenameTrack = () => {
				setEditingTrackId(null);
			};
			const commitRenameTrack = () => {
				const trackId = editingTrackId;
				if (!trackId) return;
				const track = tracks.find((candidate) => candidate.id === trackId);
				const name = trackNameDraft.trim();
				setEditingTrackId(null);
				if (track && name.length > 0 && name !== track.name) onUpdateTrack(trackId, { name });
			};
			const renderTrackHead = (track) => {
				const muted = track.muted === true;
				const hidden = track.hidden === true;
				const typeLabel = t(track.type === 'audio' ? 'timeline.audioTrack' : 'timeline.videoTrack');
				const role = trackRoleOf(track);
				const ducking = trackDuckingOf(track);
				const stateSuffix = [muted ? t('timeline.muted') : null, hidden ? t('timeline.hidden') : null]
					.filter(Boolean)
					.join(' · ');
				return h(
					'div',
					{
						className: 'ots-track-head',
						'data-muted': muted ? 'true' : 'false',
						'data-hidden': hidden ? 'true' : 'false',
					},
					h(
						'div',
						{ className: 'ots-track-head-row' },
						editingTrackId === track.id
							? h('input', {
									className: 'ots-track-name-input',
									type: 'text',
									value: trackNameDraft,
									autoFocus: true,
									'aria-label': t('timeline.renameTrack'),
									onChange: (event) => setTrackNameDraft(event.target.value),
									onBlur: commitRenameTrack,
									onKeyDown: (event) => {
										if (event.key === 'Enter') {
											event.preventDefault();
											commitRenameTrack();
										} else if (event.key === 'Escape') {
											event.preventDefault();
											cancelRenameTrack();
										}
									},
								})
							: h(
									'button',
									{
										type: 'button',
										className: 'ots-track-name-btn',
										title: t('timeline.renameTrack'),
										onDoubleClick: () => startRenameTrack(track),
										onClick: (event) => event.stopPropagation(),
									},
									track.name || typeLabel,
								),
						h(
							'span',
							{ className: 'ots-track-badges' },
							h(
								'span',
								{ className: 'ots-track-role-badge', title: t(`role.${role}`) },
								t(`role.short.${role}`),
							),
							ducking
								? h('span', { className: 'ots-track-duck-badge', title: t('timeline.ducking') }, 'D')
								: null,
						),
						h(
							'div',
							{ className: 'ots-track-actions' },
							h(
								'button',
								{
									type: 'button',
									className: 'ots-track-icon',
									'data-active': muted ? 'true' : 'false',
									title: muted ? t('timeline.unmuteTrack') : t('timeline.muteTrack'),
									'aria-label': muted ? t('timeline.unmuteTrack') : t('timeline.muteTrack'),
									'aria-pressed': muted ? 'true' : 'false',
									onClick: () => onUpdateTrack(track.id, { muted: !muted }),
								},
								'M',
							),
							h(
								'button',
								{
									type: 'button',
									className: 'ots-track-icon',
									'data-active': hidden ? 'true' : 'false',
									title: hidden ? t('timeline.showTrack') : t('timeline.hideTrack'),
									'aria-label': hidden ? t('timeline.showTrack') : t('timeline.hideTrack'),
									'aria-pressed': hidden ? 'true' : 'false',
									onClick: () => onUpdateTrack(track.id, { hidden: !hidden }),
								},
								'H',
							),
							h(
								'button',
								{
									type: 'button',
									className: 'ots-track-icon',
									title: t('timeline.renameTrack'),
									'aria-label': t('timeline.renameTrack'),
									onClick: () => startRenameTrack(track),
								},
								'✎',
							),
							h(
								'button',
								{
									type: 'button',
									className: 'ots-track-icon',
									'data-danger': 'true',
									title: t('timeline.deleteTrack'),
									'aria-label': t('timeline.deleteTrack'),
									onClick: () => setConfirmTrackId(track.id),
								},
								'×',
							),
						),
					),
					h(
						'span',
						{ className: 'ots-track-kind', title: `${typeLabel} · ${t('timeline.clipCount', { count: track.clips.length })}${stateSuffix ? ` · ${stateSuffix}` : ''}` },
						`${typeLabel} · ${t('timeline.clipCount', { count: track.clips.length })}${stateSuffix ? ` · ${stateSuffix}` : ''}`,
					),
					h(
						'div',
						{ className: 'ots-track-mix-row' },
						h(TrackRoleControl, { t, track, onUpdateTrack }),
						h(TrackVolumeControl, { t, track, onUpdateTrack }),
					),
					confirmTrackId === track.id
						? h(
								'div',
								{ className: 'ots-track-confirm' },
								h('span', { className: 'ots-track-confirm-text' }, t('timeline.confirmDeleteTrack')),
								h(
									'div',
									{ className: 'ots-track-confirm-actions' },
									h(
										'button',
										{
											type: 'button',
											className: 'ots-mini',
											'data-danger': 'true',
											onClick: () => {
												setConfirmTrackId(null);
												onRemoveTrack(track.id);
											},
										},
										t('timeline.deleteConfirm'),
									),
									h(
										'button',
										{
											type: 'button',
											className: 'ots-mini',
											onClick: () => setConfirmTrackId(null),
										},
										t('actions.cancel'),
									),
								),
							)
						: null,
				);
			};

			const renderClip = (track, clip, preview) => {
				const startFrame = preview ? preview.startFrame : clip.startFrame;
				const durationFrames = preview ? preview.durationFrames : clip.durationFrames;
				const width = Math.max(2, Math.round(durationFrames * zoom));
				const label = clipDisplayLabel(project, clip, t('inspector.clip'));
				const selected = Array.isArray(selectedClipIds) && selectedClipIds.includes(clip.id);
				const clipMedia = clip.mediaId ? findMedia(project, clip.mediaId) : null;
				const offline = Boolean(
					clip.mediaId &&
						((missingMediaIds && missingMediaIds.has(clip.mediaId)) || mediaMissingOf(clipMedia)),
				);
				return h(
					'div',
					{
						key: clip.id,
						className: 'ots-clip',
						'data-kind': clip.type,
						'data-selected': selected ? 'true' : 'false',
						'data-offline': offline ? 'true' : 'false',
						'data-dragging': dragState && dragState.clip.id === clip.id ? 'true' : 'false',
						style: { left: Math.round(startFrame * zoom), width },
						title: `${label} · ${formatTimecode(startFrame, fps)} – ${formatTimecode(startFrame + durationFrames, fps)}${offline ? ` · ${t('media.offline')}` : ''}`,
						'aria-label': label,
						tabIndex: 0,
						onPointerDown: (event) => beginClipDrag(event, track, clip),
						onKeyDown: (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								onSelectClip(clip.id, event);
							}
						},
					},
					width > 28 ? h('span', { className: 'ots-clip-label' }, label) : null,
					offline ? h('span', { className: 'ots-clip-offline-badge', title: t('media.offline') }, '!') : null,
					h('span', {
						className: 'ots-clip-handle ots-clip-handle-start',
						onPointerDown: (event) => beginTrim(event, track, clip, 'start'),
					}),
					h('span', {
						className: 'ots-clip-handle ots-clip-handle-end',
						onPointerDown: (event) => beginTrim(event, track, clip, 'end'),
					}),
				);
			};

			const renderTransitionFlags = (track) =>
				projectTransitions(project)
					.filter((transition) => transition && transition.trackId === track.id)
					.map((transition) => {
						const fromClip = track.clips.find((clip) => clip.id === transition.fromClipId);
						if (!fromClip) return null;
						const boundary = fromClip.startFrame + fromClip.durationFrames;
						const type = TRANSITION_TYPES.includes(transition.type) ? transition.type : 'dissolve';
						return h('div', {
							key: `transition-${transition.id}`,
							className: 'ots-transition-flag',
							style: { left: Math.round(boundary * zoom) - 7 },
							title: t('timeline.transitionTitle', { type: t(`transition.${type}`), duration: transition.durationFrames }),
							onPointerDown: (event) => {
								event.stopPropagation();
								event.preventDefault();
								onSeek(boundary);
							},
						}, '⧉');
					});

			const renderedTracks = tracks.map((track) => {
				const otherClip = dragState && dragState.preview.trackId !== track.id ? dragState.clip.id : null;
				const clips = track.clips.filter((clip) => clip.id !== otherClip);
				const dragHere = dragState && dragState.preview.trackId === track.id;
				return h(
					'div',
					{
						key: track.id,
						className: 'ots-track',
						ref: (element) => {
							if (element) rowRefs.current[track.id] = element;
							else delete rowRefs.current[track.id];
						},
						'data-track-id': track.id,
						'data-muted': track.muted === true ? 'true' : 'false',
						'data-hidden': track.hidden === true ? 'true' : 'false',
					},
					renderTrackHead(track),
					h(
						'div',
						{
							className: 'ots-track-lane',
							style: { width: laneWidth, '--ots-grid': `${Math.max(8, stepFrames * zoom)}px` },
							onPointerDown: (event) => {
								if (event.target === event.currentTarget) {
									beginScrub(event);
								}
							},
							onDragOver: (event) => event.preventDefault(),
							onDrop: (event) => handleDrop(event, track),
						},
						clips.map((clip) => renderClip(track, clip, null)),
						dragHere ? renderClip(track, dragState.clip, dragState.preview) : null,
						renderTransitionFlags(track),
					),
				);
			});

			return h(
				'section',
				{ className: 'ots-timeline', 'aria-label': t('timeline.title') },
				h(
					'div',
					{ className: 'ots-timeline-toolbar' },
					h(
						Btn,
						{ variant: 'outline', onClick: onSplit, disabled: !canSplit, title: canSplit ? t('timeline.split') : t('timeline.splitDisabled') },
						t('timeline.split'),
					),
					h(
						Btn,
						{ variant: 'outline', onClick: onDelete, disabled: !canDelete, title: canDelete ? t('timeline.delete') : t('timeline.deleteDisabled') },
						t('timeline.delete'),
					),
					h(Btn, { variant: 'outline', onClick: onAddText, disabled: !project }, t('timeline.addText')),
					h(Btn, { variant: 'outline', onClick: onAddMotion, disabled: !project }, t('timeline.addMotion')),
					h(Btn, { variant: 'outline', onClick: onAddMarker, disabled: !project, title: t('timeline.addMarker') }, t('timeline.addMarker')),
					h(Btn, { variant: 'outline', onClick: onDeleteRipple, disabled: !canDelete, title: t('timeline.rippleDelete') }, t('timeline.rippleDelete')),
					h(Btn, { onClick: onCopy, disabled: !canCopy, title: t('timeline.copy') }, t('timeline.copy')),
					h(Btn, { onClick: onPaste, disabled: !canPaste, title: t('timeline.paste') }, t('timeline.paste')),
					h(
						Btn,
						{
							active: Boolean(snapping),
							onClick: onToggleSnapping,
							title: t('timeline.snap'),
							'aria-pressed': snapping ? 'true' : 'false',
						},
						t('timeline.snap'),
					),
					h('span', { className: 'ots-timeline-spacer' }),
					h(Btn, { onClick: () => onAddTrack('video'), disabled: !project, title: t('timeline.addVideoTrack') }, t('timeline.addVideoTrack')),
					h(Btn, { onClick: () => onAddTrack('audio'), disabled: !project, title: t('timeline.addAudioTrack') }, t('timeline.addAudioTrack')),
					h('span', { className: 'ots-timeline-spacer' }),
					h(Btn, { onClick: () => onSetZoom(clamp(zoom / 1.25, MIN_ZOOM, MAX_ZOOM)), disabled: !project, title: t('timeline.zoomOut'), 'aria-label': t('timeline.zoomOut') }, '−'),
					h('span', { className: 'ots-timeline-zoom' }, t('timeline.zoomValue', { percent: Math.round(zoom * 100) })),
					h(Btn, { onClick: () => onSetZoom(clamp(zoom * 1.25, MIN_ZOOM, MAX_ZOOM)), disabled: !project, title: t('timeline.zoomIn'), 'aria-label': t('timeline.zoomIn') }, '+'),
					h(
						Btn,
						{
							onClick: () => {
								const available = Math.max(120, (scrollSize.width || 640) - HEAD_WIDTH - 32);
								const frames = Math.max(1, duration + Math.round(fps * 2));
								onSetZoom(clamp(available / frames, MIN_ZOOM, MAX_ZOOM));
							},
							disabled: !project,
							title: t('timeline.fit'),
						},
						t('timeline.fit'),
					),
				),
				h(
					'div',
					{
						className: 'ots-timeline-scroll',
						ref: scrollRef,
						onDragOver: (event) => event.preventDefault(),
						onDrop: (event) => handleDrop(event, null),
					},
					h(
						'div',
						{ className: 'ots-timeline-content' },
						h(
							'div',
							{ className: 'ots-ruler', 'aria-label': t('timeline.ruler') },
							h('div', { className: 'ots-ruler-head' }, t('timeline.title')),
							h(
								'div',
								{ className: 'ots-ruler-lane', style: { width: laneWidth }, onPointerDown: beginScrub },
								Array.from({ length: tickCount }, (unused, index) => {
									const frame = index * stepFrames;
									const left = Math.round(frame * zoom);
									return h(
										'div',
										{
											key: `tick-${index}`,
											className: 'ots-ruler-tick',
											'data-major': 'true',
											style: { left },
										},
										h('span', { className: 'ots-ruler-label' }, formatClock(frame / fps)),
									);
								}),
								projectMarkers(project).map((marker) => {
									if (!marker) return null;
									const frame = Math.max(0, Math.round(finiteNumber(marker.frame, 0)));
									const label = typeof marker.label === 'string' && marker.label.length > 0 ? marker.label : t('inspector.markersDefaultLabel');
									return h(
										'div',
										{
											key: `marker-${marker.id}`,
											className: 'ots-marker',
											style: { left: Math.round(frame * zoom), ...(typeof marker.color === 'string' && marker.color.length > 0 ? { background: marker.color } : {}) },
											title: t('timeline.markerTitle', { label }),
											onPointerDown: (event) => {
												event.stopPropagation();
												event.preventDefault();
												onSeek(frame);
											},
										},
										h('span', { className: 'ots-marker-label' }, label),
									);
								}),
							),
						),
						renderedTracks,
						tracks.length === 0
							? h(
									'div',
									{ className: 'ots-timeline-empty' },
									h('strong', {}, t('timeline.empty')),
									h('span', {}, t('timeline.emptyHint')),
								)
							: null,
						h(
							'div',
							{
								className: 'ots-playhead',
								style: { left: HEAD_WIDTH + Math.round(currentFrame * zoom) },
								'aria-hidden': 'true',
							},
						),
					),
				),
			);
		}

		// -------------------------------------------------------------------
		// Dialogs
		// -------------------------------------------------------------------

		function MotionDialog(props) {
			const { t, dialog, onChange, onClose, onSubmit } = props;
			const busy = Boolean(dialog.busy);
			return h(
				'div',
				{
					className: 'ots-modal-backdrop ots-modal-fixed',
					role: 'dialog',
					'aria-modal': 'true',
					'aria-label': t('motion.addTitle'),
					onPointerDown: (event) => {
						if (event.target === event.currentTarget && !busy) onClose();
					},
				},
				h(
					'div',
					{ className: 'ots-modal' },
					h('h2', { className: 'ots-modal-title' }, t('motion.addTitle')),
					h(
						'div',
						{ className: 'ots-modal-body' },
						h(
							'div',
							{ className: 'ots-field-grid' },
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('motion.template')),
								h(
									'select',
									{
										className: 'ots-select',
										value: dialog.template,
										'aria-label': t('motion.template'),
										onChange: (event) => onChange({ template: event.target.value }),
									},
									MOTION_TEMPLATES.map((value) => h('option', { key: value, value }, t(`motion.template${value.charAt(0).toUpperCase()}${value.slice(1)}`))),
								),
							),
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('motion.align')),
								h(
									'select',
									{
										className: 'ots-select',
										value: dialog.align,
										'aria-label': t('motion.align'),
										onChange: (event) => onChange({ align: event.target.value }),
									},
									['left', 'center', 'right'].map((value) => h('option', { key: value, value }, t(`motion.align${value.charAt(0).toUpperCase()}${value.slice(1)}`))),
								),
							),
						),
						h(
							'label',
							{ className: 'ots-field' },
							h('span', { className: 'ots-field-label' }, t('motion.text')),
							h('textarea', {
								className: 'ots-textarea',
								value: dialog.text,
								placeholder: t('motion.textPlaceholder'),
								'aria-label': t('motion.text'),
								onChange: (event) => onChange({ text: event.target.value }),
							}),
						),
						h(
							'label',
							{ className: 'ots-field' },
							h('span', { className: 'ots-field-label' }, t('motion.subtitle')),
							h('input', {
								className: 'ots-input',
								type: 'text',
								value: dialog.subtitle,
								placeholder: t('motion.subtitlePlaceholder'),
								'aria-label': t('motion.subtitle'),
								onChange: (event) => onChange({ subtitle: event.target.value }),
							}),
						),
						h(
							'div',
							{ className: 'ots-field-grid' },
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('motion.color')),
								h('input', {
									className: 'ots-color-input',
									type: 'color',
									value: dialog.color,
									'aria-label': t('motion.color'),
									onChange: (event) => onChange({ color: event.target.value }),
								}),
							),
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('motion.accentColor')),
								h('input', {
									className: 'ots-color-input',
									type: 'color',
									value: dialog.accentColor,
									'aria-label': t('motion.accentColor'),
									onChange: (event) => onChange({ accentColor: event.target.value }),
								}),
							),
							h(NumberField, {
								label: t('motion.fontSize'),
								value: dialog.fontSize,
								min: 18,
								max: 200,
								step: 1,
								onChange: (value) => onChange({ fontSize: value }),
							}),
							h(NumberField, {
								label: t('motion.durationSeconds'),
								value: dialog.durationSeconds,
								min: 0.5,
								max: 60,
								step: 0.5,
								onChange: (value) => onChange({ durationSeconds: value }),
							}),
						),
						h(
							'label',
							{ className: 'ots-check' },
							h('input', {
								type: 'checkbox',
								checked: dialog.background === true,
								'aria-label': t('motion.background'),
								onChange: (event) => onChange({ background: event.target.checked }),
							}),
							t('motion.background'),
						),
						dialog.error ? h('p', { className: 'ots-modal-error', role: 'alert' }, dialog.error) : null,
					),
					h(
						'div',
						{ className: 'ots-modal-actions' },
						h(Btn, { variant: 'ghost', onClick: onClose, disabled: busy }, t('actions.cancel')),
						h(Btn, { variant: 'primary', onClick: onSubmit, disabled: busy }, busy ? t('dialog.working') : t('motion.addAction')),
					),
				),
			);
		}

		function Dialog(props) {
			const {
				t,
				dialog,
				project,
				onPatch,
				onBrowse,
				onSubmit,
				onClose,
				title,
				recentProjects,
				recentLoading,
				recentError,
				onOpenRecent,
				onClearRecent,
				onRefreshRecent,
			} = props;
			const isExport = dialog.mode === 'export';
			const isNew = dialog.mode === 'new';
			const busy = Boolean(dialog.busy);
			const exportSettings = isExport ? effectiveExportSettings(project, dialog) : null;
			const exportQuality = exportSettings
				? exportSettings.qualityMode === 'crf'
					? t('export.summaryCrf', { value: exportSettings.crf })
					: t('export.summaryBitrate', { value: exportSettings.bitrate })
				: '';
			const exportSummary = exportSettings
				? t('export.summary', {
						codec:
							exportSettings.codec === 'h265'
								? t('export.codecH265')
								: exportSettings.codec === 'prores'
									? t('export.codecProres')
									: exportSettings.codec === 'prores4444'
										? t('export.codecProres4444')
										: exportSettings.codec === 'vp9'
										? t('export.codecVp9')
										: t('export.codecH264'),
						width: exportSettings.width,
						height: exportSettings.height,
						fps: exportSettings.fps,
						quality: exportQuality,
					})
				: '';
			const projectLabel = h(
				'label',
				{ className: 'ots-field' },
				h('span', { className: 'ots-field-label' }, isExport ? t('dialog.outputFile') : dialog.mode === 'import' ? t('dialog.mediaFolder') : t('dialog.folder')),
				h(
					'div',
					{ className: 'ots-modal-path-row' },
					h('input', {
						className: 'ots-input',
						type: 'text',
						value: dialog.path,
						placeholder: isExport ? t('dialog.outputPlaceholder') : t('dialog.pathPlaceholder'),
						spellCheck: false,
						onChange: (event) => onPatch({ path: event.target.value }),
						onKeyDown: (event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								onSubmit();
							}
						},
						autoFocus: true,
					}),
					h(Btn, { variant: 'outline', onClick: onBrowse, disabled: busy }, t('actions.browse')),
				),
				h(
					'p',
					{ className: 'ots-modal-hint' },
					isNew
						? t('dialog.newHint')
						: dialog.mode === 'open'
							? t('dialog.openHint')
							: dialog.mode === 'import'
								? t('dialog.importHint')
								: t('dialog.exportHint'),
				),
				h('p', { className: 'ots-modal-hint' }, t('dialog.pathHint')),
			);
			const exportOptions = isExport
				? [
						h(
							'div',
							{ className: 'ots-export-grid', key: 'export-options' },
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('export.codec')),
								h(
									'select',
									{
										className: 'ots-select',
										value: ['h264', 'h265', 'prores', 'prores4444', 'vp9'].includes(dialog.codec) ? dialog.codec : 'h264',
										'aria-label': t('export.codec'),
										title: t('export.codec'),
										onChange: (event) => {
											const nextCodec = event.target.value;
											const patch = { codec: nextCodec };
											if (nextCodec !== 'prores4444') patch.transparent = false;
											if (nextCodec === 'prores' || nextCodec === 'prores4444') patch.bitDepth = 10;
											else if (!EXPORT_BIT_DEPTH_CODECS.includes(nextCodec)) patch.bitDepth = 8;
											onPatch(patch);
										},
									},
									h('option', { value: 'h264' }, t('export.codecH264')),
									h('option', { value: 'h265' }, t('export.codecH265')),
									h('option', { value: 'prores' }, t('export.codecProres')),
									h('option', { value: 'prores4444' }, t('export.codecProres4444')),
									h('option', { value: 'vp9' }, t('export.codecVp9')),
								),
							),
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('export.fps')),
								h(
									'select',
									{
										className: 'ots-select',
										value: String(dialog.fps),
										'aria-label': t('export.fps'),
										title: t('export.fps'),
										onChange: (event) => onPatch({ fps: event.target.value === 'project' ? 'project' : Number(event.target.value) }),
									},
									h('option', { value: 'project' }, t('export.fpsProject', { fps: project ? project.fps : 30 })),
									[24, 25, 30, 50, 60].map((fps) => h('option', { key: fps, value: String(fps) }, `${fps} fps`)),
								),
							),
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('export.resolution')),
								h(
									'select',
									{
										className: 'ots-select',
										value: ['project', '1080p', '720p', 'custom'].includes(dialog.resolution) ? dialog.resolution : 'project',
										'aria-label': t('export.resolution'),
										title: t('export.resolution'),
										onChange: (event) => onPatch({ resolution: event.target.value }),
									},
									h('option', { value: 'project' }, t('export.resProject', { width: project ? project.width : 1920, height: project ? project.height : 1080 })),
									h('option', { value: '1080p' }, t('export.res1080p')),
									h('option', { value: '720p' }, t('export.res720p')),
									h('option', { value: 'custom' }, t('export.resCustom')),
								),
							),
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('export.quality')),
								h(
									'select',
									{
										className: 'ots-select',
										value: dialog.qualityMode === 'bitrate' ? 'bitrate' : 'crf',
										'aria-label': t('export.quality'),
										title: t('export.quality'),
										onChange: (event) => onPatch({ qualityMode: event.target.value }),
									},
									h('option', { value: 'crf' }, t('export.qualityCrf')),
									h('option', { value: 'bitrate' }, t('export.qualityBitrate')),
								),
							),
							dialog.resolution === 'custom'
								? h(
										'div',
										{ className: 'ots-export-custom', key: 'custom-size' },
										h(
											'label',
											{ className: 'ots-field' },
											h('span', { className: 'ots-field-label' }, t('export.customWidth')),
											h('input', {
												className: 'ots-input',
												type: 'number',
												min: 2,
												step: 1,
												value: dialog.width,
												'aria-label': t('export.customWidth'),
												title: t('export.customWidth'),
												onChange: (event) => onPatch({ width: event.target.value }),
											}),
										),
										h(
											'label',
											{ className: 'ots-field' },
											h('span', { className: 'ots-field-label' }, t('export.customHeight')),
											h('input', {
												className: 'ots-input',
												type: 'number',
												min: 2,
												step: 1,
												value: dialog.height,
												'aria-label': t('export.customHeight'),
												title: t('export.customHeight'),
												onChange: (event) => onPatch({ height: event.target.value }),
											}),
										),
									)
								: null,
							dialog.qualityMode === 'bitrate'
								? h(
										'label',
										{ className: 'ots-field', key: 'bitrate' },
										h('span', { className: 'ots-field-label' }, t('export.bitrate')),
										h('input', {
											className: 'ots-input',
											type: 'text',
											value: dialog.bitrate,
											placeholder: t('export.bitratePlaceholder'),
											'aria-label': t('export.bitrate'),
											title: t('export.bitrate'),
											spellCheck: false,
											onChange: (event) => onPatch({ bitrate: event.target.value }),
										}),
									)
								: h(
										'label',
										{ className: 'ots-field', key: 'crf' },
										h('span', { className: 'ots-field-label' }, t('export.crf')),
										h('input', {
											className: 'ots-input',
											type: 'number',
											min: 0,
											max: 51,
											step: 1,
											value: dialog.crf,
											'aria-label': t('export.crf'),
											title: t('export.crf'),
											onChange: (event) => onPatch({ crf: event.target.value }),
										}),
									),
						),
						h(
							'label',
							{ className: 'ots-export-check', key: 'overwrite' },
							h('input', {
								type: 'checkbox',
								checked: dialog.overwrite === true,
								'aria-label': t('export.overwrite'),
								onChange: (event) => onPatch({ overwrite: event.target.checked }),
							}),
							t('export.overwrite'),
						),
						h(
							'div',
							{ className: 'ots-export-toggles', key: 'alpha-depth' },
							h(
								'label',
								{ className: 'ots-export-check', title: t('export.transparentHint') },
								h('input', {
									type: 'checkbox',
									checked: exportSettings.codec === 'prores4444' && dialog.transparent === true,
									disabled: exportSettings.codec !== 'prores4444',
									'aria-label': t('export.transparent'),
									onChange: (event) => onPatch({ transparent: event.target.checked }),
								}),
								t('export.transparent'),
							),
							h(
								'label',
								{ className: 'ots-export-check', title: t('export.bitDepthHint') },
								h('input', {
									type: 'checkbox',
									checked: exportSettings.bitDepth === 10,
									disabled: !['h265', 'vp9'].includes(exportSettings.codec),
									'aria-label': t('export.bitDepth10'),
									onChange: (event) => onPatch({ bitDepth: event.target.checked ? 10 : 8 }),
								}),
								t('export.bitDepth10'),
							),
						),
						h(
							'div',
							{ className: 'ots-export-grid', key: 'color-metadata' },
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('export.colorPrimaries')),
								h(
									'select',
									{
										className: 'ots-select',
										value: dialog.colorPrimaries || '',
										'aria-label': t('export.colorPrimaries'),
										title: t('export.colorPrimaries'),
										onChange: (event) => onPatch({ colorPrimaries: event.target.value }),
									},
									h('option', { value: '' }, t('export.colorAuto')),
									h('option', { value: 'bt709' }, t('export.primaries709')),
									h('option', { value: 'bt2020' }, t('export.primaries2020')),
								),
							),
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('export.colorTrc')),
								h(
									'select',
									{
										className: 'ots-select',
										value: dialog.colorTrc || '',
										'aria-label': t('export.colorTrc'),
										title: t('export.colorTrc'),
										onChange: (event) => onPatch({ colorTrc: event.target.value }),
									},
									h('option', { value: '' }, t('export.colorAuto')),
									h('option', { value: 'bt709' }, t('export.trcSdr')),
									h('option', { value: 'smpte2084' }, t('export.trcPq')),
									h('option', { value: 'arib-std-b67' }, t('export.trcHlg')),
								),
							),
							h(
								'label',
								{ className: 'ots-field' },
								h('span', { className: 'ots-field-label' }, t('export.colorspace')),
								h(
									'select',
									{
										className: 'ots-select',
										value: dialog.colorspace || '',
										'aria-label': t('export.colorspace'),
										title: t('export.colorspace'),
										onChange: (event) => onPatch({ colorspace: event.target.value }),
									},
									h('option', { value: '' }, t('export.colorAuto')),
									h('option', { value: 'bt709' }, t('export.space709')),
									h('option', { value: 'bt2020nc' }, t('export.space2020')),
								),
							),
						),
						h('p', { className: 'ots-field-hint', key: 'color-hint' }, t('export.colorHint')),
						h(
							'div',
							{ className: 'ots-export-summary', key: 'summary' },
							h('strong', {}, t('export.estimated')),
							h('div', {}, exportSummary),
							h('div', {}, t('export.extensionHint', { ext: exportSettings.extension })),
							exportSettings.codec === 'prores' || exportSettings.codec === 'prores4444'
								? h('div', { className: 'ots-note' }, t('export.proresHint'))
								: null,
						),
					]
				: [];
			return h(
				'div',
				{
					className: 'ots-modal-backdrop',
					role: 'dialog',
					'aria-modal': 'true',
					'aria-label': title,
					onPointerDown: (event) => {
						if (event.target === event.currentTarget && !busy) onClose();
					},
				},
				h(
					'div',
					{ className: 'ots-modal' },
					h('h2', { className: 'ots-modal-title' }, title),
					h(
						'div',
						{ className: 'ots-modal-body' },
						projectLabel,
						isNew
							? h(
									'label',
									{ className: 'ots-field' },
									h('span', { className: 'ots-field-label' }, t('dialog.projectName')),
									h('input', {
										className: 'ots-input',
										type: 'text',
										value: dialog.name,
										placeholder: t('dialog.projectNamePlaceholder'),
										onChange: (event) => onPatch({ name: event.target.value }),
										onKeyDown: (event) => {
											if (event.key === 'Enter') {
												event.preventDefault();
												onSubmit();
											}
										},
									}),
								)
							: null,
						dialog.mode === 'open' || isNew
							? h(RecentProjects, {
									t,
									projects: recentProjects,
									loading: recentLoading,
									error: recentError,
									onOpen: onOpenRecent,
									onClear: onClearRecent,
									onRefresh: onRefreshRecent,
									compact: true,
								})
							: null,
						isExport ? h('h3', { className: 'ots-section-title' }, t('export.settings')) : null,
						isExport ? exportOptions : null,
						dialog.status ? h('p', { className: 'ots-modal-hint', role: 'status', 'aria-live': 'polite' }, dialog.status) : null,
						dialog.error ? h('p', { className: 'ots-modal-error', role: 'alert' }, dialog.error) : null,
					),
					h(
						'div',
						{ className: 'ots-modal-actions' },
						h(Btn, { variant: 'ghost', onClick: onClose, disabled: busy }, t('actions.cancel')),
						h(
							Btn,
							{ variant: 'primary', onClick: onSubmit, disabled: busy },
							busy ? t('dialog.working') : isNew ? t('dialog.create') : dialog.mode === 'open' ? t('dialog.open') : dialog.mode === 'import' ? t('dialog.import') : t('dialog.export'),
						),
					),
				),
			);
		}

		// -------------------------------------------------------------------
		// Settings section
		// -------------------------------------------------------------------

		function SettingsSection(props) {
			const { t } = props;
			return h(
				'div',
				{ className: 'ots-settings' },
				h(
					'div',
					{ className: 'ots-settings-inner' },
					h("div", { className: 'ots-brand' }, h('span', { className: 'ots-brand-glyph' }, h(Glyph, { size: 34 }))),
					h('h2', {}, t('settings.title')),
					h('p', {}, t('settings.lead')),
					h(
						'div',
						{ className: 'ots-settings-section' },
						h('h3', {}, t('settings.dependencies')),
						h(
							'div',
							{ className: 'ots-settings-row' },
							h('span', {}, t('settings.ffmpeg')),
							h('span', {}, t('settings.dependencyHint')),
						),
						h(
							'div',
							{ className: 'ots-settings-row' },
							h('span', {}, t('settings.storage')),
							h('span', {}, t('settings.storageHint')),
						),
						h('p', {}, t('settings.previewNote')),
						h('p', {}, t('settings.rows')),
					),
					h(
						'div',
						{ className: 'ots-settings-section' },
						h('h3', {}, t('settings.shortcuts')),
						h(Shortcut, { t, shortcutKey: 'Space', label: t('inspector.shortcutPlay') }),
						h(Shortcut, { t, shortcutKey: 'Left / Right', label: t('inspector.shortcutStep') }),
						h(Shortcut, { t, shortcutKey: 'Delete', label: t('inspector.shortcutDelete') }),
						h(Shortcut, { t, shortcutKey: 'Cmd/Ctrl+Z', label: t('inspector.shortcutUndo') }),
						h(Shortcut, { t, shortcutKey: 'Shift+Cmd/Ctrl+Z', label: t('inspector.shortcutRedo') }),
						h(Shortcut, { t, shortcutKey: 'Cmd/Ctrl+K', label: t('inspector.shortcutSplit') }),
					),
				),
			);
		}

		// -------------------------------------------------------------------
		// Editor page
		// -------------------------------------------------------------------

		function EditorPage(props) {
			const { t, pickDirectory } = props;
			const [snapshot, setSnapshot] = React.useState(null);
			const [initializing, setInitializing] = React.useState(true);
			const [pollError, setPollError] = React.useState(null);
			const [actionError, setActionError] = React.useState(null);
			const [notice, setNotice] = React.useState(null);
			const [proxyPreview, setProxyPreview] = React.useState(() => readProxyPreviewPreference());
			const [proxyFailedIds, setProxyFailedIds] = React.useState(() => new Set());
			const [missingMediaIds, setMissingMediaIds] = React.useState(() => new Set());
			const [lottieReadyTick, setLottieReadyTick] = React.useState(0);
			const [recentProjects, setRecentProjects] = React.useState([]);
			const [recentLoading, setRecentLoading] = React.useState(true);
			const [recentError, setRecentError] = React.useState(null);
			const [selectedClipIds, setSelectedClipIds] = React.useState([]);
			const [snapping, setSnapping] = React.useState(true);
			const [currentFrame, setCurrentFrame] = React.useState(0);
			const [playing, setPlaying] = React.useState(false);
			const [loop, setLoop] = React.useState(false);
			const [monitorVolume, setMonitorVolume] = React.useState(1);
			const [zoom, setZoom] = React.useState(DEFAULT_ZOOM);
			const [busy, setBusy] = React.useState(0);
			const [dialog, setDialog] = React.useState(null);
			const [motionDialog, setMotionDialog] = React.useState(null);
			const [importing, setImporting] = React.useState(false);
			const [uploading, setUploading] = React.useState(null);
			const [inspectorDraft, setInspectorDraft] = React.useState(null);
			const [dismissed, setDismissed] = React.useState(null);
			const [hasClipboard, setHasClipboard] = React.useState(false);

			const snapshotRef = React.useRef(null);
			const projectRef = React.useRef(null);
			const selectedClipIdsRef = React.useRef([]);
			const primaryClipIdRef = React.useRef(null);
			const clipboardRef = React.useRef(null);
			const keyboardRef = React.useRef(null);
			const currentFrameRef = React.useRef(0);
			const playingRef = React.useRef(false);
			const loopRef = React.useRef(false);
			const monitorVolumeRef = React.useRef(1);
			const zoomRef = React.useRef(DEFAULT_ZOOM);
			const canvasRef = React.useRef(null);
			const stageRef = React.useRef(null);
			const mediaElements = React.useRef({});
			const clockRef = React.useRef({ anchorTs: 0, anchorFrame: 0, frame: 0, lastUi: 0 });
			const drawRef = React.useRef(null);
			const scheduleDrawRef = React.useRef(null);
			const refreshFrameRef = React.useRef(null);
			const drawRafRef = React.useRef(0);
			const noticeTimerRef = React.useRef(null);
			const pendingRef = React.useRef(null);
			const pendingTimerRef = React.useRef(null);
			const draftKeyRef = React.useRef(null);
			const exportStateRef = React.useRef(null);
			const stageSize = useElementSize(stageRef);

			const primaryClipId = selectedClipIds.length > 0 ? selectedClipIds[selectedClipIds.length - 1] : null;
			snapshotRef.current = snapshot;
			selectedClipIdsRef.current = selectedClipIds;
			primaryClipIdRef.current = primaryClipId;
			currentFrameRef.current = currentFrame;
			playingRef.current = playing;
			loopRef.current = loop;
			monitorVolumeRef.current = monitorVolume;
			zoomRef.current = zoom;
			const project = snapshot ? snapshot.project : null;
			const lottieMediaKey = project
				? project.media
						.filter((media) => media.kind === 'lottie')
						.map((media) => `${media.id}:${media.fileName || ''}`)
						.join('|')
				: '';
			React.useEffect(() => {
				const lottieMedia = project ? project.media.filter((media) => media.kind === 'lottie') : [];
				const activeIds = new Set(lottieMedia.map((media) => media.id));
				disposeLottiePreviewsExcept(activeIds);
				let cancelled = false;
				for (const media of lottieMedia) {
					ensureLottiePreview(media)
						.then(() => {
							if (!cancelled) setLottieReadyTick((value) => value + 1);
						})
						.catch(() => {
							if (!cancelled) setLottieReadyTick((value) => value + 1);
						});
				}
				return () => {
					cancelled = true;
				};
			}, [lottieMediaKey]);
			React.useEffect(() => {
				return () => disposeAllLottiePreviews();
			}, []);
			projectRef.current = project;

			const fps = project ? project.fps : 30;
			const duration = project ? timelineDurationFrames(project) : 0;

			const toggleProxyPreview = () => {
				const next = !proxyPreview;
				setProxyPreview(next);
				writeProxyPreviewPreference(next);
				setProxyFailedIds(new Set());
			};
			const handleProxyVideoError = (media) => {
				if (!proxyPreview || proxyFailedIds.has(media.id)) return;
				setProxyFailedIds((previous) => {
					const next = new Set(previous);
					next.add(media.id);
					return next;
				});
				showNotice(t('proxy.fallback', { name: media.name }));
			};
			const markMediaMissing = (media) => {
				if (!media || missingMediaIds.has(media.id)) return;
				setMissingMediaIds((previous) => {
					const next = new Set(previous);
					next.add(media.id);
					return next;
				});
				showNotice(t('media.missingDetected', { name: media.name }));
			};
			const handleMediaRelinked = (mediaId) => {
				setMissingMediaIds((previous) => {
					if (!previous.has(mediaId)) return previous;
					const next = new Set(previous);
					next.delete(mediaId);
					return next;
				});
			};
			const showNotice = (message) => {
				if (!message) return;
				setNotice(message);
				if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
				noticeTimerRef.current = setTimeout(() => {
					noticeTimerRef.current = null;
					setNotice(null);
				}, 5000);
			};

			const messageFor = (error) => {
				if (!error) return t('error.action', { message: '' });
				const raw = typeof error.message === 'string' ? error.message : String(error);
				if (!error.fromHost && /(failed to fetch|networkerror|load failed)/i.test(raw)) return t('error.network');
				return t('error.action', { message: raw });
			};

			const refreshRecentProjects = async () => {
				setRecentLoading(true);
				setRecentError(null);
				try {
					const data = await hostRequest('projects/recent');
					setRecentProjects(data && Array.isArray(data.projects) ? data.projects : []);
				} catch (error) {
					setRecentError(messageFor(error));
				} finally {
					setRecentLoading(false);
				}
			};

			const absorb = (payload) => {
				if (!payload || typeof payload !== 'object') return null;
				if (payload.version === 1 && 'project' in payload) {
					setSnapshot(payload);
					snapshotRef.current = payload;
					projectRef.current = payload.project;
					return payload;
				}
				return null;
			};

			const perform = async (fns) => {
				setBusy((count) => count + 1);
				setActionError(null);
				try {
					const payload = await fns();
					absorb(payload);
					return payload;
				} catch (error) {
					setActionError(messageFor(error));
					return null;
				} finally {
					setBusy((count) => count - 1);
				}
			};

			React.useEffect(() => {
				let disposed = false;
				let timer = null;
				const poll = async () => {
					if (disposed) return;
					const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
					if (!hidden) {
						try {
							const payload = await hostRequest(exportStateRef.current === 'running' ? 'export/status' : 'state');
							if (!disposed) {
								absorb(payload);
								setPollError(null);
							}
						} catch (error) {
							if (!disposed) setPollError(messageFor(error));
						}
					}
					if (!disposed) {
						setInitializing(false);
						const exporting = exportStateRef.current === 'running';
						timer = setTimeout(poll, exporting ? 600 : 1000);
					}
				};
				void poll();
				const onVisibility = () => {
					if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
						void poll();
					}
				};
				if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
				return () => {
					disposed = true;
					if (timer !== null) clearTimeout(timer);
					if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
				};
			}, []);

			React.useEffect(() => {
				return () => {
					if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
					if (pendingTimerRef.current !== null) clearTimeout(pendingTimerRef.current);
					if (drawRafRef.current) cancelAnimationFrame(drawRafRef.current);
				};
			}, []);

			const projectRoot = snapshot ? snapshot.projectRoot : null;
			React.useEffect(() => {
				void refreshRecentProjects();
			}, [projectRoot]);
			React.useEffect(() => {
				setSelectedClipIds([]);
				clipboardRef.current = null;
				setHasClipboard(false);
				setCurrentFrame(0);
				setPlaying(false);
				setInspectorDraft(null);
				draftKeyRef.current = null;
				clockRef.current.frame = 0;
				currentFrameRef.current = 0;
				pendingRef.current = null;
			}, [projectRoot]);

			const selectedEntry = project ? findClipEntry(project, primaryClipId) : null;
			const selected = selectedEntry ? selectedEntry.clip : null;

			React.useEffect(() => {
				if (!project || selectedClipIds.length === 0) return;
				const existing = selectedClipIds.filter((clipId) => findClipEntry(project, clipId) !== null);
				if (existing.length !== selectedClipIds.length) {
					setSelectedClipIds(existing);
					if (existing.length === 0) setInspectorDraft(null);
				}
			}, [project, selectedClipIds]);

			React.useEffect(() => {
				if (!selected) {
					setInspectorDraft(null);
					draftKeyRef.current = null;
					return;
				}
				const key = `${selected.id}:${projectRoot || ''}`;
				if (draftKeyRef.current === key) return;
				draftKeyRef.current = key;
				setInspectorDraft(draftFromClip(selected));
			}, [selected ? selected.id : null, projectRoot]);

			React.useEffect(() => {
				const exportState = snapshot && snapshot.export ? snapshot.export : null;
				const previous = exportStateRef.current;
				exportStateRef.current = exportState ? exportState.state : null;
				if (exportState && previous && previous !== exportState.state) {
					if (exportState.state === 'done') {
						showNotice(exportState.output ? t('status.exportDone', { path: exportState.output }) : t('status.exportDoneNoPath'));
					} else if (exportState.state === 'error') {
						setActionError(t('error.export', { message: exportState.error || '' }));
					} else if (exportState.state === 'idle' && previous === 'running') {
						showNotice(t('status.exportCancelled'));
					}
				}
			}, [snapshot && snapshot.export ? snapshot.export.state : null]);

			const canvasWidth = (() => {
				const ratio = project ? project.width / project.height : 16 / 9;
				const availableWidth = stageSize.width > 0 ? stageSize.width : 640;
				const availableHeight = stageSize.height > 0 ? stageSize.height : 360;
				let width = availableWidth;
				let height = width / ratio;
				if (height > availableHeight) {
					height = availableHeight;
					width = height * ratio;
				}
				return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
			})();

			const scheduleDraw = () => {
				if (drawRafRef.current) return;
				drawRafRef.current = requestAnimationFrame(() => {
					drawRafRef.current = 0;
					if (drawRef.current) drawRef.current(currentFrameRef.current);
				});
			};
			scheduleDrawRef.current = scheduleDraw;

			const drawFrame = (frame) => {
				const canvas = canvasRef.current;
				if (!canvas) return;
				const currentProject = projectRef.current;
				if (!currentProject) return;
				let context = null;
				try {
					context = canvas.getContext('2d');
				} catch (error) {
					return;
				}
				if (!context) return;
				if (canvas.width !== currentProject.width || canvas.height !== currentProject.height) {
					canvas.width = currentProject.width;
					canvas.height = currentProject.height;
				}
				drawComposite(context, currentProject, frame, mediaElements.current);
			};
			drawRef.current = drawFrame;

			const pauseMedia = () => {
				for (const element of Object.values(mediaElements.current)) {
					if (element.video) {
						try {
							element.video.pause();
						} catch (error) {
							/* ignore */
						}
					}
					if (element.audio) {
						try {
							element.audio.pause();
						} catch (error) {
							/* ignore */
						}
					}
				}
			};

			const syncMedia = (frame, isPlaying) => {
				const currentProject = projectRef.current;
				if (!currentProject) return;
				const active = activeClipsAt(currentProject, frame);
				const voiceActive = active.some((row) => {
					const track = row.track;
					const clip = row.clip;
					if (!track || trackRoleOf(track) !== 'voice' || track.muted === true) return false;
					const media = findMedia(currentProject, clip.mediaId);
					if (!media) return false;
					if (!(clip.type === 'audio' || (clip.type === 'video' && media.hasAudio))) return false;
					return (
						clipPropertyAt(clip, 'volume', clipRelativeFrame(clip, frame), finiteNumber(clip.volume, 1)) *
							clipFadeFactor(clip, frame) >
						0.001
					);
				});
				const audioByMedia = new Map();
				const videoByMedia = new Map();
				for (const row of active) {
					const clip = row.clip;
					const media = findMedia(currentProject, clip.mediaId);
					if (!media) continue;
					const muted = Boolean(row.track && row.track.muted);
					if (!muted && (clip.type === 'audio' || (clip.type === 'video' && media.hasAudio))) {
						if (!audioByMedia.has(media.id)) audioByMedia.set(media.id, { clip, track: row.track });
					}
					if (clip.type === 'video' && !videoByMedia.has(media.id)) videoByMedia.set(media.id, clip);
				}
				const rate = currentProject.fps;
				for (const media of currentProject.media) {
					const elements = mediaElements.current[media.id];
					if (!elements) continue;
					const audioEntry = audioByMedia.get(media.id);
					if (elements.audio) {
						const audio = elements.audio;
						if (audioEntry) {
							const audioClip = audioEntry.clip;
							const trackVolume = clamp(finiteNumber(audioEntry.track && audioEntry.track.volume, 1), 0, 2);
							const ducked = voiceActive && trackDuckingOf(audioEntry.track);
							const desired = clipSourceSeconds(audioClip, frame, rate);
							const audioSpeed = clipSpeedOf(audioClip);
							const audioVolume = clamp01(
								clipPropertyAt(audioClip, 'volume', clipRelativeFrame(audioClip, frame), finiteNumber(audioClip.volume, 1)) *
									clipFadeFactor(audioClip, frame) *
									monitorVolumeRef.current *
									trackVolume *
									(ducked ? DUCK_ATTENUATION : 1),
							);
							audio.volume = audioVolume;
							try {
								audio.playbackRate = audioSpeed;
							} catch (error) {
								/* unsupported rate on this browser */
							}
							if (isPlaying) {
								if (audio.paused) {
									const promise = audio.play();
									if (promise && typeof promise.catch === 'function') promise.catch(() => {});
								}
								if (Math.abs(audio.currentTime - desired) > 0.28) safeSetCurrentTime(audio, desired);
							} else {
								if (!audio.paused) audio.pause();
								if (Math.abs(audio.currentTime - desired) > 0.05) safeSetCurrentTime(audio, desired);
							}
						} else if (!audio.paused) {
							audio.pause();
						}
					}
					if (elements.video) {
						const videoClip = videoByMedia.get(media.id);
						if (videoClip) {
							const desired = clipSourceSeconds(videoClip, frame, rate);
							const videoSpeed = clipSpeedOf(videoClip);
							try {
								elements.video.playbackRate = videoSpeed;
							} catch (error) {
								/* unsupported rate on this browser */
							}
							if (isPlaying) {
								const video = elements.video;
								if (video.paused) {
									const promise = video.play();
									if (promise && typeof promise.catch === 'function') promise.catch(() => {});
								}
								if (Math.abs(video.currentTime - desired) > 0.3) safeSetCurrentTime(video, desired);
							} else {
								const video = elements.video;
								if (!video.paused) video.pause();
								if (Math.abs(video.currentTime - desired) > 0.05) safeSetCurrentTime(video, desired);
							}
						} else {
							const video = elements.video;
							if (!video.paused) video.pause();
						}
					}
				}
			};

			const applyFrame = (frame) => {
				syncMedia(frame, playingRef.current);
				if (drawRef.current) drawRef.current(frame);
			};
			React.useEffect(() => {
				if (currentFrameRef.current > duration) {
					currentFrameRef.current = duration;
					clockRef.current.frame = duration;
					setCurrentFrame(duration);
				}
			}, [duration]);
			refreshFrameRef.current = () => {
				applyFrame(currentFrameRef.current);
			};

			React.useEffect(() => {
				if (!playing) {
					applyFrame(currentFrameRef.current);
				}
			}, [snapshot && snapshot.project, currentFrame, playing, lottieReadyTick]);

			React.useEffect(() => {
				if (!playing) return undefined;
				let raf = 0;
				const clock = clockRef.current;
				clock.anchorTs = now();
				clock.anchorFrame = currentFrameRef.current;
				syncMedia(currentFrameRef.current, true);
				const tick = () => {
					const currentProject = projectRef.current;
					const rate = currentProject ? currentProject.fps : 30;
					const total = currentProject ? timelineDurationFrames(currentProject) : 0;
					const elapsed = (now() - clock.anchorTs) / 1000;
					let frame = clock.anchorFrame + elapsed * rate;
					if (total <= 0) frame = 0;
					if (total > 0 && frame >= total) {
						if (loopRef.current) {
							clock.anchorTs = now();
							clock.anchorFrame = 0;
							frame = 0;
						} else {
							frame = total;
							setCurrentFrame(total);
							currentFrameRef.current = total;
							setPlaying(false);
						}
					}
					clock.frame = frame;
					syncMedia(frame, true);
					if (drawRef.current) drawRef.current(frame);
					const stamp = now();
					if (stamp - clock.lastUi > 33) {
						clock.lastUi = stamp;
						currentFrameRef.current = frame;
						setCurrentFrame(frame);
					}
					raf = requestAnimationFrame(tick);
				};
				raf = requestAnimationFrame(tick);
				return () => {
					cancelAnimationFrame(raf);
					pauseMedia();
				};
			}, [playing]);

			React.useEffect(() => {
				return () => {
					pauseMedia();
				};
			}, []);

			const seekToFrame = (frame) => {
				const total = projectRef.current ? timelineDurationFrames(projectRef.current) : 0;
				const target = clamp(Math.round(frame), 0, total);
				currentFrameRef.current = target;
				clockRef.current.frame = target;
				setCurrentFrame(target);
				if (playingRef.current) {
					clockRef.current.anchorTs = now();
					clockRef.current.anchorFrame = target;
				}
				applyFrame(target);
			};

			const stepFrame = (delta) => {
				if (!projectRef.current) return;
				if (playingRef.current) setPlaying(false);
				seekToFrame(currentFrameRef.current + delta);
			};

			const togglePlay = () => {
				if (!projectRef.current) return;
				const total = timelineDurationFrames(projectRef.current);
				if (total <= 0) return;
				if (playingRef.current) {
					setPlaying(false);
					return;
				}
				if (currentFrameRef.current >= total) {
					currentFrameRef.current = 0;
					setCurrentFrame(0);
				}
				setPlaying(true);
			};

			const runEdit = async (operations, options) => {
				const settings = options || {};
				const previousProject = projectRef.current;
				const payload = await perform(() => hostPost('edit', { operations }));
				if (!payload) return null;
				if (settings.selectNew) {
					const created = nextClipIdAfter(
						previousProject,
						payload.project,
						settings.selectNew === true ? null : settings.selectNew,
					);
					if (created) setSelectedClipIds([created]);
				}
				return payload;
			};

			const handleNew = () => setDialog({ mode: 'new', path: '', name: '', error: null, busy: false });
			const handleOpen = () => setDialog({ mode: 'open', path: projectRoot || '', name: '', error: null, busy: false });
			const handleOpenRecent = async (entry) => {
				if (!entry || entry.missing === true) return;
				setDialog(null);
				const payload = await perform(() => hostPost('project/open', { path: entry.root }));
				if (payload) {
					await refreshRecentProjects();
					showNotice(t('welcome.recentOpened', { name: entry.name || entry.root }));
				}
			};
			const handleClearRecent = async () => {
				try {
					await hostPost('projects/recent/clear', {});
					setRecentProjects([]);
					showNotice(t('welcome.recentCleared'));
				} catch (error) {
					setActionError(messageFor(error));
				}
			};
			const handleImport = async () => {
				if (!projectRef.current) return;
				let picked;
				try {
					picked = pickDirectory ? await pickDirectory() : undefined;
				} catch (error) {
					setActionError(messageFor(error));
					return;
				}
				if (picked === undefined) {
					setDialog({ mode: 'import', path: '', name: '', error: null, busy: false });
					return;
				}
				if (picked === null) return;
				setImporting(true);
				const payload = await perform(() => hostPost('media/import', { path: picked }));
				setImporting(false);
				if (payload) {
					const imported = Array.isArray(payload.imported) ? payload.imported.length : 0;
					const skipped = Array.isArray(payload.skipped) ? payload.skipped.length : 0;
					showNotice(t('media.imported', { count: imported, skipped }));
				}
			};
			const handleExport = () => {
				const projectValue = projectRef.current;
				if (!projectValue) return;
				const suggested = suggestedExportName(projectValue, 'h264');
				setDialog({
					mode: 'export',
					path: '',
					name: suggested,
					error: null,
					busy: false,
					codec: 'h264',
					transparent: false,
					bitDepth: 8,
					colorPrimaries: '',
					colorTrc: '',
					colorspace: '',
					resolution: 'project',
					width: projectValue.width,
					height: projectValue.height,
					fps: 'project',
					qualityMode: 'crf',
					crf: 20,
					bitrate: '8M',
					overwrite: false,
				});
			};
			const handleSave = async () => {
				const payload = await perform(() => hostPost('project/save'));
				if (payload) showNotice(t('status.saved'));
			};
			const handleUndo = async () => {
				const payload = await perform(() => hostPost('undo'));
				if (payload) {
					setInspectorDraft(null);
					draftKeyRef.current = null;
					showNotice(t('status.undo'));
				}
			};
			const handleRedo = async () => {
				const payload = await perform(() => hostPost('redo'));
				if (payload) {
					setInspectorDraft(null);
					draftKeyRef.current = null;
					showNotice(t('status.redo'));
				}
			};
			const handleCancelExport = async () => {
				const payload = await perform(() => hostPost('export/cancel'));
				if (payload) showNotice(t('status.exportCancelled'));
			};
			const handleExportFrame = () => {
				const projectValue = projectRef.current;
				if (!projectValue) return;
				try {
					const frame = Math.max(0, Math.round(currentFrameRef.current));
					let canvas = canvasRef.current;
					if (canvas && typeof canvas.toDataURL === 'function') {
						if (drawRef.current) drawRef.current(frame);
					} else {
						canvas = document.createElement('canvas');
						canvas.width = Math.max(2, Math.round(projectValue.width));
						canvas.height = Math.max(2, Math.round(projectValue.height));
						const context = canvas.getContext('2d');
						if (!context) throw new Error('canvas-unavailable');
						drawComposite(context, projectValue, frame, mediaElements.current);
					}
					const dataUrl = canvas.toDataURL('image/png');
					if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
						throw new Error('capture-failed');
					}
					const filename = exportFrameFileName(projectValue, frame);
					if (!downloadDataUrl(filename, dataUrl)) {
						throw new Error('download-unavailable');
					}
					showNotice(t('preview.frameExported', { file: filename }));
				} catch (error) {
					showNotice(t('preview.exportFrameError', { message: error && error.message ? error.message : String(error) }));
				}
			};

			const handleAddMedia = async (mediaId, trackId, startFrame) => {
				if (!projectRef.current) return;
				await runEdit(
					[
						{
							type: 'add-clip',
							mediaId,
							...(trackId ? { trackId } : {}),
							startFrame: startFrame === null || startFrame === undefined ? Math.round(currentFrameRef.current) : startFrame,
						},
					],
					{ selectNew: true },
				);
			};
			const handleDropMedia = (mediaId, trackId, startFrame) => {
				void handleAddMedia(mediaId, trackId, startFrame);
			};
			const handleMoveClip = (clip, startFrame, trackId) => {
				void runEdit([
					{
						type: 'move-clip',
						clipId: clip.id,
						startFrame,
						...(trackId && trackId !== (findClipEntry(projectRef.current, clip.id) || {}).track?.id ? { trackId } : {}),
					},
				]);
			};
			const handleTrimClip = (clip, preview) => {
				const operations = [
					{
						type: 'trim-clip',
						clipId: clip.id,
						durationFrames: Math.max(1, Math.round(preview.durationFrames)),
						...(clip.type === 'video' || clip.type === 'audio'
							? { trimStartFrame: Math.max(0, Math.round(preview.trimStartFrame)) }
							: {}),
					},
					{ type: 'move-clip', clipId: clip.id, startFrame: Math.max(0, Math.round(preview.startFrame)) },
				];
				void runEdit(operations);
			};
			const handleAddTrack = async (type) => {
				const payload = await perform(() => hostPost('tracks', { type }));
				if (payload) showNotice(t('status.trackAdded'));
			};
			const handleUpdateTrack = (trackId, patch) => {
				if (!trackId) return;
				void runEdit([{ type: 'update-track', trackId, ...patch }]);
			};
			const handleRemoveTrack = async (trackId) => {
				if (!trackId) return;
				const payload = await runEdit([{ type: 'remove-track', trackId }]);
				if (payload) showNotice(t('status.trackRemoved'));
			};
			const handleAddText = async () => {
				if (!projectRef.current) return;
				const startFrame = Math.round(currentFrameRef.current);
				const rate = Math.max(1, Math.round(projectRef.current.fps || 30));
				const payload = await runEdit(
					[
						{
							type: 'add-text',
							content: t('inspector.defaultText'),
							startFrame,
							durationFrames: Math.max(1, Math.round(rate * 3)),
						},
					],
					{ selectNew: (clip) => clip.type === 'text' },
				);
				if (payload) showNotice(t('status.textAdded'));
			};
			const handleSplit = async () => {
				const entry = findClipEntry(projectRef.current, primaryClipIdRef.current);
				if (!entry) return;
				const frame = Math.round(currentFrameRef.current);
				const clip = entry.clip;
				if (frame <= clip.startFrame || frame >= clip.startFrame + clip.durationFrames) return;
				const payload = await runEdit([{ type: 'split-clip', clipId: clip.id, atFrame: frame }], { selectNew: true });
				if (payload) showNotice(t('status.split'));
			};
			const handleDelete = async () => {
				const clipIds = selectedClipIdsRef.current.slice();
				if (clipIds.length === 0) return;
				setSelectedClipIds([]);
				setInspectorDraft(null);
				const payload = await runEdit([{ type: 'remove-clips', clipIds }]);
				if (payload) showNotice(t('status.deleted'));
			};
			const handleDeleteRipple = async () => {
				const projectValue = projectRef.current;
				const clipIds = selectedClipIdsRef.current.slice();
				if (!projectValue || clipIds.length === 0) return;
				const entries = clipIds
					.map((clipId) => findClipEntry(projectValue, clipId))
					.filter((entry) => entry !== null);
				if (entries.length === 0) return;
				const built = buildRippleOperations(projectValue, entries);
				setSelectedClipIds([]);
				setInspectorDraft(null);
				const payload = await runEdit(built.operations);
				if (payload) showNotice(t('status.rippleDeleted', { count: entries.length }));
			};
			const handleSelectClip = (clipId, event) => {
				const additive = Boolean(event && (event.shiftKey || event.metaKey || event.ctrlKey));
				setSelectedClipIds((previous) => {
					if (!additive) return [clipId];
					if (previous.includes(clipId)) return previous.filter((id) => id !== clipId);
					return previous.concat([clipId]);
				});
			};
			const handleSelectAll = () => {
				if (!projectRef.current) return;
				setSelectedClipIds(allClips(projectRef.current).map(({ clip }) => clip.id));
			};
			const handleCopy = () => {
				const projectValue = projectRef.current;
				const clipIds = selectedClipIdsRef.current.slice();
				if (!projectValue || clipIds.length === 0) {
					showNotice(t('status.copyEmpty'));
					return;
				}
				const entries = [];
				for (const clipId of clipIds) {
					const entry = findClipEntry(projectValue, clipId);
					if (entry) entries.push({ trackId: entry.track.id, clip: deepCopy(entry.clip) });
				}
				clipboardRef.current = { entries };
				setHasClipboard(entries.length > 0);
				showNotice(t('status.copied', { count: entries.length }));
			};
			const handlePaste = async () => {
				const clipboard = clipboardRef.current;
				if (!clipboard || clipboard.entries.length === 0) {
					showNotice(t('status.pasteEmpty'));
					return;
				}
				const built = buildPasteOperations(clipboard.entries, Math.round(currentFrameRef.current));
				if (built.operations.length === 0) return;
				const payload = await runEdit(built.operations);
				if (payload) {
					setSelectedClipIds(built.createdIds.filter((clipId) => findClipEntry(payload.project, clipId) !== null));
					showNotice(t('status.pasted', { count: built.createdIds.length }));
				}
			};
			const handleSetSpeed = (speed) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				void runEdit([{ type: 'set-speed', clipId, speed }]);
			};
			const handleSetFades = (patch) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				void runEdit([{ type: 'set-fades', clipId, ...patch }]);
			};
			const handleSetCrop = (crop) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				void runEdit([{ type: 'set-crop', clipId, crop }]);
			};
			const handleSetMask = (mask) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				void runEdit([{ type: 'set-mask', clipId, mask }]);
			};
			const handleSetBlendMode = (blendMode) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				void runEdit([{ type: 'set-blend-mode', clipId, blendMode }]);
			};
			const handleSetKeyframes = (property, keyframes) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				void runEdit([{ type: 'set-keyframes', clipId, property, keyframes }]);
			};
			const handleAddEffect = async (type) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				const payload = await runEdit([
					{
						type: 'add-effect',
						clipId,
						effect: { id: newId(), type, enabled: true, params: effectDefaultParams(type) },
					},
				]);
				if (payload) showNotice(t('status.effectAdded'));
			};
			const handleUpdateEffect = (effectId, patch) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				void runEdit([{ type: 'update-effect', clipId, effectId, patch }]);
			};
			const handleRemoveEffect = (effectId) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				void runEdit([{ type: 'remove-effect', clipId, effectId }]);
			};
			const handleReorderEffects = (effectIds) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				void runEdit([{ type: 'reorder-effects', clipId, effectIds }]);
			};
			const handleAddTransition = async (transition) => {
				const payload = await runEdit([{ type: 'add-transition', transition }]);
				if (payload) showNotice(t('status.transitionAdded'));
			};
			const handleUpdateTransition = (transitionId, patch) => {
				const operation = { type: 'update-transition', transitionId };
				if (patch.type !== undefined) operation.transitionType = patch.type;
				if (patch.durationFrames !== undefined) operation.durationFrames = patch.durationFrames;
				void runEdit([operation]);
			};
			const handleRemoveTransition = (transitionId) => {
				void runEdit([{ type: 'remove-transition', transitionId }]);
			};
			const handleAddCaption = async () => {
				if (!projectRef.current) return;
				const rate = Math.max(1, Math.round(projectRef.current.fps || 30));
				const durationFrames = Math.max(1, Math.round(rate * 3));
				const clipId = newId();
				const payload = await runEdit(
					[
						{
							type: 'add-caption',
							clipId,
							startFrame: Math.round(currentFrameRef.current),
							durationFrames,
							segments: [{ startFrame: 0, durationFrames, text: '' }],
							style: deepCopy(DEFAULT_CAPTION_STYLE),
						},
					],
					{ selectNew: (clip) => clip.type === 'caption' },
				);
				if (payload) showNotice(t('status.captionAdded'));
			};
			const handleUpdateCaption = (patch) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				void runEdit([{ type: 'update-caption', clipId, ...patch }]);
			};
			const handleOpenMotionDialog = () => {
				setMotionDialog(defaultMotionForm(t));
			};
			const submitMotionDialog = async () => {
				const projectValue = projectRef.current;
				if (!projectValue || !motionDialog || motionDialog.busy) return;
				const durationFrames = Math.max(
					1,
					Math.round(finiteNumber(motionDialog.durationSeconds, 3) * Math.max(1, Number(projectValue.fps) || 30)),
				);
				const motion = normalizeMotionInput(motionDialog);
				setMotionDialog(Object.assign({}, motionDialog, { busy: true, error: null }));
				const payload = await runEdit(
					[
						{
							type: 'add-motion',
							clipId: newId(),
							startFrame: Math.max(0, Math.round(currentFrameRef.current)),
							durationFrames,
							motion,
						},
					],
					{ selectNew: (clip) => clip.type === 'motion' },
				);
				if (payload) {
					setMotionDialog(null);
					showNotice(t('motion.added'));
				} else {
					setMotionDialog(Object.assign({}, motionDialog, { busy: false, error: t('motion.addFailed') }));
				}
			};
			const handleUpdateMotion = (motion) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				const entry = projectRef.current ? findClipEntry(projectRef.current, clipId) : null;
				if (!entry || entry.clip.type !== 'motion') return;
				const next = Object.assign({}, motionOf(entry.clip), motion);
				void runEdit([{ type: 'update-motion', clipId, motion: next }]);
			};
			const handleSetMotionDuration = (durationFrames) => {
				const clipId = primaryClipIdRef.current;
				if (!clipId) return;
				void runEdit([{ type: 'trim-clip', clipId, durationFrames: Math.max(1, Math.round(durationFrames)) }]);
			};
			const handleOpenSearchResult = (result) => {
				if (!result) return;
				const projectValue = projectRef.current;
				if (!projectValue) return;
				const fps = Math.max(1, Number(projectValue.fps) || 30);
				let selectedClip = null;
				if (typeof result.mediaId === 'string') {
					for (const row of allClips(projectValue)) {
						if (row.clip.mediaId === result.mediaId) {
							selectedClip = row.clip;
							setSelectedClipIds([row.clip.id]);
							break;
						}
					}
				}
				if (Number.isFinite(Number(result.startSeconds))) {
					seekToFrame(Math.round(Number(result.startSeconds) * fps));
				} else if (selectedClip) {
					seekToFrame(selectedClip.startFrame);
				}
			};
			const handleCreateCaptionsFromTranscript = async (transcript) => {
				const projectValue = projectRef.current;
				if (!projectValue) return;
				const operation = transcriptCaptionOperation(transcript, projectValue);
				if (operation === null) {
					showNotice(t('transcribe.emptyTranscript'));
					return;
				}
				const payload = await runEdit([operation], { selectNew: (clip) => clip.type === 'caption' });
				if (payload) showNotice(t('transcribe.captionsCreated', { name: transcript && transcript.mediaName ? transcript.mediaName : '' }));
			};
			const handleImportCaptions = async (content) => {
				const previous = projectRef.current;
				const payload = await perform(() =>
					hostRequest('captions/import', { method: 'POST', body: { text: content } }),
				);
				if (payload) {
					const created = nextClipIdAfter(previous, payload.project, (clip) => clip.type === 'caption');
					if (created) setSelectedClipIds([created]);
					showNotice(t('status.captionsImported'));
				}
			};
			const handleExportCaptions = async (format) => {
				try {
					const response = await fetch(`${ROUTE}/captions/export.${format}`, { method: 'GET' });
					if (!response.ok) {
						let detail = null;
						try {
							detail = await response.json();
						} catch (error) {
							detail = null;
						}
						throw new HostRequestError(
							detail && detail.error && detail.error.message ? detail.error.message : `HTTP ${response.status}`,
							'captions-export',
							response.status,
						);
					}
					const text = await response.text();
					const projectValue = projectRef.current;
					const base = projectValue ? slugify(projectValue.name) : 'opentake-studio';
					downloadTextFile(`${base}.${format}`, text);
					showNotice(t('status.captionsExported'));
				} catch (error) {
					setActionError(t('error.captions', { message: error && error.message ? error.message : String(error) }));
				}
			};
			const handleAddMarker = async () => {
				const payload = await runEdit([
					{
						type: 'add-marker',
						marker: {
							id: newId(),
							frame: Math.round(currentFrameRef.current),
							label: t('inspector.markersDefaultLabel'),
							color: '#f5b301',
						},
					},
				]);
				if (payload) showNotice(t('status.markerAdded'));
			};
			const handleUpdateMarker = (markerId, patch) => {
				void runEdit([{ type: 'update-marker', markerId, ...patch }]);
			};
			const handleRemoveMarker = async (markerId) => {
				const payload = await runEdit([{ type: 'remove-marker', markerId }]);
				if (payload) showNotice(t('status.markerRemoved'));
			};

			const queuePropertyChange = (patch) => {
				const clip = findClipEntry(projectRef.current, primaryClipIdRef.current);
				if (!clip) return;
				setInspectorDraft((previous) => mergeDraft(previous, patch));
				const pending = pendingRef.current || { clipId: clip.clip.id, properties: {}, text: {} };
				if (patch.volume !== undefined) pending.properties.volume = clamp01(finiteNumber(patch.volume, 1));
				if (patch.opacity !== undefined) pending.properties.opacity = clamp01(finiteNumber(patch.opacity, 1));
				if (patch.transform !== undefined) {
					pending.properties.transform = Object.assign({}, pending.properties.transform, patch.transform);
				}
				pendingRef.current = pending;
				if (pendingTimerRef.current !== null) clearTimeout(pendingTimerRef.current);
				pendingTimerRef.current = setTimeout(() => {
					pendingTimerRef.current = null;
					flushInspector();
				}, INSPECTOR_COMMIT_DELAY);
			};

			const queueTextChange = (patch) => {
				const entry = findClipEntry(projectRef.current, primaryClipIdRef.current);
				if (!entry || entry.clip.type !== 'text') return;
				setInspectorDraft((previous) => mergeDraft(previous, patch));
				const pending = pendingRef.current || { clipId: entry.clip.id, properties: {}, text: {} };
				pending.text = Object.assign({}, pending.text, patch);
				pendingRef.current = pending;
				if (pendingTimerRef.current !== null) clearTimeout(pendingTimerRef.current);
				pendingTimerRef.current = setTimeout(() => {
					pendingTimerRef.current = null;
					flushInspector();
				}, INSPECTOR_COMMIT_DELAY);
			};

			const flushInspector = () => {
				if (pendingTimerRef.current !== null) {
					clearTimeout(pendingTimerRef.current);
					pendingTimerRef.current = null;
				}
				const pending = pendingRef.current;
				pendingRef.current = null;
				if (!pending) return null;
				const operations = [];
				const properties = pending.properties || {};
				if (properties.volume !== undefined || properties.opacity !== undefined || properties.transform !== undefined) {
					const operation = { type: 'set-clip-properties', clipIds: [pending.clipId] };
					if (properties.volume !== undefined) operation.volume = clamp01(finiteNumber(properties.volume, 1));
					if (properties.opacity !== undefined) operation.opacity = clamp01(finiteNumber(properties.opacity, 1));
					if (properties.transform !== undefined) {
						const transform = {};
						for (const key of Object.keys(properties.transform)) {
							if (key === 'rotation') transform.rotation = clamp(finiteNumber(properties.transform.rotation, 0), -360, 360);
							else transform[key] = clamp01(finiteNumber(properties.transform[key], 0));
						}
						operation.transform = transform;
					}
					operations.push(operation);
				}
				const text = pending.text || {};
				const textKeys = Object.keys(text);
				if (textKeys.length > 0) {
					const operation = { type: 'update-text', clipId: pending.clipId };
					for (const key of textKeys) {
						if (key === 'fontSize') operation.fontSize = Math.max(1, finiteNumber(text.fontSize, 48));
						else if (key === 'color') operation.color = String(text.color || '#ffffff');
						else if (key === 'fontWeight') operation.fontWeight = text.fontWeight === '400' || text.fontWeight === '700' ? text.fontWeight : '600';
						else if (key === 'align') operation.align = text.align === 'left' || text.align === 'right' ? text.align : 'center';
						else if (key === 'content') operation.content = String(text.content);
					}
					operations.push(operation);
				}
				if (operations.length === 0) return null;
				return runEdit(operations).then((payload) => {
					if (payload && primaryClipIdRef.current === pending.clipId && pendingRef.current === null) {
						const entry = findClipEntry(payload.project, pending.clipId);
						if (entry) setInspectorDraft(draftFromClip(entry.clip));
					}
				});
			};

			const handlePropertyChange = (patch) => queuePropertyChange(patch);
			const handlePropertyCommit = () => flushInspector();
			const handleTextChange = (patch) => queueTextChange(patch);
			const handleTextCommit = () => flushInspector();

			// Media element registry for hidden playback/decoding elements.
			const setMediaElement = (mediaId, kind) => (element) => {
				if (!element) {
					const existing = mediaElements.current[mediaId];
					if (existing) delete existing[kind];
					return;
				}
				const existing = mediaElements.current[mediaId] || {};
				existing[kind] = element;
				mediaElements.current[mediaId] = existing;
			};

			const handleDropFiles = async (files) => {
				if (!projectRef.current || files.length === 0) return;
				let uploaded = 0;
				setActionError(null);
				for (const file of files) {
					setUploading(t('media.uploading', { name: file.name }));
					try {
						const response = await fetch(`${ROUTE}/media/upload?name=${encodeURIComponent(file.name)}`, {
							method: 'POST',
							body: file,
							headers: { 'content-type': file.type || 'application/octet-stream' },
						});
						let payload = null;
						try {
							payload = await response.json();
						} catch (error) {
							payload = null;
						}
						if (!response.ok) {
							const message = payload && payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`;
							throw new HostRequestError(message, 'upload-error', response.status);
						}
						absorb(payload);
						uploaded += 1;
					} catch (error) {
						setActionError(messageFor(error));
					}
				}
				setUploading(null);
				if (uploaded > 0) showNotice(t('media.uploadDone', { count: uploaded }));
			};

			const browseDialog = async () => {
				const current = dialog;
				if (!current) return;
				try {
					const picked = pickDirectory ? await pickDirectory() : undefined;
					if (picked === undefined) {
						setDialog(Object.assign({}, current, { error: t('dialog.pickerUnavailable') }));
						return;
					}
					if (picked === null) return;
					const next = Object.assign({}, current, { error: null });
					if (current.mode === 'export') {
						next.path = joinPath(picked, suggestedExportName(projectRef.current, current.codec));
					} else {
						next.path = picked;
					}
					setDialog(next);
				} catch (error) {
					setDialog(Object.assign({}, current, { error: messageFor(error) }));
				}
			};

			const submitDialog = async () => {
				const current = dialog;
				if (!current || current.busy) return;
				const pathValue = String(current.path || '').trim();
				if (current.mode !== 'export' && pathValue.length === 0) {
					setDialog(Object.assign({}, current, { error: t('dialog.requiredPath') }));
					return;
				}
				if (current.mode === 'export' && pathValue.length > 0 && !/[\\/]/.test(pathValue)) {
					setDialog(Object.assign({}, current, { error: t('dialog.requiredOutput') }));
					return;
				}
				let exportSettings = null;
				if (current.mode === 'export') {
					exportSettings = effectiveExportSettings(projectRef.current, current);
					const rawWidth = Number(current.width);
					const rawHeight = Number(current.height);
					if (
						exportSettings.resolution === 'custom' &&
						(!Number.isInteger(rawWidth) || rawWidth < 2 || !Number.isInteger(rawHeight) || rawHeight < 2)
					) {
						setDialog(Object.assign({}, current, { error: t('export.invalidSize') }));
						return;
					}
					if (
						exportSettings.qualityMode === 'bitrate' &&
						(typeof current.bitrate !== 'string' || current.bitrate.trim().length === 0)
					) {
						setDialog(Object.assign({}, current, { error: t('export.invalidBitrate') }));
						return;
					}
				}
				const workingDialog = Object.assign({}, current, { busy: true, error: null, status: null });
				setDialog(workingDialog);
				try {
					let payload;
					if (current.mode === 'new') {
						payload = await hostPost('project/new', {
							path: pathValue,
							...(current.name && current.name.trim().length > 0 ? { name: current.name.trim() } : {}),
						});
					} else if (current.mode === 'open') {
						payload = await hostPost('project/open', { path: pathValue });
					} else if (current.mode === 'import') {
						payload = await hostPost('media/import', { path: pathValue });
					} else {
						await flushInspector();
						const exportProject = projectRef.current;
						if (countExportRenders(exportProject) > 0) {
							setDialog(Object.assign({}, workingDialog, { status: t('status.preparingText') }));
							await prepareExportRenders(exportProject, (kind, name, index, total) => {
								setDialog(
									Object.assign({}, workingDialog, {
										status: t(kind === 'motion' ? 'status.preparingMotion' : 'status.preparingLottie', {
											name,
											index,
											total,
										}),
									}),
								);
							});
							setDialog(Object.assign({}, workingDialog, { status: t('dialog.preparingText') }));
						}
						const exportBody = {
							...(pathValue.length > 0 ? { path: pathValue } : {}),
							overwrite: exportSettings.overwrite === true,
							codec: exportSettings.codec,
							transparent: exportSettings.transparent,
							bitDepth: exportSettings.bitDepth,
							width: exportSettings.width,
							height: exportSettings.height,
							fps: exportSettings.fps,
						};
						if (exportSettings.colorPrimaries !== undefined) exportBody.colorPrimaries = exportSettings.colorPrimaries;
						if (exportSettings.colorTrc !== undefined) exportBody.colorTrc = exportSettings.colorTrc;
						if (exportSettings.colorspace !== undefined) exportBody.colorspace = exportSettings.colorspace;
						if (exportSettings.qualityMode === 'crf') exportBody.crf = exportSettings.crf;
						else exportBody.bitrate = exportSettings.bitrate;
						payload = await hostPost('export', exportBody);
					}
					absorb(payload);
					setDialog(null);
					if (current.mode === 'import') {
						const imported = payload && Array.isArray(payload.imported) ? payload.imported.length : 0;
						const skipped = payload && Array.isArray(payload.skipped) ? payload.skipped.length : 0;
						showNotice(t('media.imported', { count: imported, skipped }));
					} else if (current.mode === 'export') {
						showNotice(t('status.exportStarted'));
					}
				} catch (error) {
					setDialog(Object.assign({}, current, { busy: false, error: messageFor(error) }));
				}
			};

			keyboardRef.current = {
				undo: handleUndo,
				redo: handleRedo,
				split: handleSplit,
				copy: handleCopy,
				paste: handlePaste,
				selectAll: handleSelectAll,
				play: togglePlay,
				stepBack: () => stepFrame(-1),
				stepForward: () => stepFrame(1),
				remove: handleDelete,
				ripple: handleDeleteRipple,
			};
			React.useEffect(() => {
				const onKeyDown = (event) => {
					const target = event.target;
					if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
						return;
					}
					const handlers = keyboardRef.current;
					if (!handlers) return;
					const meta = event.metaKey || event.ctrlKey;
					if (meta && (event.key === 'z' || event.key === 'Z')) {
						event.preventDefault();
						if (event.shiftKey) void handlers.redo();
						else void handlers.undo();
						return;
					}
					if (meta && (event.key === 'k' || event.key === 'K')) {
						event.preventDefault();
						void handlers.split();
						return;
					}
					if (meta && (event.key === 'c' || event.key === 'C')) {
						event.preventDefault();
						handlers.copy();
						return;
					}
					if (meta && (event.key === 'v' || event.key === 'V')) {
						event.preventDefault();
						void handlers.paste();
						return;
					}
					if (meta && (event.key === 'a' || event.key === 'A')) {
						event.preventDefault();
						handlers.selectAll();
						return;
					}
					if (event.key === 'ArrowLeft') {
						event.preventDefault();
						handlers.stepBack();
						return;
					}
					if (event.key === 'ArrowRight') {
						event.preventDefault();
						handlers.stepForward();
						return;
					}
					if (event.key === ' ') {
						event.preventDefault();
						handlers.play();
						return;
					}
					if (event.key === 'Delete' || event.key === 'Backspace') {
						if (selectedClipIdsRef.current.length > 0) {
							event.preventDefault();
							if (event.shiftKey) void handlers.ripple();
							else void handlers.remove();
						}
					}
				};
				window.addEventListener('keydown', onKeyDown);
				return () => window.removeEventListener('keydown', onKeyDown);
			}, []);

			const canSplit = (() => {
				if (!selected) return false;
				const frame = Math.round(currentFrame);
				return frame > selected.startFrame && frame < selected.startFrame + selected.durationFrames;
			})();

			const banners = [];
			if (actionError) {
				banners.push(h(Banner, { key: 'action', message: actionError, tone: 'error', onDismiss: () => setActionError(null), dismissLabel: t('error.dismiss') }));
			}
			if (pollError) {
				banners.push(h(Banner, { key: 'poll', message: pollError, tone: 'error', onDismiss: () => setPollError(null), dismissLabel: t('error.dismiss') }));
			}
			if (snapshot && snapshot.lastError && snapshot.lastError !== dismissed) {
				banners.push(
					h(Banner, {
						key: 'last',
						message: t('project.lastError', { message: snapshot.lastError }),
						tone: 'warn',
						onDismiss: () => setDismissed(snapshot.lastError),
						dismissLabel: t('error.dismiss'),
					}),
				);
			}
			if (snapshot && snapshot.saveError) {
				banners.push(
					h(Banner, {
						key: 'save',
						message: t('project.saveError', { message: snapshot.saveError }),
						tone: 'warn',
					}),
				);
			}
			if (notice) {
				banners.push(h(Banner, { key: 'notice', message: notice, tone: 'info', onDismiss: () => setNotice(null), dismissLabel: t('error.dismiss') }));
			}

			const dialogTitle = dialog
				? dialog.mode === 'new'
					? t('dialog.newTitle')
					: dialog.mode === 'open'
						? t('dialog.openTitle')
						: dialog.mode === 'import'
							? t('dialog.importTitle')
							: t('dialog.exportTitle')
				: '';

			const emptyFrame = project ? activeVisualClipsAt(project, currentFrame).length === 0 : false;

			return h(
				'div',
				{ className: 'ots-root' },
				h(TopBar, {
					t,
					snapshot,
					project,
					projectRoot,
					busy,
					onNew: handleNew,
					onOpen: handleOpen,
					onSave: handleSave,
					onUndo: handleUndo,
					onRedo: handleRedo,
					onExport: handleExport,
					onCancelExport: handleCancelExport,
					proxyPreview,
					onToggleProxyPreview: toggleProxyPreview,
				}),
				banners.length > 0 ? h('div', { className: 'ots-banners' }, banners) : null,
				initializing && !snapshot
					? h(
							'div',
							{ className: 'ots-loading', role: 'status', 'aria-live': 'polite' },
							h('div', { className: 'ots-spinner' }),
							h('span', {}, t('welcome.loading')),
						)
					: !project
						? h(Welcome, {
								t,
								snapshot,
								onNew: handleNew,
								onOpen: handleOpen,
								recentProjects,
								recentLoading,
								recentError,
								onOpenRecent: handleOpenRecent,
								onClearRecent: handleClearRecent,
								onRefreshRecent: refreshRecentProjects,
							})
						: h(
								ReactFragment,
								null,
								h(
									'div',
									{ className: 'ots-body' },
									h(MediaLibrary, {
										t,
										project,
										importing,
										uploading,
										ffmpegAvailable: Boolean(snapshot && snapshot.ffmpeg && snapshot.ffmpeg.available),
										pickDirectory,
										onLibraryState: absorb,
										showNotice,
										asr: snapshot ? snapshot.asr : null,
										generation: snapshot ? snapshot.generation : null,
										onOpenSearchResult: handleOpenSearchResult,
										onCreateCaptionsFromTranscript: handleCreateCaptionsFromTranscript,
										missingMediaIds,
										onMediaRelinked: handleMediaRelinked,
										onImport: handleImport,
										onAddMedia: handleAddMedia,
										onDropFiles: handleDropFiles,
									}),
									h(PreviewPanel, {
										t,
										project,
										playing,
										currentFrame,
										duration,
										loop,
										monitorVolume,
										canvasRef,
										stageRef,
										canvasSize: canvasWidth,
										emptyFrame,
										onTogglePlay: togglePlay,
										onToggleLoop: () => setLoop((value) => !value),
										onVolumeChange: (value) => setMonitorVolume(clamp01(value)),
										onStepFrame: stepFrame,
										onExportFrame: handleExportFrame,
										proxyPreview,
										missingMediaIds,
									}),
									h(Inspector, {
										t,
										project,
										projectRoot,
										snapshot,
										selected: selectedEntry,
										draft: inspectorDraft,
										currentFrame,
										selectedCount: selectedClipIds.length,
										onPropertyChange: handlePropertyChange,
										onPropertyCommit: handlePropertyCommit,
										onTextChange: handleTextChange,
										onTextCommit: handleTextCommit,
										onAddText: handleAddText,
										onSpeedChange: handleSetSpeed,
										onFadeChange: handleSetFades,
										onSetCrop: handleSetCrop,
										onSetMask: handleSetMask,
										onSetBlendMode: handleSetBlendMode,
										onUpdateMotion: handleUpdateMotion,
										onSetMotionDuration: handleSetMotionDuration,
										onSetKeyframes: handleSetKeyframes,
										onAddEffect: handleAddEffect,
										onUpdateEffect: handleUpdateEffect,
										onRemoveEffect: handleRemoveEffect,
										onReorderEffects: handleReorderEffects,
										onAddTransition: handleAddTransition,
										onUpdateTransition: handleUpdateTransition,
										onRemoveTransition: handleRemoveTransition,
										onAddCaption: handleAddCaption,
										onUpdateCaption: handleUpdateCaption,
										onImportCaption: handleImportCaptions,
										onExportCaption: handleExportCaptions,
										onAddMarker: handleAddMarker,
										onUpdateMarker: handleUpdateMarker,
										onRemoveMarker: handleRemoveMarker,
										onSeek: seekToFrame,
										missingMediaIds,
									}),
								),
								h(
									'div',
									{ className: 'ots-media-cache', 'aria-hidden': 'true' },
									project.media.flatMap((media) => {
										const nodes = [];
										if (media.kind === 'video') {
											const useProxy = proxyPreview && !proxyFailedIds.has(media.id);
											nodes.push(
												h('video', {
													key: `${media.id}-video-${useProxy ? 'proxy' : 'original'}-${media.fileName || ''}`,
													ref: setMediaElement(media.id, 'video'),
													src: useProxy ? mediaProxyUrl(media.id) : mediaFileUrl(media.id),
													muted: true,
													playsInline: true,
													preload: 'auto',
													onLoadedMetadata: () => refreshFrameRef.current && refreshFrameRef.current(),
													onLoadedData: () => refreshFrameRef.current && refreshFrameRef.current(),
													onCanPlay: () => refreshFrameRef.current && refreshFrameRef.current(),
													onSeeked: () => scheduleDrawRef.current && scheduleDrawRef.current(),
													onError: () => {
														if (useProxy) handleProxyVideoError(media);
														else markMediaMissing(media);
													},
												}),
											);
										}
										if (media.kind === 'audio' || (media.kind === 'video' && media.hasAudio)) {
											nodes.push(
												h('audio', {
													key: `${media.id}-audio-${media.fileName || ''}`,
													ref: setMediaElement(media.id, 'audio'),
													src: mediaFileUrl(media.id),
													preload: 'auto',
													onError: () => markMediaMissing(media),
												}),
											);
										}
										if (media.kind === 'image') {
											nodes.push(
												h('img', {
													key: `${media.id}-image-${media.fileName || ''}`,
													ref: setMediaElement(media.id, 'image'),
													src: mediaFileUrl(media.id),
													alt: '',
													onLoad: () => scheduleDrawRef.current && scheduleDrawRef.current(),
													onError: () => markMediaMissing(media),
												}),
											);
										}
										return nodes;
									}),
								),
								h(Timeline, {
									t,
									project,
									zoom,
									currentFrame,
									playing,
									selectedClipIds,
									onSelectClip: handleSelectClip,
									onSeek: seekToFrame,
									onMoveClip: handleMoveClip,
									onTrimClip: handleTrimClip,
									onDropMedia: handleDropMedia,
									onSetZoom: (value) => setZoom(clamp(value, MIN_ZOOM, MAX_ZOOM)),
									onSplit: handleSplit,
									onDelete: handleDelete,
									onDeleteRipple: handleDeleteRipple,
									onCopy: handleCopy,
									onPaste: handlePaste,
									canSplit,
									canDelete: selectedClipIds.length > 0,
									canCopy: selectedClipIds.length > 0,
									canPaste: hasClipboard,
									snapping,
									onToggleSnapping: () => setSnapping((value) => !value),
									onAddMarker: handleAddMarker,
									onAddTrack: handleAddTrack,
									onAddText: handleAddText,
									onAddMotion: handleOpenMotionDialog,
									onUpdateTrack: handleUpdateTrack,
									onRemoveTrack: handleRemoveTrack,
									missingMediaIds,
								}),
							),
				dialog
					? h(Dialog, {
							t,
							dialog,
							project,
							title: dialogTitle,
							onPatch: (patch) => setDialog((current) => (current ? Object.assign({}, current, patch) : current)),
							onBrowse: browseDialog,
							recentProjects,
							recentLoading,
							recentError,
							onOpenRecent: handleOpenRecent,
							onClearRecent: handleClearRecent,
							onRefreshRecent: refreshRecentProjects,
							onSubmit: submitDialog,
							onClose: () => setDialog(null),
						})
					: null,
				motionDialog
					? h(MotionDialog, {
							t,
							dialog: motionDialog,
							onChange: (patch) => setMotionDialog((current) => (current ? Object.assign({}, current, patch) : current)),
							onClose: () => setMotionDialog(null),
							onSubmit: submitMotionDialog,
						})
					: null,
			);
		}

		function EditorPageBound(props) {
			return h(EditorPage, Object.assign({}, props, { pickDirectory: directoryPicker }));
		}

		let directoryPicker = null;

		function SettingsSectionBound(props) {
			return h(SettingsSection, props);
		}

		// -------------------------------------------------------------------
		// Registration
		// -------------------------------------------------------------------

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(
				() =>
					ctx.locale.register(NS, {
						en,
						zh,
					}),
				'opentake-studio: dictionaries',
			);
			ctx.effect(() => {
				if (typeof document === 'undefined' || !document.head) return () => {};
				const tag = document.createElement('style');
				tag.dataset.plugin = '@opentake/studio';
				tag.dataset.pluginCss = NS;
				tag.textContent = STYLES;
				document.head.appendChild(tag);
				return () => {
					if (tag.parentNode) tag.parentNode.removeChild(tag);
				};
			}, 'opentake-studio: styles');
			directoryPicker = async () => {
				// Desktop exposes the native picker directly; the web/profile UI
				// service is the fallback. Both may be absent in a headless page,
				// in which case the dialog keeps its absolute-path input.
				try {
					const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
					if (desktop !== undefined && typeof desktop.pick === 'function') {
						const picked = await desktop.pick();
						return typeof picked === 'string' && picked.length > 0 ? picked : null;
					}
				} catch (error) {
					// fall through to the service
				}
				let service = null;
				try {
					service = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null;
				} catch (error) {
					service = null;
				}
				if (!service || typeof service.pickDirectory !== 'function') return undefined;
				const picked = await service.pickDirectory();
				return typeof picked === 'string' && picked.length > 0 ? picked : null;
			};
			ctx.slots.inject('main', () =>
				ctx.slots.register(
					{
						name: 'main',
						key: PANEL_ID,
						locale: NS,
					},
					EditorPageBound,
				),
			);
			ctx.slots.inject('sidebar.panellist', () =>
				ctx.slots.register(
					{
						name: 'sidebar.panellist',
						id: PANEL_ID,
						order: 15,
						locale: NS,
						label: () => t('panel'),
					},
					Glyph,
				),
			);
			ctx.slots.inject('settings.section', () =>
				ctx.slots.register(
					{
						name: 'settings.section',
						id: PANEL_ID,
						order: 25,
						locale: NS,
						label: () => t('settings.nav'),
					},
					SettingsSectionBound,
				),
			);
		}

		const inject = ['slots', 'locale'];

		return { inject, apply };
	},
});
