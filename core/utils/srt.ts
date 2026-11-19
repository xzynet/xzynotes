import type { SubtitleCue } from '../models';

/** 不可见字符用码点构造，避免源码中出现 NUL / U+FFFD 字面量 */
const NUL = String.fromCharCode(0);
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * 字幕文件字节流解码。网课平台的 SRT 常见编码混杂（MOOC 实测为 UTF-16LE），
 * 按 BOM 嗅探，并对误判做兜底：UTF-16 被按 UTF-8 解码会出现大量 NUL/替换符。
 */
export function decodeSubtitleBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const replacementCount = utf8.split(REPLACEMENT_CHAR).length - 1;
  if (utf8.includes(NUL) || replacementCount > 3) {
    return new TextDecoder('utf-16le').decode(buf);
  }
  return utf8;
}

/**
 * SRT / WebVTT 字幕文件解析（纯函数）。
 * SRT: `00:00:01,000 --> 00:00:04,000`（逗号毫秒）
 * VTT: `00:00:01.000 --> 00:00:04.000`（点号毫秒，可带位置参数）
 */

const ARROW_LINE = /^(\S+)\s*-->\s*(\S+)/;
const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/;

/** 'HH:MM:SS,mmm' / 'MM:SS.mmm' → 秒（float）；非法返回 NaN */
function parseTimestamp(raw: string): number {
  const m = TIMESTAMP.exec(raw.trim());
  if (!m) return NaN;
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = Number((m[4] ?? '0').padEnd(3, '0'));
  if (minutes > 59 || seconds > 59) return NaN;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/** 解析 SRT/VTT 文本为分句列表；无法识别时返回空数组 */
export function parseSubtitleText(text: string): SubtitleCue[] {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const cleaned = noBom.replace(/\r\n?/g, '\n');
  const blocks = cleaned.split(/\n\s*\n/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue; // SRT 序号行 / VTT 头部块自动跳过
    const arrow = ARROW_LINE.exec(lines[timeIdx] ?? '');
    if (!arrow) continue;
    const start = parseTimestamp(arrow[1] ?? '');
    const end = parseTimestamp(arrow[2] ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const cueText = lines
      .slice(timeIdx + 1)
      .join(' ')
      .trim();
    if (!cueText) continue;
    cues.push({ start, end, text: cueText });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * 列式字幕 JSON（学堂在线 subtitle_parse 实测）：
 * { start: number[], end: number[], text: string[] }，时间通常为毫秒。
 * 单位判定：最大值远超视频时长 → 毫秒；无时长信息时 > 7200 视为毫秒。
 * 常见信封结构 { code, result: {...} }（MOOC/智慧树 API 通用）下钻一层再试。
 */
export function parseColumnarSubtitleJson(
  text: string,
  videoDurationSec?: number,
): SubtitleCue[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return [];
  const candidates: Record<string, unknown>[] = [json as Record<string, unknown>];
  for (const v of Object.values(json as Record<string, unknown>)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      candidates.push(v as Record<string, unknown>);
    }
  }
  for (const o of candidates) {
    const cues = columnarFromObject(o, videoDurationSec);
    if (cues.length > 0) return cues;
  }
  return [];
}

/** 在单个对象的字段里找 start/end/text 平行数组 */
function columnarFromObject(
  o: Record<string, unknown>,
  videoDurationSec?: number,
): SubtitleCue[] {
  const pick = (...keys: string[]): unknown[] | null => {
    for (const k of keys) {
      const v = o[k];
      if (Array.isArray(v) && v.length > 0) return v;
    }
    return null;
  };
  const starts = pick('start', 'startTime', 'start_time', 'begin');
  const ends = pick('end', 'endTime', 'end_time');
  const texts = pick('text', 'content', 'sentence', 'texts');
  if (!starts || !ends || !texts) return [];
  const maxStart = Math.max(0, ...starts.map((v) => Number(v)).filter(Number.isFinite));
  const isMs =
    videoDurationSec !== undefined && Number.isFinite(videoDurationSec)
      ? maxStart > videoDurationSec * 3
      : maxStart > 7200;
  const div = isMs ? 1000 : 1;
  const n = Math.min(starts.length, ends.length, texts.length);
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < n; i++) {
    const start = Number(starts[i]);
    const end = Number(ends[i]);
    const t = texts[i];
    if (!Number.isFinite(start) || !Number.isFinite(end) || typeof t !== 'string' || !t.trim()) {
      continue;
    }
    cues.push({ start: start / div, end: end / div, text: t.trim() });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * 行式字幕 JSON：[{ start, end, text }, ...] 或嵌套在 { result: { list: [...] } } 里。
 * 递归扫描所有数组，取「元素对象带起始时间字段 + 文本字段」且条数最多者。
 * end 缺省时用下一句 start 兜底（末句 +5s）；毫秒/秒单位判定同列式。
 */
export function parseRowSubtitleJson(text: string, videoDurationSec?: number): SubtitleCue[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof json !== 'object' || json === null) return [];

  const START_KEYS = ['start', 'startTime', 'start_time', 'begin', 'beginTime'];
  const END_KEYS = ['end', 'endTime', 'end_time'];
  const TEXT_KEYS = ['text', 'content', 'sentence'];
  const num = (o: Record<string, unknown>, keys: string[]): number | null => {
    for (const k of keys) {
      const v = Number(o[k]);
      if (Number.isFinite(v)) return v;
    }
    return null;
  };
  const str = (o: Record<string, unknown>, keys: string[]): string | null => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };

  let best: { start: number; end: number | null; text: string }[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 6 || typeof v !== 'object' || v === null) return;
    if (Array.isArray(v)) {
      const rows: { start: number; end: number | null; text: string }[] = [];
      for (const item of v) {
        if (typeof item !== 'object' || item === null) break;
        const o = item as Record<string, unknown>;
        const start = num(o, START_KEYS);
        const t = str(o, TEXT_KEYS);
        if (start === null || t === null) break;
        rows.push({ start, end: num(o, END_KEYS), text: t });
      }
      if (rows.length > best.length) best = rows;
      // 数组元素里可能还有嵌套（如 MOOC 的段落.sentences）
      for (const item of v) visit(item, depth + 1);
      return;
    }
    for (const child of Object.values(v)) visit(child, depth + 1);
  };
  visit(json, 0);

  if (best.length === 0) return [];
  const maxStart = Math.max(0, ...best.map((r) => r.start));
  const isMs =
    videoDurationSec !== undefined && Number.isFinite(videoDurationSec)
      ? maxStart > videoDurationSec * 3
      : maxStart > 7200;
  const div = isMs ? 1000 : 1;
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < best.length; i++) {
    const row = best[i]!;
    const start = row.start / div;
    const fallbackEnd = row.start + (isMs ? 5000 : 5);
    const end = row.end !== null ? row.end / div : (best[i + 1]?.start ?? fallbackEnd) / div;
    if (end > start) cues.push({ start, end, text: row.text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** 统一字幕解析：先 SRT/VTT，再列式 JSON（学堂在线），最后行式 JSON（对象数组） */
export function parseAnySubtitle(text: string, videoDurationSec?: number): SubtitleCue[] {
  const srt = parseSubtitleText(text);
  if (srt.length > 0) return srt;
  const columnar = parseColumnarSubtitleJson(text, videoDurationSec);
  if (columnar.length > 0) return columnar;
  return parseRowSubtitleJson(text, videoDurationSec);
}

/**
 * 剥 JSONP 外壳：`jQuery3510...({...});` → `{...}`（智慧树 subtitleV1 为 JSONP 接口）。
 * 非 JSONP 形态返回 null。
 */
export function unwrapJsonp(text: string): string | null {
  const m = /^\s*[\w$.]+\s*\(([\s\S]*)\)\s*;?\s*$/.exec(text);
  const inner = m?.[1]?.trim();
  return inner ? inner : null;
}
