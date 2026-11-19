import { z } from 'zod';
import { normalizeCues } from '../chapters';
import { translate, type Locale } from '../i18n';
import type { SubtitleCue } from '../models/subtitle';

/**
 * AI 章节切分：prompt 构造与响应解析。
 * 纯函数模块，不含任何网络/浏览器 API（网络调用见 client.ts）。
 */

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** AI 返回的单章草稿（id/courseId 由调用方补齐，source 固定 'ai'） */
export interface AiChapterDraft {
  startSec: number;
  title: string;
  summary: string;
}

export interface AiChunkResult {
  overview?: string;
  chapters: AiChapterDraft[];
}

/** 单块字幕字符预算（含时间戳前缀），照顾中小上下文模型 */
export const DEFAULT_CHUNK_CHARS = 12000;
/** 合并后章节的最短时长（秒），过短并入相邻章 */
export const MIN_AI_CHAPTER_SEC = 60;
/** 跨块边界去重窗口（秒）：两块给出几乎相同的切点视为同一刀 */
export const BOUNDARY_DEDUPE_SEC = 5;

function formatSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 转写为 `[mm:ss] 文本` 逐行格式（先归一化：排序、去空） */
export function formatTranscript(cues: SubtitleCue[]): string {
  return normalizeCues(cues)
    .map((c) => `[${formatSec(c.start)}] ${c.text.trim()}`)
    .join('\n');
}

/** 按字符预算把字幕切成有序分块；单句超长时独占一块 */
export function chunkCues(cues: SubtitleCue[], maxChars = DEFAULT_CHUNK_CHARS): SubtitleCue[][] {
  const norm = normalizeCues(cues);
  const chunks: SubtitleCue[][] = [];
  let current: SubtitleCue[] = [];
  let size = 0;
  for (const cue of norm) {
    const lineLen = formatSec(cue.start).length + cue.text.trim().length + 4;
    if (current.length > 0 && size + lineLen > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(cue);
    size += lineLen;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface BuildMessagesInput {
  transcript: string;
  courseTitle: string;
  chunkIndex: number;
  chunkCount: number;
  /** 单块（或最后一块）时要求输出整课概述 */
  withOverview: boolean;
}

/** 构造单个分块的章节切分请求消息；prompt 文案按 locale 取双语模板（AI 输出语言随之切换） */
export function buildChapterMessages(
  input: BuildMessagesInput,
  locale: Locale = 'zh-CN',
): ChatMessage[] {
  const chunkNote =
    input.chunkCount > 1
      ? translate(locale, 'ai.chunkNote', {
          index: input.chunkIndex + 1,
          count: input.chunkCount,
        })
      : '';
  const overviewNote = input.withOverview ? translate(locale, 'ai.overviewNote') : '';
  // 模板按行切分后丢空行：chunkNote 缺省时整行消失，与历史拼装结果一致
  const user = translate(locale, 'ai.userPrompt', {
    courseTitle: input.courseTitle,
    chunkNote,
    overviewNote,
    minSec: MIN_AI_CHAPTER_SEC,
    transcript: input.transcript,
  })
    .split('\n')
    .filter((line) => line.length > 0)
    .join('\n');
  return [
    { role: 'system', content: translate(locale, 'ai.systemPrompt') },
    { role: 'user', content: user },
  ];
}

const AiChapterDraftSchema = z.object({
  startSec: z.number().nonnegative(),
  title: z.string().min(1),
  summary: z.string().default(''),
});

const AiChunkResultSchema = z.object({
  overview: z.string().optional(),
  chapters: z.array(AiChapterDraftSchema).min(1),
});

/** 从模型输出中提取 JSON：容忍 ```json 围栏与前后噪声 */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('aiErr.parseNoJson');
  return body.slice(start, end + 1);
}

/** 解析模型返回为章节草稿；失败抛文案 key（aiErr.*，展示端 localizeError 翻译） */
export function parseAiChapters(text: string): AiChunkResult {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (e) {
    if (e instanceof Error && e.message === 'aiErr.parseNoJson') throw e;
    throw new Error('aiErr.parseInvalidJson', { cause: e });
  }
  const result = AiChunkResultSchema.safeParse(raw);
  if (!result.success) throw new Error('aiErr.parseBadShape');
  return result.data;
}

/**
 * 合并多个分块的切分结果：按 startSec 排序、近重复边界去重、
 * 过短章节并入相邻章（摘要拼接）；overview 取首个非空值。
 */
export function mergeAiChunks(
  results: AiChunkResult[],
  minDurationSec = MIN_AI_CHAPTER_SEC,
): { overview: string; chapters: AiChapterDraft[] } {
  const sorted = results
    .flatMap((r) => r.chapters)
    .sort((a, b) => a.startSec - b.startSec);

  const deduped: AiChapterDraft[] = [];
  for (const ch of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && ch.startSec - prev.startSec < BOUNDARY_DEDUPE_SEC) continue;
    deduped.push(ch);
  }

  // 过短合并：章节时长 = 下一章 startSec - 本章 startSec；末章不设上限。
  // 有过前章则并入前章（摘要后拼）；首章过短则并入后章（起点提前、摘要前拼）。
  const merged: AiChapterDraft[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const ch = deduped[i];
    if (!ch) continue;
    const next = deduped[i + 1];
    const duration = next ? next.startSec - ch.startSec : Number.POSITIVE_INFINITY;
    if (duration >= minDurationSec) {
      merged.push({ ...ch });
      continue;
    }
    const prev = merged[merged.length - 1];
    if (prev) {
      prev.summary = [prev.summary, ch.summary].filter((s) => s.length > 0).join(' ');
    } else if (next) {
      next.startSec = ch.startSec;
      next.summary = [ch.summary, next.summary].filter((s) => s.length > 0).join(' ');
    } else {
      merged.push({ ...ch });
    }
  }

  const overview = results.map((r) => r.overview?.trim() ?? '').find((s) => s.length > 0) ?? '';
  return { overview, chapters: merged };
}
