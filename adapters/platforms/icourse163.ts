import type { SubtitleCue } from '../../core/models';
import { parseSubtitleText } from '../../core/utils/srt';
import {
  NoSubtitlesError,
  type PlatformAdapter,
  type PlatformCourseInfo,
} from './base';
import { captureVideoFrame } from './capture';
import { getCapturedSubtitlePayloads } from './subtitle-capture';
import {
  EMBEDDED_SUB_URL_RE,
  SubtitleProbe,
  cuesFromTextTracks,
} from './subtitle-probe';

/**
 * 中国大学MOOC 页面选择器。验证日期：2026-09-03。
 * 平台改版导致失效时，content script 会降级到 GenericAdapter 并提示用户。
 */
const SELECTORS = {
  video: 'video',
  ogTitle: 'meta[property="og:title"]',
} as const;

/** getVideoSubtitle.rpc 响应的 result 部分（已实测的字段） */
interface MocSubtitleResult {
  srtUrl?: string | null;
  mergedSentences?: unknown;
}

/**
 * mergedSentences 实测结构（2026-09-03，人工智能概论课程）：
 * [[{ beginTime: ms, sentences: [{ beginTime: ms, endTime: ms, sequence, text }] }]]
 * 段落级对象含 sentences 数组；句子级为 beginTime/endTime/text，时间单位毫秒。
 */
export function cuesFromMergedSentences(input: unknown): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    // 句子级：beginTime + endTime + text（毫秒 → 秒）
    if (
      typeof o['text'] === 'string' &&
      typeof o['beginTime'] === 'number' &&
      typeof o['endTime'] === 'number'
    ) {
      const text = o['text'].trim();
      if (text) {
        cues.push({ start: o['beginTime'] / 1000, end: o['endTime'] / 1000, text });
      }
      return;
    }
    // 段落级：递归进 sentences
    if (Array.isArray(o['sentences'])) visit(o['sentences']);
  };
  visit(input);
  return cues.sort((a, b) => a.start - b.start);
}

