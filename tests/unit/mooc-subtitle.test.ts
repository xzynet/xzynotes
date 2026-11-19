import { describe, expect, it } from 'vitest';
import { cuesFromMergedSentences } from '../../adapters/platforms/icourse163';

/** 2026-09-03 实测 getVideoSubtitle.rpc 的 mergedSentences 结构（人工智能概论课程） */
const REAL_SAMPLE = [
  [
    {
      beginTime: 0,
      sentences: [
        { beginTime: 3562, endTime: 9780, sequence: 1, text: '知识图谱的构建过程包括知识建模，' },
        { beginTime: 9780, endTime: 11400, sequence: 2, text: '知识获取，' },
        { beginTime: 9930, endTime: 11400, sequence: 3, text: '知识管理和知识赋能这几个步骤。' },
      ],
    },
  ],
];

describe('MOOC mergedSentences 映射', () => {
  it('按实测结构解析：段落.sentences → 分句，毫秒 → 秒', () => {
    expect(cuesFromMergedSentences(REAL_SAMPLE)).toEqual([
      { start: 3.562, end: 9.78, text: '知识图谱的构建过程包括知识建模，' },
      { start: 9.78, end: 11.4, text: '知识获取，' },
      { start: 9.93, end: 11.4, text: '知识管理和知识赋能这几个步骤。' },
    ]);
  });

  it('空/非法输入 → 空数组', () => {
    expect(cuesFromMergedSentences(undefined)).toEqual([]);
    expect(cuesFromMergedSentences(null)).toEqual([]);
    expect(cuesFromMergedSentences([])).toEqual([]);
    expect(cuesFromMergedSentences('不是数组')).toEqual([]);
    expect(cuesFromMergedSentences([{ foo: 'bar' }])).toEqual([]);
  });

  it('空文本句子被过滤', () => {
    const sample = [
      [{ beginTime: 0, sentences: [{ beginTime: 1000, endTime: 2000, sequence: 1, text: '  ' }] }],
    ];
    expect(cuesFromMergedSentences(sample)).toEqual([]);
  });
});
