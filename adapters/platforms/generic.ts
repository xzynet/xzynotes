import type { SubtitleCue } from '../../core/models';
import {
  NoSubtitlesError,
  type PlatformAdapter,
  type PlatformCourseInfo,
} from './base';
import { captureVideoFrame } from './capture';

/**
 * 穿透 shadow DOM 与同源 iframe 找全部 <video>
 * （智慧树等平台把播放器封装在 shadow root 里，一些课程站把播放器放在同源 iframe 里，
 * document.querySelector('video') 只能找到占位/预览元素，导致播放状态误报）。
 * 跨 realm 元素 instanceof 判定会失效，统一用 tagName；跨域 iframe DOM 不可达，跳过。
 * 深度有界遍历，最多收集 8 个。
 */
export function queryAllVideosDeep(): HTMLVideoElement[] {
  const found: HTMLVideoElement[] = [];
  const walk = (root: Document | ShadowRoot, depth: number) => {
    if (depth > 6 || found.length >= 8) return;
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (found.length >= 8) return;
      if (el.tagName === 'VIDEO') found.push(el as HTMLVideoElement);
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      if (el.tagName === 'IFRAME') {
        try {
          const doc = (el as HTMLIFrameElement).contentDocument;
          if (doc) walk(doc, depth + 1);
        } catch {
          // 跨域 iframe：顶层脚本无权访问，跳过
        }
      }
    }
  };
  walk(document, 0);
  return found;
}

/** 取「最像正在播放」的视频元素：优先未暂停且有画面的，退化为第一个 */
export function queryBestVideo(): HTMLVideoElement | null {
  const direct = document.querySelector<HTMLVideoElement>('video');
  const all = direct ? [direct, ...queryAllVideosDeep().filter((v) => v !== direct)] : queryAllVideosDeep();
  if (all.length === 0) return null;
  return all.find((v) => !v.paused && v.videoWidth > 0) ?? all.find((v) => !v.paused) ?? all[0] ?? null;
}

/**
 * 通用直链解析：video.currentSrc 或 <source> 子元素的 http(s) 地址；
 * 以及资源表里页面实际拉取过的媒体文件（MSE 播放页 currentSrc 是 blob: 不可用时的补充）。
 * HLS/DASH 分片（m3u8/ts/mpd）与 DASH 分片（m4s 缺 init 段无法独立解码）不收录。
 * 供 GenericAdapter 使用，也作为其他平台 adapter 未实现时的兜底。
 */
export function resolveDirectMediaUrls(): string[] {
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    if (u && /^https?:\/\//.test(u) && !out.includes(u)) out.push(u);
  };
  const video = document.querySelector<HTMLVideoElement>('video');
  if (video) {
    push(video.currentSrc);
    push(video.src);
    for (const s of Array.from(video.querySelectorAll('source'))) push(s.src);
  }
  for (const v of queryAllVideosDeep()) {
    push(v.currentSrc);
    push(v.src);
  }
  // 资源表补充：页面真实拉过的完整媒体文件（如智慧树的 mp4 直链）
  try {
    const MEDIA_RE = /^https?:\/\/.+\.(mp4|m4a|mp3|aac|wav|ogg|webm)(\?|#|$)/i;
    for (const e of performance.getEntriesByType('resource')) {
      if (MEDIA_RE.test(e.name)) push(e.name);
    }
  } catch {
    // performance 不可用时忽略
  }
  return out;
}

/**
 * 通用课程身份的 URL 形态：保留 search（去 t 回跳参数）与 hash。
 * SPA 哈希路由站（如 /vue/#/... 的智慧教育云平台）视频身份在 hash 查询串里，
 * 只取 origin+pathname 会让整站所有页面折叠成同一门课、笔记互相串台。
 */
export function genericCanonicalUrl(href: string): string {
  const u = new URL(href);
  u.searchParams.delete('t');
  return u.toString();
}

/**
 * 兜底 adapter：任意 HTML5 <video> 页面。
 * 只实现视频元素/时间/截图/seek，字幕抛 NoSubtitlesError（UI 降级为"无章节"模式）。
 */
export class GenericAdapter implements PlatformAdapter {
  readonly name = 'generic';

  match(): boolean {
    return true;
  }

  getVideoEl(): HTMLVideoElement | null {
    // shadow DOM 穿透 + 取最像正在播放的元素
    return queryBestVideo();
  }

  getCourseInfo(): PlatformCourseInfo {
    return {
      courseId: `generic:${genericCanonicalUrl(location.href)}`,
      title: document.title || location.href,
    };
  }

  getCurrentTime(): number {
    return this.getVideoEl()?.currentTime ?? 0;
  }

  seekTo(sec: number): void {
    const video = this.getVideoEl();
    if (!video) return;
    video.currentTime = sec;
    void video.play().catch(() => {});
  }

  getSubtitles(): Promise<SubtitleCue[]> {
    return Promise.reject(new NoSubtitlesError());
  }

  getAudioDownloadUrl(): Promise<string[] | null> {
    const urls = resolveDirectMediaUrls();
    return Promise.resolve(urls.length > 0 ? urls : null);
  }

  makeJumpUrl(): string {
    return location.href;
  }

  async captureFrame(): Promise<Blob> {
    const video = this.getVideoEl();
    if (!video) throw new Error('err.noVideoElement');
    return (await captureVideoFrame(video)).blob;
  }
}
