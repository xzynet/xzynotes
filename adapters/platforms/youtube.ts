import type { SubtitleCue } from '../../core/models';
import {
  NoSubtitlesError,
  type PlatformAdapter,
  type PlatformCourseInfo,
} from './base';
import { captureVideoFrame } from './capture';
import { queryBestVideo } from './generic';
import { getCapturedSubtitlePayloads } from './subtitle-capture';

/**
 * YouTube 字幕获取（验证日期：2026-09-14）。
 *
 * 双层策略：
 * 1. MAIN world 拦截器捕获的 /api/timedtext 响应（用户已在播放器开启 CC 时，
 *    播放器自己会拉字幕，响应即用户实际选择的语言轨）；
 * 2. captionTracks 直取：从 ytInitialPlayerResponse（DOM script 标签或重新拉取
 *    watch HTML）提取字幕轨 baseUrl，带 fmt=json3 直取。无需用户开 CC。
 * YouTube 不用原生 <track>，textTrack 路径无效；自适应流带签名且 IP 绑定，
 * 不实现 getAudioDownloadUrl，ASR 走实时捕获兜底。
 */

/** captionTracks[] 元素中我们关心的字段 */
export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** 自动生成轨为 'asr'，人工轨无此字段 */
  kind?: string;
  name?: string;
}

/**
 * timedtext JSON3 格式（fmt=json3）：
 * { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
 * 无 segs 的事件是纯时间对齐标记，跳过；segs 拼接后换行合并为空格。
 * dDurationMs 缺失时用下一事件起点兜底（末事件 +5s）。
 */
export function parseTimedtextJson3(text: string): SubtitleCue[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof json !== 'object' || json === null) return [];
  const events = (json as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];

  interface Row {
    start: number;
    dur: number | null;
    text: string;
  }
  const rows: Row[] = [];
  for (const ev of events) {
    if (typeof ev !== 'object' || ev === null) continue;
    const e = ev as { tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown };
    if (typeof e.tStartMs !== 'number' || !Array.isArray(e.segs)) continue;
    const text = e.segs
      .map((s: unknown) =>
        typeof s === 'object' && s !== null ? String((s as { utf8?: unknown }).utf8 ?? '') : '',
      )
      .join('')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (!text) continue;
    const dur = typeof e.dDurationMs === 'number' && e.dDurationMs > 0 ? e.dDurationMs : null;
    rows.push({ start: e.tStartMs, dur, text });
  }
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const start = row.start / 1000;
    const endMs = row.dur !== null ? row.start + row.dur : (rows[i + 1]?.start ?? row.start + 5000);
    const end = endMs / 1000;
    if (end > start) cues.push({ start, end, text: row.text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** XML 实体单趟解码（&amp;lt; → &lt; 字面量，不二次解码） */
function decodeXmlEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (raw, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : raw;
    }
    return named[name.toLowerCase()] ?? raw;
  });
}

/**
 * timedtext 默认 XML 格式：
 * <timedtext format="3"><body><text start="1.23" dur="4.56">内容</text>…</body></timedtext>
 * 时间为秒（浮点）；文本可能含实体与 <i>/<font> 等内嵌标签。dur 缺失时同 JSON3 兜底。
 * 用正则而非 DOMParser：单测跑在 node 环境（无 DOM），且该格式结构扁平足够规整。
 */
export function parseTimedtextXml(text: string): SubtitleCue[] {
  if (!text.includes('<text')) return [];
  interface Row {
    start: number;
    dur: number | null;
    text: string;
  }
  const rows: Row[] = [];
  const TEXT_RE = /<text\s+([^>]*?)>([\s\S]*?)<\/text>/gi;
  let m: RegExpExecArray | null;
  while ((m = TEXT_RE.exec(text)) !== null) {
    const attrs = m[1] ?? '';
    const start = Number(/(?:^|\s)start="([^"]*)"/.exec(attrs)?.[1]);
    if (!Number.isFinite(start)) continue;
    const durRaw = Number(/(?:^|\s)dur="([^"]*)"/.exec(attrs)?.[1]);
    const cueText = decodeXmlEntities((m[2] ?? '').replace(/<[^>]+>/g, ''))
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (!cueText) continue;
    rows.push({ start, dur: Number.isFinite(durRaw) && durRaw > 0 ? durRaw : null, text: cueText });
  }
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const end = row.dur !== null ? row.start + row.dur : (rows[i + 1]?.start ?? row.start + 5);
    if (end > row.start) cues.push({ start: row.start, end, text: row.text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** 两种 timedtext 格式统一入口（先 JSON3 后 XML） */
export function parseTimedtext(text: string): SubtitleCue[] {
  const json3 = parseTimedtextJson3(text);
  return json3.length > 0 ? json3 : parseTimedtextXml(text);
}

/**
 * 从 marker（如 "captionTracks":）之后的 JSON 数组做括号配平提取。
 * 不能用 [^\]]* 偷懒：name.runs 是嵌套数组（{"runs":[{"text":"中文"}]}），
 * 会在第一个 ] 处截断。配平扫描需跳过字符串字面量（含转义）。
 */
function extractJsonArrayAfter(text: string, marker: string): string | null {
  const markerIdx = text.indexOf(marker);
  if (markerIdx < 0) return null;
  let i = markerIdx + marker.length;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (text[i] !== '[') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let k = i; k < text.length; k++) {
    const ch = text[k]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(i, k + 1);
    }
  }
  return null;
}

