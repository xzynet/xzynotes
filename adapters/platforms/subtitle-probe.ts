import type { SubtitleCue } from '../../core/models';
import { decodeSubtitleBuffer, parseAnySubtitle, unwrapJsonp } from '../../core/utils/srt';
import { getCapturedSubtitlePayloads } from './subtitle-capture';

/** 字幕资源 URL 特征 */
export const SUBTITLE_RESOURCE_RE =
  /downloadVideoSrt|\.srt(\?|$)|\.vtt(\?|$)|subtitle|caption|timedtext/i;
/** 可能内嵌字幕链接的视频信息类接口 */
const SUBTITLE_HOST_RE = /resourceRpc|vod\.study|getVideo|videoInfo|learn\/content|subtitle/i;
/** 从 JSON 文本中提取 srt/vtt 链接 */
export const EMBEDDED_SUB_URL_RE = /https?:[^"'\\\s]+?\.(?:srt|vtt)(?:\?[^"'\\\s]*)?/gi;

/** 路径：播放器原生 textTrack → 直接读 cue 列表 */
export function cuesFromTextTracks(video: HTMLVideoElement): SubtitleCue[] | null {
  for (const track of Array.from(video.textTracks)) {
    const cues = track.cues;
    if (!cues || cues.length === 0) continue;
    const out: SubtitleCue[] = [];
    for (const c of Array.from(cues)) {
      const cue = c as VTTCue;
      const text = cue.text?.replace(/<[^>]+>/g, '').trim();
      if (text) out.push({ start: cue.startTime, end: cue.endTime, text });
    }
    if (out.length > 0) return out;
  }
  return null;
}

/**
 * 页面资源观察器 + 字幕资源抓取。
 * 网课页面资源量大，默认 250 条缓冲区会挤掉早期的字幕请求，
 * 所以从 content script 启动就流式收集。
 */
export class SubtitleProbe {
  private readonly seen = new Set<string>();
  private started = false;

  /** getVideoDurationSec：列式 JSON 字幕的毫秒/秒单位判定用 */
  constructor(
    private readonly getVideoDurationSec?: () => number | undefined,
    /** 直连失败时的中转抓取（后台 SW 不受页面 CORS 限制），如智慧树跨域字幕 */
    private readonly relayFetchText?: (url: string) => Promise<string | null>,
  ) {}

  startObserver(): void {
    if (this.started) return;
    this.started = true;
    try {
      performance.setResourceTimingBufferSize?.(5000);
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.seen.add(entry.name);
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      // 观察器不可用时退化为只读当前缓冲区
    }
  }

  allResourceUrls(): string[] {
    const urls = new Set(this.seen);
    for (const e of performance.getEntriesByType('resource')) urls.add(e.name);
    return [...urls];
  }

  /**
   * 抓取文本资源。同源带登录态；跨域不带凭据（公共 CDN 的 ACAO 常为 *，
   * 带凭据会被 CORS 规范拦截）；http 资源在 https 页面下自动升级。
   * 直连失败且配置了中转（relayFetchText）时走中转——跨域无 ACAO 头的
   * 接口（如智慧树 newbase 的 JSONP 字幕）由后台 SW 代抓。
   */
  async fetchText(url: string): Promise<string | null> {
    const direct = await this.fetchTextDirect(url);
    if (direct !== null) return direct;
    if (!this.relayFetchText) return null;
    console.warn(`[kedaibiao] 直连失败，走后台中转：${url.slice(0, 120)}`);
    return this.relayFetchText(url);
  }

  private async fetchTextDirect(url: string): Promise<string | null> {
    try {
      const target = new URL(url, location.href);
      if (target.protocol === 'http:' && location.protocol === 'https:') {
        target.protocol = 'https:';
      }
      const sameOrigin = target.origin === location.origin;
      const resp = await fetch(target.toString(), {
        credentials: sameOrigin ? 'include' : 'omit',
      });
      if (!resp.ok) {
        console.warn(`[kedaibiao] 资源抓取失败 HTTP ${resp.status}：${target.toString()}`);
        return null;
      }
      return decodeSubtitleBuffer(await resp.arrayBuffer());
    } catch (e) {
      console.warn(`[kedaibiao] 资源抓取异常：${url}`, e);
      return null;
    }
  }

  /** 抓取并解析（SRT/VTT → 列式 JSON 双通道；JSONP 剥壳后重试 + 提取内嵌字幕链接） */
  async fetchAndParseSubtitleFile(url: string): Promise<SubtitleCue[] | null> {
    const text = await this.fetchText(url);
    if (text === null) return null;
    const duration = this.getVideoDurationSec?.();
    const cues = parseAnySubtitle(text, duration);
    if (cues.length > 0) {
      console.log(`[kedaibiao] 字幕文件解析出 ${cues.length} 条：${url.slice(0, 100)}`);
      return cues;
    }
    // JSONP 包裹（智慧树 subtitleV1）：剥壳后正文可能直接是字幕 JSON，
    // 或含指向字幕文件的链接
    const inner = unwrapJsonp(text);
    if (inner !== null) {
      const innerCues = parseAnySubtitle(inner, duration);
      if (innerCues.length > 0) {
        console.log(`[kedaibiao] JSONP 剥壳解析出 ${innerCues.length} 条：${url.slice(0, 100)}`);
        return innerCues;
      }
      for (const subUrl of (inner.match(EMBEDDED_SUB_URL_RE) ?? []).slice(0, 5)) {
        const embedded = await this.fetchAndParseSubtitleFile(subUrl);
        if (embedded) return embedded;
      }
      // 结构未知：打印 JSON 顶层字段名，便于按实测结构补解析器
      try {
        const json = JSON.parse(inner) as Record<string, unknown>;
        console.warn(
          `[kedaibiao] JSONP 字幕结构未识别，顶层字段：[${Object.keys(json).join(', ')}]，预览：${inner.slice(0, 300)}`,
        );
      } catch {
        console.warn(`[kedaibiao] JSONP 内容非 JSON：${inner.slice(0, 150)}`);
      }
      return null;
    }
    console.warn(
      `[kedaibiao] 字幕文件解析为 0 条（内容 ${text.length} 字符）：${text.slice(0, 150)}`,
    );
    return null;
  }

  /**
   * 拦截器捕获内容（通用）：SRT/VTT 直读 + JSON 正则提取内嵌链接。
   * 平台定制的 JSON 结构（如 MOOC mergedSentences）由各自 adapter 处理。
   */
  async cuesFromCapturedPayloads(): Promise<SubtitleCue[] | null> {
    for (const payload of getCapturedSubtitlePayloads()) {
      const direct = parseAnySubtitle(payload.text, this.getVideoDurationSec?.());
      if (direct.length > 0) return direct;
      const embedded = payload.text.match(EMBEDDED_SUB_URL_RE) ?? [];
      for (const subUrl of embedded.slice(0, 5)) {
        const cues = await this.fetchAndParseSubtitleFile(subUrl);
        if (cues) return cues;
      }
    }
    return null;
  }

  /** 资源表扫描：直接命中 srt/vtt → 否则探测视频信息接口 JSON 里的内嵌链接 */
  async cuesFromLoadedResources(): Promise<SubtitleCue[] | null> {
    const urls = this.allResourceUrls();
    const direct = urls.filter((u) => SUBTITLE_RESOURCE_RE.test(u));
    for (const url of direct) {
      const cues = await this.fetchAndParseSubtitleFile(url);
      if (cues) return cues;
    }
    const probes = urls.filter((u) => SUBTITLE_HOST_RE.test(u) && !SUBTITLE_RESOURCE_RE.test(u));
    for (const url of probes.slice(0, 10)) {
      const text = await this.fetchText(url);
      if (!text) continue;
      const embedded = text.match(EMBEDDED_SUB_URL_RE) ?? [];
      for (const subUrl of embedded.slice(0, 5)) {
        const cues = await this.fetchAndParseSubtitleFile(subUrl);
        if (cues) return cues;
      }
    }
    return null;
  }
}
