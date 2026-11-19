import { translate, type Locale } from '~/core/i18n';
import type { SubtitleCue } from '../models/subtitle';

/** 弹幕密度采样点（B站 adapter 提供） */
export interface DensityPoint {
  sec: number;
  count: number;
}

/** 章节切分结果（id/courseId 由调用方补齐，source 固定 'rule'） */
export interface ChapterDraft {
  title: string;
  startSec: number;
}

export interface SegmentChaptersOptions {
  /** 单节最短时长（秒），过短合并，默认 60 */
  minDurationSec?: number;
  /** 单节最长时长（秒），过长二分，默认 600 */
  maxDurationSec?: number;
  /** 停顿边界阈值（秒），默认 3 */
  pauseThresholdSec?: number;
  /** 弹幕密度数据，存在时对切分点做峰值微调 */
  danmaku?: DensityPoint[];
  /** 弹幕微调窗口（秒），默认 15 */
  danmakuWindowSec?: number;
}

const DEFAULT_MIN = 60;
const DEFAULT_MAX = 600;
const DEFAULT_PAUSE = 3;
const DEFAULT_DANMAKU_WINDOW = 15;
const MAX_TITLE_LEN = 20;
/** 防御性上限：时长收敛循环的迭代上限 */
const MAX_ITERATIONS = 50;

/** 话题转换词：出现在分句开头时视为候选边界 */
const TOPIC_MARKERS = [
  '接下来', '下面我们', '下面', '下一节', '下一段', '我们来看', '我们再来看', '再来看',
  '本章', '本节课', '第二部分', '第三部分', '第四部分', '第五部分',
  '第二章', '第三章', '第四章', '第五章', '第六章', '第七章', '第八章',
  '总结一下', '小结一下', '好我们', '那我们',
];

/** 标题清洗：需剥离的开头语气词/口水词（长词优先） */
const FILLER_PREFIXES = [
  '所以说', '所以呢', '接下来', '今天我们', '我们今天', '我们现在', '下面我们',
  '所以', '然后', '今天', '现在', '下面', '我们', '大家', '各位',
  '好的', '好吧', '好啊', '那么', '就是',
  '好', '那', '呃', '嗯', '啊', '唉', '哎', '哦', '噢', '呢', '吧', '嘛', '请', '来',
];

/** 标题清洗：需剥离的结尾语气词 */
const TRAILING_FILLERS = /[的吧啊呢嘛哦哈啦呀了]+$/;
const LEADING_PUNCT = /^[，,、。：:；;！!？?~～…\s]+/;
const SENTENCE_END = /[。！？!?；;]/;
/** 全角空白字符（U+3000），避免源码直接出现 irregular whitespace */
const FULL_WIDTH_SPACE = String.fromCharCode(0x3000);
/** 半角/全角空白 */
const WHITESPACE = new RegExp(`[\\s${FULL_WIDTH_SPACE}]+`, 'g');

interface Segment {
  cues: SubtitleCue[];
}

function firstCue(seg: Segment, locale: Locale = 'zh-CN'): SubtitleCue {
  const c = seg.cues[0];
  if (!c) throw new Error(translate(locale, 'chapters.emptySegment'));
  return c;
}

function segDuration(seg: Segment, locale: Locale = 'zh-CN'): number {
  const first = firstCue(seg, locale);
  const last = seg.cues[seg.cues.length - 1] ?? first;
  return last.end - first.start;
}

/** 排序、去空文本、保证 end >= start */
export function normalizeCues(cues: SubtitleCue[]): SubtitleCue[] {
  return cues
    .filter((c) => c.text.trim().length > 0)
    .map((c) => ({ ...c, end: Math.max(c.end, c.start) }))
    .sort((a, b) => a.start - b.start);
}

function startsWithTopicMarker(text: string): boolean {
  const t = text.trimStart();
  return TOPIC_MARKERS.some((m) => t.startsWith(m));
}

/** 第一步：停顿 > 阈值 或 话题转换词，且当前段已满足最短时长时落刀 */
function initialCut(cues: SubtitleCue[], minDur: number, pause: number): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  for (let i = 1; i < cues.length; i++) {
    const prev = cues[i - 1];
    const current = cues[i];
    const segStart = cues[start];
    if (!prev || !current || !segStart) continue;
    const gap = current.start - prev.end;
    const isCandidate = gap > pause || startsWithTopicMarker(current.text);
    if (isCandidate && current.start - segStart.start >= minDur) {
      segments.push({ cues: cues.slice(start, i) });
      start = i;
    }
  }
  segments.push({ cues: cues.slice(start) });
  return segments;
}

/** 在靠近中点的分句边界处二分 */
function bisect(seg: Segment, locale: Locale = 'zh-CN'): [Segment, Segment] {
  const { cues } = seg;
  const mid = firstCue(seg, locale).start + segDuration(seg, locale) / 2;
  let idx = cues.findIndex((c) => c.start >= mid);
  idx = Math.min(Math.max(idx, 1), cues.length - 1);
  return [{ cues: cues.slice(0, idx) }, { cues: cues.slice(idx) }];
}

