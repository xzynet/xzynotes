import type { DensityPoint } from '../../core/chapters';
import type { SubtitleCue } from '../../core/models';
import {
  NoSubtitlesError,
  type PlatformAdapter,
  type PlatformCourseInfo,
} from './base';
import { captureVideoFrame } from './capture';
import { extractWbiKey, signWbiParams, type WbiKeys } from './wbi';

/**
 * B站页面选择器。验证日期：2026-09-02。
 * 平台改版导致失效时，content script 会降级到 GenericAdapter 并提示用户。
 *
 * 字幕接口注意（2026-09 实测 + 社区确认）：B站已从 /x/player/v2 迁移到
 * /x/player/wbi/v2（WBI 签名），旧接口返回的字幕与当前视频不对应，勿回退。
 */
const SELECTORS = {
  video: 'video',
  title: 'h1.video-title',
  ogTitle: 'meta[property="og:title"]',
  ogImage: 'meta[property="og:image"]',
} as const;

interface BiliViewResponse {
  data?: { pages?: Array<{ cid: number; page: number; part?: string }> };
}

interface BiliSubtitleTrack {
  subtitle_url: string;
  lan: string;
  lan_doc?: string;
}

interface BiliPlayerResponse {
  data?: { subtitle?: { subtitles?: BiliSubtitleTrack[] } };
}

interface BiliNavResponse {
  data?: { wbi_img?: { img_url?: string; sub_url?: string } };
}

interface BiliSubtitleBody {
  body?: Array<{ from: number; to: number; content: string }>;
}

const DANMAKU_BUCKET_SEC = 30;

export class BilibiliAdapter implements PlatformAdapter {
  readonly name = 'bilibili';

  /** cid 缓存：key = `${bvid}:p${page}`，避免重复请求 view 接口 */
  private readonly cidCache = new Map<string, number>();
  /** WBI 签名口令缓存（官方每日更替，缓存 1 小时足够） */
  private wbiKeys: (WbiKeys & { fetchedAt: number }) | null = null;

