import { describe, expect, it } from 'vitest';
import {
  buildChapterMessages,
  chunkCues,
  formatTranscript,
  mergeAiChunks,
  parseAiChapters,
  type AiChunkResult,
} from '../../core/ai/prompt';
import type { SubtitleCue } from '../../core/models';

const cue = (start: number, text = '讲解内容', end?: number): SubtitleCue => ({
  start,
  end: end ?? start + 5,
  text,
});

describe('formatTranscript', () => {
  it('输出 [mm:ss] 文本 逐行，并按时间排序', () => {
    const t = formatTranscript([cue(65, '第二句'), cue(5, '第一句'), cue(3661, '一小时后')]);
    expect(t).toBe(['[00:05] 第一句', '[01:05] 第二句', '[1:01:01] 一小时后'].join('\n'));
  });

  it('跳过空文本分句', () => {
    expect(formatTranscript([cue(0, '  '), cue(3, '有效')])).toBe('[00:03] 有效');
  });
});

describe('chunkCues', () => {
  it('空输入返回空数组', () => {
    expect(chunkCues([])).toEqual([]);
  });

  it('按字符预算分块且保持顺序', () => {
    const cues = Array.from({ length: 100 }, (_, i) => cue(i * 10, `第${i}句讲解内容`));
    const chunks = chunkCues(cues, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(formatTranscript(chunk).length).toBeLessThanOrEqual(600);
    }
    expect(chunks.flat().map((c) => c.start)).toEqual(cues.map((c) => c.start));
  });

  it('单块不超预算时不切分', () => {
    expect(chunkCues([cue(0), cue(5)], 10000)).toHaveLength(1);
  });
});

describe('buildChapterMessages', () => {
  it('包含课程标题与 JSON 输出要求', () => {
    const msgs = buildChapterMessages({
      transcript: '[00:00] 开场',
      courseTitle: '高等数学',
      chunkIndex: 0,
      chunkCount: 1,
      withOverview: true,
    });
    expect(msgs[0]?.role).toBe('system');
    const user = msgs[1]?.content ?? '';
    expect(user).toContain('高等数学');
    expect(user).toContain('chapters');
    expect(user).toContain('overview');
    expect(user).toContain('[00:00] 开场');
  });

  it('多块时标注分块序号且不要求概述', () => {
    const msgs = buildChapterMessages({
      transcript: 'x',
      courseTitle: 't',
      chunkIndex: 1,
      chunkCount: 3,
      withOverview: false,
    });
    const user = msgs[1]?.content ?? '';
    expect(user).toContain('第 2/3 段');
    expect(user).toContain('绝对秒数');
    expect(user).not.toContain('overview');
  });
});

describe('parseAiChapters', () => {
  it('解析纯 JSON', () => {
    const r = parseAiChapters(
      '{"overview":"概述","chapters":[{"startSec":0,"title":"开场","summary":"介绍"}]}',
    );
    expect(r.overview).toBe('概述');
    expect(r.chapters).toEqual([{ startSec: 0, title: '开场', summary: '介绍' }]);
  });

  it('容忍 ```json 围栏与前后噪声', () => {
    const r = parseAiChapters(
      '好的，以下是结果：\n```json\n{"chapters":[{"startSec":90,"title":"极限","summary":"极限概念"}]}\n```\n希望有帮助',
    );
    expect(r.chapters[0]?.startSec).toBe(90);
    expect(r.overview).toBeUndefined();
  });

  it('summary 缺省补空串', () => {
    const r = parseAiChapters('{"chapters":[{"startSec":0,"title":"t"}]}');
    expect(r.chapters[0]?.summary).toBe('');
  });

  it('非法 JSON 抛解析错误 key', () => {
    expect(() => parseAiChapters('无法完成')).toThrow('aiErr.parseNoJson');
    expect(() => parseAiChapters('{broken}')).toThrow('aiErr.parseInvalidJson');
  });

  it('拒绝负 startSec 与空章节数组', () => {
    expect(() => parseAiChapters('{"chapters":[{"startSec":-1,"title":"t"}]}')).toThrow(
      'aiErr.parseBadShape',
    );
    expect(() => parseAiChapters('{"chapters":[]}')).toThrow('aiErr.parseBadShape');
  });
});

describe('mergeAiChunks', () => {
  const chunk = (overview: string | undefined, chapters: AiChunkResult['chapters']): AiChunkResult =>
    overview === undefined ? { chapters } : { overview, chapters };

  it('跨块按 startSec 排序，overview 取首个非空', () => {
    const { overview, chapters } = mergeAiChunks([
      chunk('', [{ startSec: 300, title: 'B', summary: 'b' }]),
      chunk('概述', [{ startSec: 0, title: 'A', summary: 'a' }]),
    ]);
    expect(overview).toBe('概述');
    expect(chapters.map((c) => c.title)).toEqual(['A', 'B']);
  });

  it('5 秒内的近重复边界去重', () => {
    const { chapters } = mergeAiChunks([
      chunk(undefined, [
        { startSec: 100, title: 'A', summary: 'a' },
        { startSec: 103, title: 'B', summary: 'b' },
      ]),
    ]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.title).toBe('A');
  });

  it('中间章过短并入前章且摘要拼接', () => {
    const { chapters } = mergeAiChunks(
      [
        chunk(undefined, [
          { startSec: 0, title: 'A', summary: '甲' },
          { startSec: 300, title: 'B', summary: '乙' },
          { startSec: 320, title: 'C', summary: '丙' },
        ]),
      ],
      60,
    );
    expect(chapters.map((c) => c.title)).toEqual(['A', 'C']);
    expect(chapters[0]?.summary).toBe('甲 乙');
  });

  it('首章过短并入后章：起点提前、摘要前置', () => {
    const { chapters } = mergeAiChunks(
      [
        chunk(undefined, [
          { startSec: 0, title: 'A', summary: '甲' },
          { startSec: 30, title: 'B', summary: '乙' },
          { startSec: 400, title: 'C', summary: '丙' },
        ]),
      ],
      60,
    );
    expect(chapters.map((c) => c.title)).toEqual(['B', 'C']);
    expect(chapters[0]?.startSec).toBe(0);
    expect(chapters[0]?.summary).toBe('甲 乙');
  });

  it('首章过短且无前章时保留', () => {
    const { chapters } = mergeAiChunks(
      [chunk(undefined, [{ startSec: 0, title: '唯一章', summary: 's' }])],
      60,
    );
    expect(chapters).toHaveLength(1);
  });
});