/** 秒 → m:ss（日志用） */
function formatSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export class Icourse163Adapter implements PlatformAdapter {
  readonly name = 'icourse163';

  private readonly probe = new SubtitleProbe(() => this.getVideoEl()?.duration ?? undefined);

  constructor() {
    if (this.match(location.href)) this.probe.startObserver();
  }

  match(url: string): boolean {
    try {
      return new URL(url).hostname.endsWith('icourse163.org');
    } catch {
      return false;
    }
  }

  /**
   * 课程页 URL 形如：
   * /learn/{courseSlug}?tid={termId}#/learn/content?type=detail&id={contentId}
   * courseId = 课程 slug + 内容 id（精确到单节课视频）
   */
  private contentId(): string | null {
    const hash = location.hash.includes('?') ? location.hash.split('?')[1] : '';
    if (!hash) return null;
    return new URLSearchParams(hash).get('id');
  }

  private courseSlug(): string {
    return location.pathname.split('/').filter(Boolean).pop() ?? 'unknown';
  }

  getVideoEl(): HTMLVideoElement | null {
    return document.querySelector<HTMLVideoElement>(SELECTORS.video);
  }

  getCourseInfo(): PlatformCourseInfo {
    const contentId = this.contentId();
    const slug = this.courseSlug();
    const courseId = contentId ? `icourse163:${slug}:${contentId}` : `icourse163:${slug}`;
    const rawTitle =
      document.querySelector(SELECTORS.ogTitle)?.getAttribute('content') ?? document.title;
    const title = rawTitle.replace(/[-_]?中国大学MOOC.*$/i, '').trim() || slug;
    return { courseId, title };
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
   * 路径零（最优）：MAIN world 拦截器捕获的字幕接口响应体。
   * 直接读响应，完全不需要知道请求格式（getVideoSubtitle.rpc 是 POST）。
   * MOOC 字幕分段加载：合并所有捕获分段，按时间排序去重。
   */
  private async subtitlesFromCapture(): Promise<SubtitleCue[] | null> {
    const payloads = getCapturedSubtitlePayloads();
    if (payloads.length === 0) return null;
    const all: SubtitleCue[] = [];
    for (const payload of payloads) {
      // 直接是 SRT/VTT 内容
      const direct = parseSubtitleText(payload.text);
      if (direct.length > 0) {
        all.push(...direct);
        continue;
      }
      // 按 JSON 正经解析（getVideoSubtitle.rpc）：srtUrl 与 mergedSentences 都尝试并合并
      // （mergedSentences 可能只含首段 AI 字幕句，srt 文件可能是全量）
      let handled = false;
      try {
        const json = JSON.parse(payload.text) as { result?: MocSubtitleResult | null };
        const result = json.result;
        if (result) {
          if (typeof result.srtUrl === 'string' && result.srtUrl) {
            const cues = await this.probe.fetchAndParseSubtitleFile(result.srtUrl);
            if (cues) {
              all.push(...cues);
              handled = true;
            }
          }
          const merged = cuesFromMergedSentences(result.mergedSentences);
          if (merged.length > 0) {
            all.push(...merged);
            handled = true;
          }
        }
      } catch {
        // 非 JSON，走正则兜底
      }
      if (handled) continue;
      // 兜底：正则提取内嵌的字幕文件链接
      const embedded = payload.text.match(EMBEDDED_SUB_URL_RE) ?? [];
      for (const subUrl of embedded.slice(0, 5)) {
        const cues = await this.probe.fetchAndParseSubtitleFile(subUrl);
        if (cues) all.push(...cues);
      }
    }
    if (all.length === 0) return null;
    // 按时间排序 + 同时间点同文本去重（回看会重复捕获同一段）
    const seen = new Set<string>();
    const out: SubtitleCue[] = [];
    for (const cue of all.sort((a, b) => a.start - b.start)) {
      const key = `${cue.start.toFixed(2)}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cue);
    }
    // 覆盖范围日志：判断「分段懒加载」还是「解析漏段」的关键证据
    const last = out[out.length - 1];
    console.warn(
      `[kedaibiao] 字幕就绪：${payloads.length} 个分段共 ${out.length} 条，` +
        `覆盖至 ${last ? formatSec(last.end) : '0:00'}`,
    );
    return out;
  }

  private logDiagnostics(video: HTMLVideoElement | null): void {
    const urls = this.probe
      .allResourceUrls()
      .filter((u) => /icourse163|study\.163|nos\.netease|hdslb/i.test(u));
    const tracks = video
      ? Array.from(video.textTracks).map(
          (t) => `${t.kind}/${t.mode}/${t.cues?.length ?? 0}cues`,
        )
      : [];
    // 纯文本平铺输出：控制台截图即可读，无需展开对象
    console.warn('[kedaibiao] MOOC 字幕诊断 ==========');
    console.warn(`hasVideo: ${Boolean(video)}, textTracks: [${tracks.join(', ')}]`);
    const captured = getCapturedSubtitlePayloads();
    console.warn(`拦截器捕获 ${captured.length} 条：`);
    for (const p of captured) {
      console.warn(`  ${p.url}`);
      if (p.requestBody) console.warn(`  请求体: ${p.requestBody.slice(0, 300)}`);
      // 解析 JSON 结构：字段名 + mergedSentences 形状预览（定位格式问题用）
      try {
        const j = JSON.parse(p.text) as { result?: MocSubtitleResult | null };
        if (j.result) {
          console.warn(`  result 字段: [${Object.keys(j.result).join(', ')}]`);
          console.warn(`  srtUrl: ${String(j.result.srtUrl)}`);
          console.warn(
            `  mergedSentences 结构预览: ${JSON.stringify(j.result.mergedSentences)?.slice(0, 500)}`,
          );
        }
      } catch {
        console.warn(`  响应预览: ${p.text.slice(0, 200)}`);
      }
    }
    console.warn(`MOOC 相关资源 ${urls.length} 条：`);
    for (const u of urls.slice(-30)) console.warn(`  ${u}`);
    console.warn('[kedaibiao] 诊断结束 ==========');
  }

  async getSubtitles(): Promise<SubtitleCue[]> {
    const video = this.getVideoEl();
    if (video) {
      const fromTracks = cuesFromTextTracks(video);
      if (fromTracks) return fromTracks;
    }
    const fromCapture = await this.subtitlesFromCapture();
    if (fromCapture) return fromCapture;
    const fromResource = await this.probe.cuesFromLoadedResources();
    if (fromResource) return fromResource;
    this.logDiagnostics(video);
    throw new NoSubtitlesError('err.noSubtitlesIcourse163');
  }

  /** MOOC 无时间戳深链能力，回跳链接退化为本节课页面地址 */
  makeJumpUrl(): string {
    return location.href.split('#')[0] ?? location.href;
  }

  async captureFrame(): Promise<Blob> {
    const video = this.getVideoEl();
    if (!video) throw new Error('err.noVideoElement');
    return (await captureVideoFrame(video)).blob;
  }
}
