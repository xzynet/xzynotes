import { describe, expect, it } from 'vitest';
import { buildSubtitleIndex, tokenizeForCjk } from '../../core/search';
import type { SubtitleCue } from '../../core/models';

const cues: SubtitleCue[] = [
  { start: 0, end: 5, text: '大家好，今天我们学习导数的定义' },
  { start: 5, end: 10, text: '导数的几何意义是切线斜率' },
  { start: 10, end: 15, text: 'Let us review the definition of Limit' },
  { start: 15, end: 20, text: '接下来看几道例题' },
];

describe('tokenizeForCjk', () => {
  it('拉丁整词 + CJK 单字 + CJK 二字词', () => {
    const tokens = tokenizeForCjk('学习abc123');
    expect(tokens).toContain('abc123');
    expect(tokens).toContain('学');
    expect(tokens).toContain('习');
    expect(tokens).toContain('学习');
  });

  it('转小写', () => {
    expect(tokenizeForCjk('ABC')).toContain('abc');
  });

  it('标点不产生 token', () => {
    expect(tokenizeForCjk('，。！？')).toEqual([]);
  });
});

describe('buildSubtitleIndex', () => {
  const index = buildSubtitleIndex(cues);

  it('size 为分句数', () => {
    expect(index.size).toBe(4);
  });

  it('中文短语命中全部相关分句', () => {
    const hits = index.search('导数');
    expect(hits.map((h) => h.sec).sort((a, b) => a - b)).toEqual([0, 5]);
  });

  it('AND 语义：二字词不全的分句被排除', () => {
    // 「导数的定义」只在第 0 条完整出现；第 1 条缺少「数定」二字词
    const hits = index.search('导数的定义');
    expect(hits.map((h) => h.sec)).toEqual([0]);
  });

  it('英文检索大小写不敏感', () => {
    const hits = index.search('limit');
    expect(hits.map((h) => h.sec)).toEqual([10]);
    expect(hits[0]?.text).toContain('Limit');
  });

  it('单字检索有召回', () => {
    const hits = index.search('例');
    expect(hits.map((h) => h.sec)).toEqual([15]);
  });

  it('空查询返回空', () => {
    expect(index.search('')).toEqual([]);
    expect(index.search('   ')).toEqual([]);
  });

  it('无匹配返回空', () => {
    expect(index.search('泰勒公式')).toEqual([]);
  });

  it('limit 生效', () => {
    expect(index.search('导数', 1)).toHaveLength(1);
  });

  it('空索引可用', () => {
    const empty = buildSubtitleIndex([]);
    expect(empty.size).toBe(0);
    expect(empty.search('导数')).toEqual([]);
  });
});
