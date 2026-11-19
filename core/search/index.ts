import { Index } from 'flexsearch';
import type { SubtitleCue } from '../models';

/** 字幕检索命中项 */
export interface SearchHit {
  /** 命中分句的开始时间（秒） */
  sec: number;
  /** 命中分句文本 */
  text: string;
}

export interface SubtitleSearch {
  /** 索引中的分句数 */
  readonly size: number;
  search(query: string, limit?: number): SearchHit[];
}

/** CJK 连续字符段（中文/日文假名/兼容汉字） */
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿]+/g;
/** 拉丁字母/数字整词 */
const LATIN_WORD = /[a-z0-9]+/g;

/**
 * CJK 友好分词：拉丁整词 + CJK 单字 + CJK 相邻二字词。
 * FlexSearch 默认编码器把整段中文当成一个词，无法检索，必须自定义。
 * FlexSearch 0.8 默认 AND 语义：查询的所有 token 都命中才算匹配，
 * 二字词保证短语精度，单字保证召回。
 */
export function tokenizeForCjk(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const m of lower.matchAll(LATIN_WORD)) tokens.push(m[0]);
  for (const runMatch of lower.matchAll(CJK_RUN)) {
    const chars = Array.from(runMatch[0]);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (!ch) continue;
      tokens.push(ch);
      const next = chars[i + 1];
      if (next) tokens.push(ch + next);
    }
  }
  return tokens;
}

/**
 * 用字幕分句构建全文检索索引。纯内存结构，随面板生命周期创建。
 * id 使用分句下标，命中后回表取 start/text。
 */
export function buildSubtitleIndex(cues: SubtitleCue[]): SubtitleSearch {
  const index = new Index({ encode: tokenizeForCjk });
  cues.forEach((c, i) => index.add(i, c.text));
  return {
    size: cues.length,
    search(query, limit = 50) {
      const q = query.trim();
      if (!q) return [];
      const ids = index.search(q, { limit }) as number[];
      const hits: SearchHit[] = [];
      for (const id of ids) {
        const cue = cues[Number(id)];
        if (cue) hits.push({ sec: cue.start, text: cue.text });
      }
      return hits;
    },
  };
}
