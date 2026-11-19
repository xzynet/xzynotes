import type { SubtitleCue } from '../../core/models';
import {
  NoSubtitlesError,
  type PlatformAdapter,
  type PlatformCourseInfo,
} from './base';
import { captureVideoFrame } from './capture';
import { SubtitleProbe, cuesFromTextTracks } from './subtitle-probe';

/**
 * 学堂在线页面选择器。验证日期：2026-09-03（未实测，待回归）。
 * 字幕策略与 MOOC 相同：原生 textTrack → MAIN world 拦截 → 资源表扫描。
 */
const SELECTORS = {
  video: 'video',
  ogTitle: 'meta[property="og:title"]',
} as const;

export class XuetangxAdapter implements PlatformAdapter {
  readonly name = 'xuetangx';

  private readonly probe = new SubtitleProbe(() => this.getVideoEl()?.duration ?? undefined);

  constructor() {
    if (this.match(location.href)) this.probe.startObserver();
  }

  match(url: string): boolean {
    try {
      return new URL(url).hostname.endsWith('xuetangx.com');
    } catch {
      return false;
    }
  }

  getVideoEl(): HTMLVideoElement | null {
    return document.querySelector<HTMLVideoElement>(SELECTORS.video);
  }

  getCourseInfo(): PlatformCourseInfo {
    const rawTitle =
      document.querySelector(SELECTORS.ogTitle)?.getAttribute('content') ?? document.title;
    const title = rawTitle.replace(/[-_]?学堂在线.*$/i, '').trim() || location.pathname;
    return { courseId: `xuetangx:${location.pathname}`, title };
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

  async getSubtitles(): Promise<SubtitleCue[]> {
    const video = this.getVideoEl();
    if (video) {
      const fromTracks = cuesFromTextTracks(video);
      if (fromTracks) return fromTracks;
    }
    const fromCapture = await this.probe.cuesFromCapturedPayloads();
    if (fromCapture) return fromCapture;
    const fromResources = await this.probe.cuesFromLoadedResources();
    if (fromResources) return fromResources;
    throw new NoSubtitlesError('err.noSubtitlesXuetangx');
  }

  /** 学堂在线无时间戳深链能力，回跳链接退化为课程页地址 */
  makeJumpUrl(): string {
    return location.href.split('#')[0] ?? location.href;
  }

  async captureFrame(): Promise<Blob> {
    const video = this.getVideoEl();
    if (!video) throw new Error('err.noVideoElement');
    return (await captureVideoFrame(video)).blob;
  }
}
