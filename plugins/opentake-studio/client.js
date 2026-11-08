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
				if (track.hidden) continue;
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

		function mediaThumbUrl(mediaId) {
			return `${ROUTE}/media/thumb/${encodeURIComponent(mediaId)}`;
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

		function suggestedExportName(project) {
			const base = slugify(project && project.name ? project.name : 'opentake-studio');
			return `${base}-${Date.now()}.mp4`;
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

		function activeVisualClipsAt(project, frame) {
			return activeClipsAt(project, frame).filter(({ clip }) => clip.type !== 'audio');
		}

		function clipDisplayLabel(project, clip, fallback) {
			if (clip.type === 'text') {
				const content = clip.text && typeof clip.text.content === 'string' ? clip.text.content : '';
				const firstLine = content.split('\n')[0].trim();
				return firstLine.length > 0 ? firstLine : fallback;
			}
			const media = findMedia(project, clip.mediaId);
			return media ? media.name : fallback;
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

		function renderTextClipToDataUrl(clip, project) {
			if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
				throw new Error('Canvas is unavailable in this browser');
			}
			const box = transformBox(clip.transform, project.width, project.height);
			const width = Math.max(1, Math.round(box.width));
			const height = Math.max(1, Math.round(box.height));
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext ? canvas.getContext('2d') : null;
			if (!context) throw new Error('A 2D canvas context is unavailable');
			const text = clip.text || {};
			const fontSize = Math.max(1, finiteNumber(text.fontSize, 48));
			const weight = text.fontWeight === '400' || text.fontWeight === '700' ? text.fontWeight : '600';
			const align = text.align === 'left' || text.align === 'right' ? text.align : 'center';
			context.clearRect(0, 0, width, height);
			context.fillStyle = typeof text.color === 'string' && text.color.length > 0 ? text.color : '#ffffff';
			context.font = `${weight} ${fontSize}px -apple-system, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif`;
			context.textAlign = align;
			context.textBaseline = 'top';
			const lines = wrapTextLines(context, text.content || '', Math.max(1, width - 4));
			const lineHeight = fontSize * 1.2;
			const totalHeight = lines.length * lineHeight;
			const x = align === 'left' ? 2 : align === 'right' ? width - 2 : width / 2;
			let y = Math.max(0, (height - totalHeight) / 2);
			for (const line of lines) {
				if (line.length > 0) context.fillText(line, x, y);
				y += lineHeight;
			}
			if (typeof canvas.toDataURL !== 'function') throw new Error('Canvas export is unavailable');
			return canvas.toDataURL('image/png');
		}

		function collectTextClips(project) {
			const seen = new Set();
			const rows = [];
			if (!project) return rows;
			for (const track of project.tracks) {
				for (const clip of track.clips) {
					if (clip.type !== 'text' || seen.has(clip.id)) continue;
					seen.add(clip.id);
					rows.push(clip);
				}
			}
			return rows;
		}

		async function prepareTextRenders(project, clips) {
			for (const clip of clips) {
				const dataUrl = renderTextClipToDataUrl(clip, project);
				await hostRequest('text/render', { method: 'POST', body: { clipId: clip.id, dataUrl } });
			}
		}

		function drawComposite(context, project, frame, mediaElements) {
			const width = project.width;
			const height = project.height;
			context.save();
			context.setTransform(1, 0, 0, 1, 0, 0);
			context.globalAlpha = 1;
			context.fillStyle = '#000000';
			context.fillRect(0, 0, width, height);
			for (const track of project.tracks) {
				if (track.hidden || track.type !== 'video') continue;
				for (const clip of track.clips) {
					if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
					const opacity = clamp01(finiteNumber(clip.opacity, 1));
					if (opacity <= 0) continue;
					const media = clip.mediaId ? findMedia(project, clip.mediaId) : null;
					const elements = clip.mediaId ? mediaElements[clip.mediaId] : null;
					const box = transformBox(clip.transform, width, height);
					context.save();
					context.globalAlpha = opacity;
					context.translate(box.x + box.width / 2, box.y + box.height / 2);
					if (box.rotation !== 0) context.rotate((box.rotation * Math.PI) / 180);
					if (clip.type === 'text') {
						drawTextClip(context, clip, box);
					} else if (clip.type === 'video' && elements && elements.video) {
						const video = elements.video;
						if (video.readyState >= 2 && video.videoWidth > 0) {
							context.drawImage(video, -box.width / 2, -box.height / 2, box.width, box.height);
						}
					} else if (clip.type === 'image' && elements && elements.image) {
						const image = elements.image;
						if (image.complete && image.naturalWidth > 0) {
							context.drawImage(image, -box.width / 2, -box.height / 2, box.width, box.height);
						}
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
.ots-media-add{background:var(--dsw-alias-bg-overlay);border:0;border-radius:5px;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:14px;height:22px;line-height:1;opacity:0;position:absolute;right:4px;top:4px;width:22px;transition:opacity .12s}
.ots-media-card:hover .ots-media-add,.ots-media-add:focus-visible{opacity:1}
.ots-media-empty{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;padding:18px 10px;text-align:center}
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
.ots-track{display:flex;height:52px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.ots-track:last-child{border-bottom:0}
.ots-track-head{background:var(--dsw-alias-bg-layer-1);border-right:.5px solid var(--dsw-alias-border-l2);display:flex;flex:0 0 132px;flex-direction:column;justify-content:center;gap:1px;min-width:0;padding:0 8px;position:sticky;left:0;z-index:3}
.ots-track-name{color:var(--dsw-alias-label-secondary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ots-track-kind{color:var(--dsw-alias-label-secondary);font-size:10px;letter-spacing:.25px;text-transform:uppercase}
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
			'status.textAdded': 'Text clip added.',
			'status.clipAdded': 'Clip added to the timeline.',
			'status.loading': 'Loading…',
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
			'status.textAdded': '已添加文本片段。',
			'status.clipAdded': '已把片段添加到时间线。',
			'status.loading': '加载中…',
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

		function MediaThumb(props) {
			const [failed, setFailed] = React.useState(false);
			const media = props.media;
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
			const { t, snapshot, project, projectRoot, busy, onNew, onOpen, onSave, onUndo, onRedo, onExport, onCancelExport } = props;
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

		function Welcome(props) {
			const { t, snapshot, onNew, onOpen } = props;
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
				),
			);
		}

		// -------------------------------------------------------------------
		// Media library
		// -------------------------------------------------------------------

		function MediaLibrary(props) {
			const { t, project, onImport, onAddMedia, onDropFiles, importing, uploading, ffmpegAvailable } = props;
			const media = project ? project.media : [];
			const fps = project ? project.fps : 30;
			const handleDrop = (event) => {
				event.preventDefault();
				if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
					onDropFiles(event.dataTransfer.files);
				}
			};
			return h(
				'aside',
				{ className: 'ots-panel ots-media', 'aria-label': t('media.title') },
				h(
					'div',
					{ className: 'ots-panel-head' },
					h('span', { className: 'ots-panel-title' }, t('media.title')),
					importing ? h('span', { className: 'ots-panel-sub', role: 'status' }, t('media.importing')) : null,
					h(
						Btn,
						{
							variant: 'outline',
							onClick: onImport,
							disabled: importing || !ffmpegAvailable,
							title: ffmpegAvailable ? t('media.import') : t('ffmpeg.missingTitle'),
						},
						t('media.import'),
					),
				),
				h(
					'div',
					{
						className: 'ots-panel-body',
						onDragOver: (event) => {
							event.preventDefault();
						},
						onDrop: handleDrop,
					},
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
									),
								),
							),
					uploading ? h('div', { className: 'ots-panel-sub', role: 'status' }, uploading) : null,
				),
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
			} = props;
			const fps = project ? project.fps : 30;
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
					),
				),
				h(
					'div',
					{ className: 'ots-preview-controls', 'aria-label': t('preview.controls') },
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
							active: loop,
							onClick: onToggleLoop,
							title: t('preview.loop'),
							'aria-pressed': loop ? 'true' : 'false',
						},
						t('preview.loop'),
					),
					h('span', { className: 'ots-timecode' }, `${formatTimecode(currentFrame, fps)} / ${formatTimecode(duration, fps)}`),
					h('span', { className: 'ots-frame-count' }, `${Math.round(currentFrame)} / ${Math.round(duration)}`),
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

		function Inspector(props) {
			const {
				t,
				project,
				projectRoot,
				snapshot,
				selected,
				draft,
				onPropertyChange,
				onPropertyCommit,
				onTextChange,
				onTextCommit,
				onAddText,
			} = props;
			const title = selected ? t(`inspector.kind${selected.clip.type.charAt(0).toUpperCase()}${selected.clip.type.slice(1)}`) : t('inspector.project');
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
						{ className: 'ots-section', key: 'shortcuts' },
						h('h3', { className: 'ots-section-title' }, t('inspector.shortcuts')),
						h(Shortcut, { t, shortcutKey: 'Space', label: t('inspector.shortcutPlay') }),
						h(Shortcut, { t, shortcutKey: 'Del', label: t('inspector.shortcutDelete') }),
						h(Shortcut, { t, shortcutKey: '⌘Z', label: t('inspector.shortcutUndo') }),
						h(Shortcut, { t, shortcutKey: '⇧⌘Z', label: t('inspector.shortcutRedo') }),
						h(Shortcut, { t, shortcutKey: '⌘K', label: t('inspector.shortcutSplit') }),
					),
				);
			} else {
				const clip = selected.clip;
				const media = findMedia(project, clip.mediaId);
				const fps = project.fps;
				const isText = clip.type === 'text';
				const isAudio = clip.type === 'audio';
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
						h('p', { className: 'ots-hint' }, t('inspector.readonly')),
					),
				);
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
								step: 1,
								onChange: (value) => onPropertyChange({ transform: { rotation: value } }),
								onBlur: onPropertyCommit,
							}),
							h('p', { className: 'ots-field-hint' }, t('inspector.normalized')),
						),
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
			return h(
				'aside',
				{ className: 'ots-panel ots-inspector', 'aria-label': t('inspector.title') },
				h('div', { className: 'ots-panel-head' }, h('span', { className: 'ots-panel-title' }, t('inspector.title'))),
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

		function Timeline(props) {
			const {
				t,
				project,
				zoom,
				currentFrame,
				playing,
				selectedClipId,
				onSelectClip,
				onSeek,
				onMoveClip,
				onTrimClip,
				onDropMedia,
				onSetZoom,
				onSplit,
				onDelete,
				canSplit,
				canDelete,
				onAddTrack,
				onAddText,
			} = props;
			const scrollRef = React.useRef(null);
			const rowRefs = React.useRef({});
			const dragRef = React.useRef(null);
			const [dragState, setDragState] = React.useState(null);
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

			const beginClipDrag = (event, track, clip) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				onSelectClip(clip.id);
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
						startFrame: Math.max(0, current.clip.startFrame + delta),
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
				onSelectClip(clip.id);
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
						current.preview = Object.assign({}, current.preview, {
							durationFrames: clamp(clipValue.durationFrames + delta, 1, maxDuration),
						});
					} else {
						const media = findMedia(project, clipValue.mediaId);
						const trimLimit = media && media.durationFrames !== null && clipValue.type !== 'text' ? clipValue.trimStartFrame : 0;
						const minDelta = Math.max(-trimLimit, previousEnd(clipValue, current.siblings) - clipValue.startFrame, -clipValue.startFrame);
						const maxDelta = clipValue.durationFrames - 1;
						const applied = clamp(delta, minDelta, maxDelta);
						current.preview = Object.assign({}, current.preview, {
							startFrame: clipValue.startFrame + applied,
							durationFrames: clipValue.durationFrames - applied,
							trimStartFrame: clipValue.type === 'video' || clipValue.type === 'audio' ? clipValue.trimStartFrame + applied : clipValue.trimStartFrame,
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
				onDropMedia(mediaId, track ? track.id : null, frameFromClientX(event.clientX));
			};

			const renderClip = (track, clip, preview) => {
				const startFrame = preview ? preview.startFrame : clip.startFrame;
				const durationFrames = preview ? preview.durationFrames : clip.durationFrames;
				const width = Math.max(2, Math.round(durationFrames * zoom));
				const label = clipDisplayLabel(project, clip, t('inspector.clip'));
				const selected = clip.id === selectedClipId;
				return h(
					'div',
					{
						key: clip.id,
						className: 'ots-clip',
						'data-kind': clip.type,
						'data-selected': selected ? 'true' : 'false',
						'data-dragging': dragState && dragState.clip.id === clip.id ? 'true' : 'false',
						style: { left: Math.round(startFrame * zoom), width },
						title: `${label} · ${formatTimecode(startFrame, fps)} – ${formatTimecode(startFrame + durationFrames, fps)}`,
						'aria-label': label,
						tabIndex: 0,
						onPointerDown: (event) => beginClipDrag(event, track, clip),
						onKeyDown: (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								onSelectClip(clip.id);
							}
						},
					},
					width > 28 ? h('span', { className: 'ots-clip-label' }, label) : null,
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
					},
					h(
						'div',
						{ className: 'ots-track-head' },
						h('span', { className: 'ots-track-name', title: track.name }, track.name || t(track.type === 'audio' ? 'timeline.audioTrack' : 'timeline.videoTrack')),
						h('span', { className: 'ots-track-kind' }, `${t(track.type === 'audio' ? 'timeline.audioTrack' : 'timeline.videoTrack')} · ${t('timeline.clipCount', { count: track.clips.length })}`),
					),
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
					{ className: 'ots-timeline-scroll', ref: scrollRef },
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

		function Dialog(props) {
			const { t, dialog, onPathChange, onNameChange, onBrowse, onSubmit, onClose, title } = props;
			const isExport = dialog.mode === 'export';
			const isNew = dialog.mode === 'new';
			const busy = Boolean(dialog.busy);
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
						h(
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
									onChange: (event) => onPathChange(event.target.value),
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
						),
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
										onChange: (event) => onNameChange(event.target.value),
										onKeyDown: (event) => {
											if (event.key === 'Enter') {
												event.preventDefault();
												onSubmit();
											}
										},
									}),
								)
							: null,
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
			const [selectedClipId, setSelectedClipId] = React.useState(null);
			const [currentFrame, setCurrentFrame] = React.useState(0);
			const [playing, setPlaying] = React.useState(false);
			const [loop, setLoop] = React.useState(false);
			const [monitorVolume, setMonitorVolume] = React.useState(1);
			const [zoom, setZoom] = React.useState(DEFAULT_ZOOM);
			const [busy, setBusy] = React.useState(0);
			const [dialog, setDialog] = React.useState(null);
			const [importing, setImporting] = React.useState(false);
			const [uploading, setUploading] = React.useState(null);
			const [inspectorDraft, setInspectorDraft] = React.useState(null);
			const [dismissed, setDismissed] = React.useState(null);

			const snapshotRef = React.useRef(null);
			const projectRef = React.useRef(null);
			const selectedClipIdRef = React.useRef(null);
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

			snapshotRef.current = snapshot;
			selectedClipIdRef.current = selectedClipId;
			currentFrameRef.current = currentFrame;
			playingRef.current = playing;
			loopRef.current = loop;
			monitorVolumeRef.current = monitorVolume;
			zoomRef.current = zoom;
			const project = snapshot ? snapshot.project : null;
			projectRef.current = project;

			const fps = project ? project.fps : 30;
			const duration = project ? timelineDurationFrames(project) : 0;

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
				setSelectedClipId(null);
				setCurrentFrame(0);
				setPlaying(false);
				setInspectorDraft(null);
				draftKeyRef.current = null;
				clockRef.current.frame = 0;
				currentFrameRef.current = 0;
				pendingRef.current = null;
			}, [projectRoot]);

			const selectedEntry = project ? findClipEntry(project, selectedClipId) : null;
			const selected = selectedEntry ? selectedEntry.clip : null;

			React.useEffect(() => {
				if (selectedClipId && project && !findClipEntry(project, selectedClipId)) {
					setSelectedClipId(null);
					setInspectorDraft(null);
				}
			}, [project, selectedClipId]);

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
				const audioByMedia = new Map();
				const videoByMedia = new Map();
				for (const row of active) {
					const clip = row.clip;
					const media = findMedia(currentProject, clip.mediaId);
					if (!media) continue;
					if (clip.type === 'audio' || (clip.type === 'video' && media.hasAudio)) {
						if (!audioByMedia.has(media.id)) audioByMedia.set(media.id, clip);
					}
					if (clip.type === 'video' && !videoByMedia.has(media.id)) videoByMedia.set(media.id, clip);
				}
				const rate = currentProject.fps;
				for (const media of currentProject.media) {
					const elements = mediaElements.current[media.id];
					if (!elements) continue;
					const audioClip = audioByMedia.get(media.id);
					if (elements.audio) {
						const audio = elements.audio;
						if (audioClip) {
							const desired = (audioClip.trimStartFrame + (frame - audioClip.startFrame)) / rate;
							const volume = clamp01(finiteNumber(audioClip.volume, 1) * monitorVolumeRef.current);
							audio.volume = volume;
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
							const desired = (videoClip.trimStartFrame + (frame - videoClip.startFrame)) / rate;
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
			refreshFrameRef.current = () => {
				applyFrame(currentFrameRef.current);
			};

			React.useEffect(() => {
				if (!playing) {
					applyFrame(currentFrameRef.current);
				}
			}, [snapshot && snapshot.project, currentFrame, playing]);

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
					if (created) setSelectedClipId(created);
				}
				return payload;
			};

			const handleNew = () => setDialog({ mode: 'new', path: '', name: '', error: null, busy: false });
			const handleOpen = () => setDialog({ mode: 'open', path: projectRoot || '', name: '', error: null, busy: false });
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
				if (!projectRef.current) return;
				const suggested = suggestedExportName(projectRef.current);
				setDialog({ mode: 'export', path: '', name: suggested, error: null, busy: false });
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
			const handleAddText = async () => {
				if (!projectRef.current) return;
				const startFrame = Math.round(currentFrameRef.current);
				const payload = await runEdit(
					[
						{
							type: 'add-text',
							content: t('inspector.defaultText'),
							startFrame,
							durationFrames: Math.max(1, Math.round(fps * 3)),
						},
					],
					{ selectNew: (clip) => clip.type === 'text' },
				);
				if (payload) showNotice(t('status.textAdded'));
			};
			const handleSplit = async () => {
				const entry = findClipEntry(projectRef.current, selectedClipIdRef.current);
				if (!entry) return;
				const frame = Math.round(currentFrameRef.current);
				const clip = entry.clip;
				if (frame <= clip.startFrame || frame >= clip.startFrame + clip.durationFrames) return;
				const payload = await runEdit([{ type: 'split-clip', clipId: clip.id, atFrame: frame }], { selectNew: true });
				if (payload) showNotice(t('status.split'));
			};
			const handleDelete = async () => {
				const clipId = selectedClipIdRef.current;
				if (!clipId) return;
				setSelectedClipId(null);
				setInspectorDraft(null);
				const payload = await runEdit([{ type: 'remove-clips', clipIds: [clipId] }]);
				if (payload) showNotice(t('status.deleted'));
			};

			const queuePropertyChange = (patch) => {
				const clip = findClipEntry(projectRef.current, selectedClipIdRef.current);
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
				const entry = findClipEntry(projectRef.current, selectedClipIdRef.current);
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
							if (key === 'rotation') transform.rotation = finiteNumber(properties.transform.rotation, 0);
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
					if (payload && selectedClipIdRef.current === pending.clipId && pendingRef.current === null) {
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
						next.path = joinPath(picked, current.name || suggestedExportName(projectRef.current));
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
						const textClips = collectTextClips(exportProject);
						if (textClips.length > 0) {
							setDialog(Object.assign({}, workingDialog, { status: t('status.preparingText') }));
							await prepareTextRenders(exportProject, textClips);
							setDialog(Object.assign({}, workingDialog, { status: t('dialog.preparingText') }));
						}
						payload = await hostPost('export', pathValue.length > 0 ? { path: pathValue } : {});
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

			React.useEffect(() => {
				const onKeyDown = (event) => {
					const target = event.target;
					if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
						return;
					}
					const meta = event.metaKey || event.ctrlKey;
					if (meta && (event.key === 'z' || event.key === 'Z')) {
						event.preventDefault();
						if (event.shiftKey) void handleRedo();
						else void handleUndo();
						return;
					}
					if (meta && (event.key === 'k' || event.key === 'K')) {
						event.preventDefault();
						void handleSplit();
						return;
					}
					if (event.key === ' ') {
						event.preventDefault();
						togglePlay();
						return;
					}
					if (event.key === 'Delete' || event.key === 'Backspace') {
						if (selectedClipIdRef.current) {
							event.preventDefault();
							void handleDelete();
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
						? h(Welcome, { t, snapshot, onNew: handleNew, onOpen: handleOpen })
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
									}),
									h(Inspector, {
										t,
										project,
										projectRoot,
										snapshot,
										selected: selectedEntry,
										draft: inspectorDraft,
										onPropertyChange: handlePropertyChange,
										onPropertyCommit: handlePropertyCommit,
										onTextChange: handleTextChange,
										onTextCommit: handleTextCommit,
										onAddText: handleAddText,
									}),
								),
								h(
									'div',
									{ className: 'ots-media-cache', 'aria-hidden': 'true' },
									project.media.flatMap((media) => {
										const nodes = [];
										if (media.kind === 'video') {
											nodes.push(
												h('video', {
													key: `${media.id}-video`,
													ref: setMediaElement(media.id, 'video'),
													src: mediaFileUrl(media.id),
													muted: true,
													playsInline: true,
													preload: 'auto',
													onLoadedMetadata: () => refreshFrameRef.current && refreshFrameRef.current(),
													onLoadedData: () => refreshFrameRef.current && refreshFrameRef.current(),
													onCanPlay: () => refreshFrameRef.current && refreshFrameRef.current(),
													onSeeked: () => scheduleDrawRef.current && scheduleDrawRef.current(),
												}),
											);
										}
										if (media.kind === 'audio' || (media.kind === 'video' && media.hasAudio)) {
											nodes.push(
												h('audio', {
													key: `${media.id}-audio`,
													ref: setMediaElement(media.id, 'audio'),
													src: mediaFileUrl(media.id),
													preload: 'auto',
												}),
											);
										}
										if (media.kind === 'image') {
											nodes.push(
												h('img', {
													key: `${media.id}-image`,
													ref: setMediaElement(media.id, 'image'),
													src: mediaFileUrl(media.id),
													alt: '',
													onLoad: () => scheduleDrawRef.current && scheduleDrawRef.current(),
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
									selectedClipId,
									onSelectClip: (id) => setSelectedClipId(id),
									onSeek: seekToFrame,
									onMoveClip: handleMoveClip,
									onTrimClip: handleTrimClip,
									onDropMedia: handleDropMedia,
									onSetZoom: (value) => setZoom(clamp(value, MIN_ZOOM, MAX_ZOOM)),
									onSplit: handleSplit,
									onDelete: handleDelete,
									canSplit,
									canDelete: Boolean(selected),
									onAddTrack: handleAddTrack,
									onAddText: handleAddText,
								}),
							),
				dialog
					? h(Dialog, {
							t,
							dialog,
							title: dialogTitle,
							onPathChange: (value) => setDialog((current) => (current ? Object.assign({}, current, { path: value }) : current)),
							onNameChange: (value) => setDialog((current) => (current ? Object.assign({}, current, { name: value }) : current)),
							onBrowse: browseDialog,
							onSubmit: submitDialog,
							onClose: () => setDialog(null),
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