  match(url: string): boolean {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('bilibili.com') && u.pathname.startsWith('/video/');
    } catch {
      return false;
    }
  }

  private bvid(): string {
    const m = /\/video\/([A-Za-z0-9]+)/.exec(location.pathname);
    if (!m?.[1]) throw new Error('err.bvidParseFailed');
    return m[1];
  }

  private page(): number {
    const p = Number(new URL(location.href).searchParams.get('p') ?? '1');
    return Number.isInteger(p) && p >= 1 ? p : 1;
  }

  getVideoEl(): HTMLVideoElement | null {
    return document.querySelector<HTMLVideoElement>(SELECTORS.video);
  }

  getCourseInfo(): PlatformCourseInfo {
    const bvid = this.bvid();
    const page = this.page();
    const titleEl = document.querySelector(SELECTORS.title);
    const rawTitle =
      titleEl?.getAttribute('title') ??
      titleEl?.textContent ??
      document.querySelector(SELECTORS.ogTitle)?.getAttribute('content') ??
      document.title;
    const title = rawTitle.replace(/_哔哩哔哩.*$/, '').trim() || `BV ${bvid}`;
    const ogImage = document.querySelector(SELECTORS.ogImage)?.getAttribute('content') ?? undefined;
    const coverUrl = ogImage?.startsWith('//') ? `https:${ogImage}` : ogImage;
    // 分 P 维度必须进 courseId，否则多 P 课程笔记串库
    return { courseId: `bilibili:${bvid}:p${page}`, title, coverUrl };
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

  /** 当前分 P 的 cid：经 web-interface/view 接口（无需页面上下文，兼容 SPA） */
  private async getCid(): Promise<number> {
    const bvid = this.bvid();
    const page = this.page();
    const cacheKey = `${bvid}:p${page}`;
    const cached = this.cidCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const resp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      credentials: 'include',
    });
    const json = (await resp.json()) as BiliViewResponse;
    const pages = json.data?.pages;
    if (!pages || pages.length === 0) throw new Error('err.biliPagesFailed');
    // 按 page 字段精确匹配当前分 P，失败再退化为下标
    const cid = (pages.find((p) => p.page === page) ?? pages[page - 1] ?? pages[0])?.cid;
    if (cid === undefined) throw new Error('err.biliCidFailed');
    this.cidCache.set(cacheKey, cid);
    return cid;
  }

  /** WBI 签名口令（nav 接口，未登录也会返回 wbi_img） */
  private async getWbiKeys(): Promise<WbiKeys> {
    if (this.wbiKeys && Date.now() - this.wbiKeys.fetchedAt < 3600_000) return this.wbiKeys;
    const resp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      credentials: 'include',
    });
    const json = (await resp.json()) as BiliNavResponse;
    const imgKey = extractWbiKey(json.data?.wbi_img?.img_url ?? '');
    const subKey = extractWbiKey(json.data?.wbi_img?.sub_url ?? '');
    if (!imgKey || !subKey) throw new Error('err.wbiKeysFailed');
    this.wbiKeys = { imgKey, subKey, fetchedAt: Date.now() };
    return this.wbiKeys;
  }

  /** 字幕轨优选：UP主中文 > AI 中文 > 任意中文 > 第一条 */
  private pickSubtitleTrack(list: BiliSubtitleTrack[]): BiliSubtitleTrack | undefined {
    return (
      list.find((s) => s.lan === 'zh-CN') ??
      list.find((s) => s.lan === 'ai-zh') ??
      list.find((s) => s.lan.startsWith('zh')) ??
      list[0]
    );
  }

  async getSubtitles(): Promise<SubtitleCue[]> {
    const cid = await this.getCid();
    const bvid = this.bvid();
    // 字幕接口已迁移到 wbi/v2（WBI 签名）；旧 /x/player/v2 会返回错位字幕
    const keys = await this.getWbiKeys();
    const query = signWbiParams({ bvid, cid }, keys, Math.floor(Date.now() / 1000));
    const resp = await fetch(`https://api.bilibili.com/x/player/wbi/v2?${query}`, {
      credentials: 'include',
    });
    const json = (await resp.json()) as BiliPlayerResponse;
    const list = json.data?.subtitle?.subtitles;
    if (!list || list.length === 0) throw new NoSubtitlesError();
    const track = this.pickSubtitleTrack(list);
    if (!track) throw new NoSubtitlesError();
    const subUrl = track.subtitle_url.startsWith('http')
      ? track.subtitle_url
      : `https:${track.subtitle_url}`;
    const subResp = await fetch(subUrl);
    const subJson = (await subResp.json()) as BiliSubtitleBody;
    const body = subJson.body;
    if (!body || body.length === 0) throw new NoSubtitlesError();
    return body.map((c) => ({
      start: Number(c.from),
      end: Number(c.to),
      text: String(c.content),
    }));
  }

  async getDanmakuDensity(): Promise<DensityPoint[]> {
    const cid = await this.getCid();
    const resp = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`);
    const xml = await resp.text();
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const buckets = new Map<number, number>();
    for (const d of Array.from(doc.querySelectorAll('d'))) {
      const p = d.getAttribute('p');
      const t = Number(p?.split(',')[0]);
      if (!Number.isFinite(t)) continue;
      const bucket = Math.floor(t / DANMAKU_BUCKET_SEC) * DANMAKU_BUCKET_SEC;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    return [...buckets.entries()].map(([sec, count]) => ({ sec, count }));
  }

  /**
   * 语音转写媒体源：优先 DASH 纯音轨（体积小，登录态可见）；
   * 未登录 dash 为空时退化为 durl 360p mp4（含完整音轨，约 4MB/分钟）。
   * CDN（bilivideo.com）实测反射 Origin 且支持 Range，面板可直接带进度下载。
   */
  async getAudioDownloadUrl(): Promise<string[] | null> {
    const bvid = this.bvid();
    const cid = await this.getCid();
    const urls: string[] = [];

    try {
      const keys = await this.getWbiKeys();
      const query = signWbiParams(
        { bvid, cid, fnval: 16, platform: 'html5' },
        keys,
        Math.floor(Date.now() / 1000),
      );
      const resp = await fetch(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, {
        credentials: 'include',
      });
      const json = (await resp.json()) as {
        data?: { dash?: { audio?: Array<{ baseUrl: string; bandwidth: number }> } };
      };
      const audios = json.data?.dash?.audio ?? [];
      if (audios.length > 0) {
        // 取码率最低的音轨：ASR 不需要高音质，下载最小化
        const best = audios.reduce((a, b) => (b.bandwidth < a.bandwidth ? b : a));
        urls.push(best.baseUrl);
      }
    } catch {
      // wbi 接口失败不影响 durl 兜底
    }

    if (urls.length === 0) {
      const resp = await fetch(
        `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048&platform=html5&quality=16`,
        { credentials: 'include' },
      );
      const json = (await resp.json()) as { data?: { durl?: Array<{ url: string }> } };
      const url = json.data?.durl?.[0]?.url;
      if (url) urls.push(url);
    }

    return urls.length > 0 ? urls : null;
  }

  makeJumpUrl(sec: number): string {
    const base = `https://www.bilibili.com/video/${this.bvid()}/`;
    const page = this.page();
    const p = page > 1 ? `?p=${page}&t=${Math.floor(sec)}` : `?t=${Math.floor(sec)}`;
    return `${base}${p}`;
  }

  async captureFrame(): Promise<Blob> {
    const video = this.getVideoEl();
    if (!video) throw new Error('err.noVideoElement');
    return (await captureVideoFrame(video)).blob;
  }
}