/**
 * 从 watch HTML / ytInitialPlayerResponse 脚本文本中提取字幕轨列表。
 * baseUrl 里的 & 在源码中是 & 转义，JSON.parse 自动还原。
 */
export function extractCaptionTracks(html: string): CaptionTrack[] {
  const raw = extractJsonArrayAfter(html, '"captionTracks":');
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const tracks: CaptionTrack[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o['baseUrl'] !== 'string' || typeof o['languageCode'] !== 'string') continue;
    const name =
      typeof o['name'] === 'object' && o['name'] !== null
        ? ((o['name'] as { simpleText?: unknown }).simpleText ??
          (Array.isArray((o['name'] as { runs?: unknown }).runs)
            ? ((o['name'] as { runs: { text?: unknown }[] }).runs[0]?.text as string | undefined)
            : undefined))
        : undefined;
    tracks.push({
      baseUrl: o['baseUrl'],
      languageCode: o['languageCode'],
      ...(typeof o['kind'] === 'string' ? { kind: o['kind'] } : {}),
      ...(typeof name === 'string' ? { name } : {}),
    });
  }
  return tracks;
}

/** player response 中的当前视频 id（"videoDetails":{"videoId":"…"}，videoId 恒为首字段） */
export function extractVideoIdFromPlayerResponse(html: string): string | null {
  return /"videoDetails"\s*:\s*\{\s*"videoId"\s*:\s*"([^"]+)"/.exec(html)?.[1] ?? null;
}

/**
 * 轨道选择：优先与界面语言匹配的人工轨，其次任意人工轨，最后自动生成轨兜底
 * （kind === 'asr' 的是语音识别字幕，断句/标点较差）。
 */
export function pickCaptionTrack(
  tracks: CaptionTrack[],
  preferredLang = '',
): CaptionTrack | null {
  if (tracks.length === 0) return null;
  const manual = tracks.filter((t) => t.kind !== 'asr');
  const pool = manual.length > 0 ? manual : tracks;
  const lang = preferredLang.toLowerCase();
  const family = lang.split('-')[0];
  if (family) {
    const exact = pool.find((t) => t.languageCode.toLowerCase() === lang);
    if (exact) return exact;
    const sameFamily = pool.find((t) => t.languageCode.toLowerCase().split('-')[0] === family);
    if (sameFamily) return sameFamily;
  }
  return pool[0] ?? null;
}

export class YoutubeAdapter implements PlatformAdapter {
  readonly name = 'youtube';

