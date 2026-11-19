import { browser } from 'wxt/browser';
import type { ApiResponse } from '../../core/messages';
import type { SubtitleCue } from '../../core/models';
import {
  NoSubtitlesError,
  type PlatformAdapter,
  type PlatformCourseInfo,
} from './base';
import { captureVideoFrame } from './capture';
import { queryBestVideo } from './generic';
import { SubtitleProbe, cuesFromTextTracks } from './subtitle-probe';

/**
 * 后台中转抓取：字幕接口 newbase.zhihuishu.com 跨域且无 ACAO 头，
 * content script 直连必被 CORS 拦；后台 SW 持有 host 权限可跨域抓取，
 * 且请求从 SW 发出，页面完全无感知（不触发反作弊）。
 */
async function fetchTextViaBackground(url: string): Promise<string | null> {
  try {
    const resp = (await browser.runtime.sendMessage({
      type: 'net:fetchText',
      url,
    })) as ApiResponse<string>;
    if (!resp.ok) {
      console.warn(`[kedaibiao] 后台中转抓取失败（${resp.error}）：${url.slice(0, 120)}`);
      return null;
    }
    return resp.data;
  } catch (e) {
    console.warn('[kedaibiao] 后台中转消息异常', e);
    return null;
  }
}

/**
 * 智慧树（知到）页面选择器。验证日期：2026-09-07（课程名选择器未实测，待回归）。
 *
 * 反作弊约束（智慧树检测页面注入痕迹，命中则拒绝播放视频）：
 * - 不在 MAIN world 注入任何脚本（不 hook fetch/XHR、不写 window 属性），
 *   因此字幕没有「响应拦截」路径，只靠 textTrack + 资源表扫描；
 * - content.ts 在该域名不挂载悬浮按钮，页面 DOM 零改动；
 * - 字幕/资源抓取走 PerformanceObserver；跨域无 CORS 头的接口
 *   （newbase 的 JSONP 字幕）由后台 SW 中转抓取，页面完全无感知。
 */
const SELECTORS = {
  video: 'video',
  ogTitle: 'meta[property="og:title"]',
} as const;

/**
 * 课程名元素选择器（按优先级尝试）。课程主页/学习页侧边栏顶部有课程名容器；
 * 选择器失效时降级 og:title / document.title，再兜底 pathname。
 */
const COURSE_NAME_SELECTORS = [
  '.course-name',
  '.courseName',
  '#courseName',
  '.course-title',
  '.course-info .name',
] as const;

/** 平台名/栏目名本身不是课程名（这些页面的 document.title 常常只有「智慧树」） */
const GENERIC_TITLE_RE = /^(智慧树|知到|课程学习|智慧树在线教育)$/;

export function isGenericTitle(title: string): boolean {
  return GENERIC_TITLE_RE.test(title.trim());
}

/** 清洗标题：去掉尾部的平台名（「课程学习_智慧树」→「课程学习」） */
export function cleanCourseTitle(raw: string): string {
  return raw.replace(/[-_—]?(智慧树|知到).*$/i, '').trim();
}

/** 登录态令牌/时间戳类参数：随会话变化，不进课程 id */
const VOLATILE_PARAM_RE = /^(token|ticket|timestamp|ts|sign|nonce|_|t)$/i;

/**
 * 课程 id = 路径 + 过滤后的查询串。
 * 课程主页 /courseHome/{courseId}/{recruitId}/... 的路径已含课程与学期维度；
 * H5 学习页（studyvideoh5 等）课节身份在查询参数里，故保留去噪后的 search。
 */
export function courseIdFromLocation(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  const kept = [...params.entries()]
    .filter(([k]) => !VOLATILE_PARAM_RE.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : '';
  return `zhihuishu:${pathname}${query}`;
}

export class ZhihuishuAdapter implements PlatformAdapter {
  readonly name = 'zhihuishu';

  private readonly probe = new SubtitleProbe(
    () => this.getVideoEl()?.duration ?? undefined,
    fetchTextViaBackground,
  );

  constructor() {
    // 非页面上下文（如单测）无 location，跳过观察器启动
    if (typeof location !== 'undefined' && this.match(location.href)) this.probe.startObserver();
  }

  match(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host === 'zhihuishu.com' || host.endsWith('.zhihuishu.com');
    } catch {
      return false;
    }
  }

  getVideoEl(): HTMLVideoElement | null {
    // 智慧树播放器把视频封装在 shadow root/多层容器里，朴素选择器会拿到占位元素
    return queryBestVideo();
  }

  getCourseInfo(): PlatformCourseInfo {
    // 课程名优先取页面容器（侧边栏顶部）；退回 og:title / document.title 清洗；
    // 平台名/栏目名等无信息标题一律跳过
    let title = '';
    for (const sel of COURSE_NAME_SELECTORS) {
      const t = document.querySelector(sel)?.textContent?.trim() ?? '';
      if (t && !isGenericTitle(t)) {
        title = t;
        break;
      }
    }
    if (!title) {
      const raw =
        document.querySelector(SELECTORS.ogTitle)?.getAttribute('content') ?? document.title;
      const cleaned = cleanCourseTitle(raw);
      if (cleaned && !isGenericTitle(cleaned)) title = cleaned;
    }
    return {
      courseId: courseIdFromLocation(location.pathname, location.search),
      title: title || location.pathname,
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

  /**
   * 字幕路径（无 MAIN world 拦截，见文件头反作弊约束）：
   * 播放器原生 textTrack → 资源表扫描（subtitleV1 等 JSONP 接口走后台中转剥壳，
   * .srt/.vtt 及视频信息接口内嵌链接）。
   */
  async getSubtitles(): Promise<SubtitleCue[]> {
    const video = this.getVideoEl();
    if (video) {
      const fromTracks = cuesFromTextTracks(video);
      if (fromTracks) return fromTracks;
    }
    const fromResources = await this.probe.cuesFromLoadedResources();
    if (fromResources) return fromResources;
    throw new NoSubtitlesError('err.noSubtitlesZhihuishu');
  }

  /** 智慧树无时间戳深链能力，回跳链接退化为课程页地址 */
  makeJumpUrl(): string {
    return location.href.split('#')[0] ?? location.href;
  }

  async captureFrame(): Promise<Blob> {
    const video = this.getVideoEl();
    if (!video) throw new Error('err.noVideoElement');
    // CDN 视频若未开 CORS 会污染 canvas 抛错，由调用方降级 captureVisibleTab
    return (await captureVideoFrame(video)).blob;
  }
}
