import { describe, expect, it } from 'vitest';
import {
  groupCuesByChapter,
  makeChapterTitle,
  normalizeCues,
  segmentChapters,
  type DensityPoint,
} from '../../core/chapters';
import type { SubtitleCue } from '../../core/models';

const cue = (start: number, end: number, text = '持续讲解'): SubtitleCue => ({ start, end, text });

/** 生成 0 → totalSec 的连续无停顿字幕 */
function continuous(totalSec: number, step = 10): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (let s = 0; s < totalSec; s += step) {
    cues.push(cue(s, Math.min(s + step, totalSec)));
  }
  return cues;
}

/** 替换指定下标分句的文本（防御 noUncheckedIndexedAccess） */
function withText(cues: SubtitleCue[], idx: number, text: string): void {
  const c = cues[idx];
  if (!c) throw new Error(`bad index: ${idx}`);
  cues[idx] = { ...c, text };
}

describe('normalizeCues', () => {
  it('排序、去空文本、钳制 end >= start', () => {
    const cues = normalizeCues([
      cue(20, 30, 'b'),
      cue(0, 10, ' '),
      cue(10, 5, 'c'),
    ]);
    expect(cues.map((c) => c.text)).toEqual(['c', 'b']);
    expect(cues[0]?.end).toBe(10);
  });
});

describe('segmentChapters · 边界场景', () => {
  it('空字幕 → 空数组', () => {
    expect(segmentChapters([])).toEqual([]);
    expect(segmentChapters([cue(0, 5, '   ')])).toEqual([]);
  });

  it('单条字幕 → 单个章节，startSec 向下取整', () => {
    const chapters = segmentChapters([cue(5.7, 9.2, '大家好我们开始上课')]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.startSec).toBe(5);
  });

  it('总时长不足 60s → 仅一章（无法再合并）', () => {
    const chapters = segmentChapters(continuous(45, 5));
    expect(chapters).toHaveLength(1);
  });
});

describe('segmentChapters · 语义边界', () => {
  /** 把一组字幕整体平移 offset 秒 */
  const shift = (cues: SubtitleCue[], offset: number): SubtitleCue[] =>
    cues.map((c) => ({ start: c.start + offset, end: c.end + offset, text: c.text }));

  it('停顿 > 3s 且满足最短时长 → 切分', () => {
    // 0~120 连续 + 144~300 连续，中间停顿 24s
    const cues = [...continuous(120), ...shift(continuous(156), 144)];
    const chapters = segmentChapters(cues);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]?.startSec).toBe(0);
    expect(chapters[1]?.startSec).toBe(144);
  });

  it('停顿 ≤ 3s → 不切分', () => {
    const cues = [...continuous(120), ...shift(continuous(178), 122)];
    expect(segmentChapters(cues)).toHaveLength(1);
  });

  it('话题转换词触发切分', () => {
    const cues = continuous(400);
    withText(cues, 20, '接下来我们讲第二个部分');
    const chapters = segmentChapters(cues);
    expect(chapters).toHaveLength(2);
    expect(chapters[1]?.startSec).toBe(200);
    expect(chapters[1]?.title.startsWith('讲第二个部分')).toBe(true);
  });

  it('边界早于最短时长（60s）→ 不落刀', () => {
    const cues = continuous(100);
    withText(cues, 3, '接下来换话题');
    expect(segmentChapters(cues)).toHaveLength(1);
  });
});