  match(url: string): boolean {
    try {
      const u = new URL(url);
      return (
        (u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com')) &&
        u.pathname.startsWith('/watch')
      );
    } catch {
      return false;
    }
  }

  private videoId(): string | null {
    return new URLSearchParams(location.search).get('v');
  }

  getVideoEl(): HTMLVideoElement | null {
    return (
      document.querySelector<HTMLVideoElement>('video.html5-main-video') ?? queryBestVideo()
    );
  }

  getCourseInfo(): PlatformCourseInfo {
    const id = this.videoId();
    if (!id) throw new Error('err.youtubeMissingVideoParam');
    const raw =
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ??
      document.title;
    const title = raw.replace(/ - YouTube$/i, '').trim() || `YouTube ${id}`;
    return { courseId: `youtube:${id}`, title };
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
    // 拦截器捕获（用户已开 CC）：零请求，且就是用户实际选择的语言轨
    const fromCapture = this.subtitlesFromCapture();
    if (fromCapture) return fromCapture;
    // captionTracks 直取：无需开 CC，SPA 换视频后按 videoId 校验并必要时重拉 HTML
    const fromTracks = await this.subtitlesFromCaptionTracks();
    if (fromTracks) return fromTracks;
    this.logDiagnostics();
    throw new NoSubtitlesError('err.noSubtitlesYoutube');
  }

  /**
   * 拦截器捕获的 timedtext 响应。URL 带 v 参数时按当前视频过滤
   * （SPA 站内换视频后，缓存里可能残留上个视频的捕获）。
   */
  private subtitlesFromCapture(): SubtitleCue[] | null {
    const id = this.videoId();
    const payloads = getCapturedSubtitlePayloads().filter((p) => {
      if (!/timedtext/i.test(p.url)) return false;
      const v = /[?&]v=([^&]+)/.exec(p.url)?.[1];
      return !v || v === id;
    });
    const all: SubtitleCue[] = [];
    for (const p of payloads) all.push(...parseTimedtext(p.text));
    if (all.length === 0) return null;
    // 回看/切轨会重复捕获：按时间点 + 文本去重
    const seen = new Set<string>();
    const out: SubtitleCue[] = [];
    for (const cue of all.sort((a, b) => a.start - b.start)) {
      const key = `${cue.start.toFixed(2)}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cue);
    }
    console.warn(`[kedaibiao] YouTube 字幕（拦截器）：${out.length} 条`);
    return out;
  }

  private async subtitlesFromCaptionTracks(): Promise<SubtitleCue[] | null> {
    const id = this.videoId();
    if (!id) return null;
    // 优先当前 DOM 里的 player response（首载即含）；SPA 换视频后 script 是旧的，
    // 按 videoId 校验，不一致则重拉当前 watch HTML
    let source = this.playerResponseFromDom(id);
    if (!source) {
      const html = await this.fetchWatchHtml();
      if (html && extractVideoIdFromPlayerResponse(html) === id) source = html;
    }
    if (!source) return null;
    const track = pickCaptionTrack(extractCaptionTracks(source), navigator.language);
    if (!track) return null;
    const cues = await this.fetchTrackCues(track);
    if (cues) {
      console.warn(
        `[kedaibiao] YouTube 字幕（captionTracks ${track.languageCode}${track.kind === 'asr' ? '/自动生成' : ''}）：${cues.length} 条`,
      );
    }
    return cues;
  }

  private playerResponseFromDom(videoId: string): string | null {
    for (const script of Array.from(document.scripts)) {
      const text = script.textContent ?? '';
      if (!text.includes('"captionTracks"')) continue;
      if (extractVideoIdFromPlayerResponse(text) !== videoId) continue;
      return text;
    }
    return null;
  }

  /** 同源重拉 watch HTML（带登录态，会员/登录可见视频同样适用） */
  private async fetchWatchHtml(): Promise<string | null> {
    try {
      const resp = await fetch(location.href, { credentials: 'include' });
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      return null;
    }
  }

  /** 先 JSON3（结构化更稳），空响应退默认 XML */
  private async fetchTrackCues(track: CaptionTrack): Promise<SubtitleCue[] | null> {
    const json3Text = await this.fetchTimedtext(`${track.baseUrl}&fmt=json3`);
    if (json3Text) {
      const cues = parseTimedtextJson3(json3Text);
      if (cues.length > 0) return cues;
    }
    const xmlText = await this.fetchTimedtext(track.baseUrl);
    if (xmlText) {
      const cues = parseTimedtextXml(xmlText);
      if (cues.length > 0) return cues;
    }
    return null;
  }

  private async fetchTimedtext(url: string): Promise<string | null> {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return null;
      const text = await resp.text();
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  private logDiagnostics(): void {
    const captured = getCapturedSubtitlePayloads();
    console.warn('[kedaibiao] YouTube 字幕诊断 ==========');
    console.warn(`hasVideo: ${Boolean(this.getVideoEl())}, videoId: ${this.videoId() ?? '无'}`);
    console.warn(`拦截器捕获 ${captured.length} 条：`);
    for (const p of captured.slice(-10)) console.warn(`  ${p.url}`);
    console.warn('[kedaibiao] 诊断结束 ==========');
  }

  /** YouTube 原生支持时间戳深链 ?t=Ns */
  makeJumpUrl(sec: number): string {
    const id = this.videoId();
    const t = Math.max(0, Math.floor(sec));
    if (!id) return location.href.split('#')[0] ?? location.href;
    return `https://www.youtube.com/watch?v=${id}&t=${t}s`;
  }

  async captureFrame(): Promise<Blob> {
    const video = this.getVideoEl();
    if (!video) throw new Error('err.noVideoElement');
    return (await captureVideoFrame(video)).blob;
  }
}