/** 第二步：时长收敛——超长二分、超短合并，直到全部落在 [min, max] */
function enforceDurations(
  segments: Segment[],
  minDur: number,
  maxDur: number,
  locale: Locale = 'zh-CN',
): Segment[] {
  let segs = segments.slice();
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const overIdx = segs.findIndex((s) => segDuration(s, locale) > maxDur);
    if (overIdx >= 0) {
      const over = segs[overIdx];
      if (!over) break;
      const [a, b] = bisect(over, locale);
      segs = [...segs.slice(0, overIdx), a, b, ...segs.slice(overIdx + 1)];
      continue;
    }
    const underIdx = segs.findIndex((s) => segDuration(s, locale) < minDur);
    if (underIdx < 0 || segs.length <= 1) break;
    // 优先并入前一段，首段则并入后一段
    const target = underIdx > 0 ? underIdx - 1 : 1;
    const a = segs[target];
    const b = segs[underIdx];
    if (!a || !b) break;
    const merged: Segment = {
      cues: target < underIdx ? [...a.cues, ...b.cues] : [...b.cues, ...a.cues],
    };
    segs = segs.filter((_, i) => i !== underIdx && i !== target);
    segs.splice(Math.min(target, underIdx), 0, merged);
  }
  return segs;
}

/** 第三步：弹幕密度峰值对切分点做窗口内微调 */
function applyDanmaku(
  segments: Segment[],
  density: DensityPoint[],
  windowSec: number,
  minDur: number,
  maxDur: number,
  locale: Locale = 'zh-CN',
): Segment[] {
  const segs = segments.slice();
  for (let k = 0; k < segs.length - 1; k++) {
    const left = segs[k];
    const right = segs[k + 1];
    if (!left || !right) continue;
    const boundary = firstCue(right, locale).start;
    const nearby = density.filter((p) => Math.abs(p.sec - boundary) <= windowSec);
    if (nearby.length === 0) continue;
    const peak = nearby.reduce((a, b) => (b.count > a.count ? b : a));
    if (peak.count <= 0 || peak.sec === boundary) continue;

    const all = [...left.cues, ...right.cues];
    const j = all.findIndex((c) => c.start >= peak.sec);
    if (j <= 0 || j >= all.length) continue;
    const newLeft: Segment = { cues: all.slice(0, j) };
    const newRight: Segment = { cues: all.slice(j) };
    // 微调不得破坏时长约束
    const dl = segDuration(newLeft, locale);
    const dr = segDuration(newRight, locale);
    if (dl < minDur || dl > maxDur || dr < minDur || dr > maxDur) continue;
    segs[k] = newLeft;
    segs[k + 1] = newRight;
  }
  return segs;
}

function cleanupTitle(raw: string): string {
  let t = raw.replace(WHITESPACE, ' ').trim();
  for (;;) {
    t = t.replace(LEADING_PUNCT, '');
    const filler = FILLER_PREFIXES.find((f) => t.startsWith(f));
    if (!filler) break;
    t = t.slice(filler.length).trimStart();
  }
  return t.replace(TRAILING_FILLERS, '').trim();
}

/** 标题 = 该节字幕首句主干（去语气词，≤20 字） */
export function makeChapterTitle(cues: SubtitleCue[], locale: Locale = 'zh-CN'): string {
  const raw = cues.map((c) => c.text.trim()).join(' ');
  const endIdx = raw.search(SENTENCE_END);
  const sentence = endIdx >= 0 ? raw.slice(0, endIdx) : raw;
  const title = cleanupTitle(sentence) || cleanupTitle(raw);
  if (!title) return translate(locale, 'chapters.untitled');
  return Array.from(title).slice(0, MAX_TITLE_LEN).join('');
}

/**
 * 规则版章节切分：纯函数，不依赖任何浏览器 API。
 * 流程：归一化 → 语义边界初切 → 时长收敛（过短合并/过长二分）→ 弹幕峰值微调 → 生成标题。
 */
export function segmentChapters(
  cues: SubtitleCue[],
  options: SegmentChaptersOptions = {},
  locale: Locale = 'zh-CN',
): ChapterDraft[] {
  const minDur = options.minDurationSec ?? DEFAULT_MIN;
  const maxDur = Math.max(options.maxDurationSec ?? DEFAULT_MAX, minDur * 2);
  const pause = options.pauseThresholdSec ?? DEFAULT_PAUSE;
  const danmakuWindow = options.danmakuWindowSec ?? DEFAULT_DANMAKU_WINDOW;

  const norm = normalizeCues(cues);
  if (norm.length === 0) return [];

  let segments = initialCut(norm, minDur, pause);
  segments = enforceDurations(segments, minDur, maxDur, locale);
  if (options.danmaku && options.danmaku.length > 0) {
    segments = applyDanmaku(segments, options.danmaku, danmakuWindow, minDur, maxDur, locale);
  }

  return segments.map((seg) => ({
    title: makeChapterTitle(seg.cues, locale),
    startSec: Math.floor(firstCue(seg, locale).start),
  }));
}

/**
 * 把字幕按章节起点归组：cue 属于最后一个 startSec <= cue.start 的章节。
 * 首个章节之前的字幕不归属任何章（结果中省略）。语义与导出时的归属规则一致。
 */
export function groupCuesByChapter(
  chapters: { id: string; startSec: number }[],
  cues: SubtitleCue[],
): Map<string, SubtitleCue[]> {
  const sorted = [...chapters].sort((a, b) => a.startSec - b.startSec);
  const result = new Map<string, SubtitleCue[]>();
  if (sorted.length === 0) return result;
  let idx = -1;
  for (const cue of normalizeCues(cues)) {
    while (idx + 1 < sorted.length && (sorted[idx + 1]?.startSec ?? Infinity) <= cue.start) {
      idx++;
    }
    if (idx < 0) continue;
    const ch = sorted[idx];
    if (!ch) continue;
    const list = result.get(ch.id) ?? [];
    list.push(cue);
    result.set(ch.id, list);
  }
  return result;
}