describe('segmentChapters · 时长收敛', () => {
  it('1500s 无停顿 → 递归二分，各段在 [60, 600] 内', () => {
    // 分句粒度 10s，二分点对齐到最近分句边界：380/750/1130
    const chapters = segmentChapters(continuous(1500));
    expect(chapters.map((c) => c.startSec)).toEqual([0, 380, 750, 1130]);
  });

  it('3600s 无停顿 → 8 × 450s，全部在 [60, 600] 内', () => {
    const chapters = segmentChapters(continuous(3600));
    expect(chapters).toHaveLength(8);
    const starts = chapters.map((c) => c.startSec);
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i] ?? 0;
      const end = i + 1 < starts.length ? (starts[i + 1] ?? 3600) : 3600;
      expect(end - start).toBeGreaterThanOrEqual(60);
      expect(end - start).toBeLessThanOrEqual(600);
    }
  });

  it('末尾过短段并入前一段', () => {
    const cues = continuous(200);
    withText(cues, 15, '接下来我们总结一下');
    const chapters = segmentChapters(cues);
    expect(chapters).toHaveLength(1);
  });

  it('章节目录按 startSec 升序', () => {
    const chapters = segmentChapters(continuous(1500));
    const starts = chapters.map((c) => c.startSec);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe('segmentChapters · 弹幕密度微调', () => {
  function withBoundaryAt300(): SubtitleCue[] {
    const cues = continuous(600, 2);
    const idx = cues.findIndex((c) => c.start === 300);
    withText(cues, idx, '接下来进入下一部分');
    return cues;
  }

  it('无弹幕 → 切在 300s', () => {
    const chapters = segmentChapters(withBoundaryAt300());
    expect(chapters.map((c) => c.startSec)).toEqual([0, 300]);
  });

  it('窗口内峰值 312s → 切分点移到 312s', () => {
    const danmaku: DensityPoint[] = [
      { sec: 305, count: 5 },
      { sec: 312, count: 99 },
      { sec: 318, count: 2 },
    ];
    const chapters = segmentChapters(withBoundaryAt300(), { danmaku });
    expect(chapters.map((c) => c.startSec)).toEqual([0, 312]);
  });

  it('微调会破坏最短时长 → 保持原切分点', () => {
    const cues = continuous(600, 2);
    const idx = cues.findIndex((c) => c.start === 70);
    withText(cues, idx, '接下来进入下一部分');
    const danmaku: DensityPoint[] = [{ sec: 56, count: 99 }];
    const chapters = segmentChapters(cues, { danmaku });
    expect(chapters.map((c) => c.startSec)).toEqual([0, 70]);
  });

  it('窗口外峰值不影响切分', () => {
    const danmaku: DensityPoint[] = [{ sec: 400, count: 99 }];
    const chapters = segmentChapters(withBoundaryAt300(), { danmaku });
    expect(chapters.map((c) => c.startSec)).toEqual([0, 300]);
  });
});

describe('makeChapterTitle', () => {
  it('剥离开头语气词与标点', () => {
    expect(makeChapterTitle([cue(0, 10, '好的，那么我们今天来学习一下导数的定义。')])).toBe(
      '学习一下导数的定义',
    );
  });

  it('标题超过 20 字截断', () => {
    const title = makeChapterTitle([
      cue(0, 10, '我们来系统地学习一下关于高等数学上册的全部内容以及习题讲解'),
    ]);
    expect(Array.from(title)).toHaveLength(20);
    expect(title.startsWith('系统地学习')).toBe(true);
  });

  it('取首句主干（句末标点截断）', () => {
    expect(makeChapterTitle([cue(0, 10, '首先讲导数。然后讲积分')])).toBe('首先讲导数');
  });

  it('剥离结尾语气词', () => {
    expect(makeChapterTitle([cue(0, 10, '看一下这个例题吧。')])).toBe('看一下这个例题');
  });

  it('全为语气词时兜底未命名章节', () => {
    expect(makeChapterTitle([cue(0, 10, '好的。')])).toBe('未命名章节');
  });
});

describe('groupCuesByChapter', () => {
  const ch = (id: string, startSec: number): { id: string; startSec: number } => ({
    id,
    startSec,
  });

  it('基本归组：cue 归属最后一个 startSec <= cue.start 的章节', () => {
    const map = groupCuesByChapter(
      [ch('a', 0), ch('b', 100)],
      [cue(0, 10), cue(50, 60), cue(100, 110), cue(150, 160)],
    );
    expect(map.get('a')?.map((c) => c.start)).toEqual([0, 50]);
    expect(map.get('b')?.map((c) => c.start)).toEqual([100, 150]);
  });

  it('cue.start 恰好等于章节起点 → 归该章', () => {
    const map = groupCuesByChapter([ch('a', 0), ch('b', 100)], [cue(100, 110)]);
    expect(map.has('a')).toBe(false);
    expect(map.get('b')).toHaveLength(1);
  });

  it('首个章节之前的字幕被省略', () => {
    const map = groupCuesByChapter([ch('a', 100)], [cue(0, 10), cue(120, 130)]);
    expect(map.get('a')?.map((c) => c.start)).toEqual([120]);
  });

  it('章节入参未排序也能正确归组', () => {
    const map = groupCuesByChapter([ch('b', 100), ch('a', 0)], [cue(50, 60)]);
    expect(map.get('a')).toHaveLength(1);
    expect(map.has('b')).toBe(false);
  });

  it('空输入 → 空 Map', () => {
    expect(groupCuesByChapter([], [cue(0, 10)]).size).toBe(0);
    expect(groupCuesByChapter([ch('a', 0)], []).size).toBe(0);
  });
});
