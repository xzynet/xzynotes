import { describe, expect, it } from 'vitest';
import {
  FOOTER_CREDIT_URL,
  formatTimestamp,
  generateMarkdown,
  type ExportOptions,
} from '../../core/export';
import type { Chapter, Course, Note } from '../../core/models';

const course: Course = {
  id: 'c1',
  platform: 'bilibili',
  title: '高等数学',
  url: 'https://www.bilibili.com/video/BV1xx',
  summary: '',
  titleLocked: false,
  updatedAt: 1700000000000,
};

const jump = (sec: number) => `${course.url}?t=${Math.floor(sec)}`;

const chapters: Chapter[] = [
  { id: 'ch1', courseId: 'c1', title: '导数定义', startSec: 0, summary: '', source: 'rule' },
  { id: 'ch2', courseId: 'c1', title: '导数计算', startSec: 600, summary: '', source: 'rule' },
];

const notes: Note[] = [
  { id: 'n1', courseId: 'c1', type: 'text', timestampSec: 65, content: '可导必连续', createdAt: 1, updatedAt: 1 },
  {
    id: 'n2',
    courseId: 'c1',
    type: 'screenshot',
    timestampSec: 700,
    content: '链式法则例题',
    imageId: 'img1',
    createdAt: 2,
    updatedAt: 2,
  },
  { id: 'n3', courseId: 'c1', type: 'bookmark', timestampSec: 900, content: '', createdAt: 3, updatedAt: 3 },
];

function makeOptions(patch: Partial<ExportOptions> = {}): ExportOptions {
  return {
    embedImage: 'base64',
    footerCredit: true,
    makeJumpUrl: jump,
    images: { img1: { dataUrl: 'data:image/jpeg;base64,AAA', filePath: 'images/img1.jpg' } },
    generatedAt: new Date(2025, 0, 15),
    ...patch,
  };
}

describe('formatTimestamp', () => {
  it('格式化各种时长', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(65)).toBe('01:05');
    expect(formatTimestamp(3599)).toBe('59:59');
    expect(formatTimestamp(3600)).toBe('1:00:00');
    expect(formatTimestamp(3723.7)).toBe('1:02:03');
  });
});

describe('generateMarkdown · 完整结构', () => {
  const md = generateMarkdown(course, notes, chapters, makeOptions());

  it('课程头含标题/平台/URL/日期', () => {
    expect(md.startsWith('# 高等数学')).toBe(true);
    expect(md).toContain('来源平台：B站');
    expect(md).toContain(`课程链接：${course.url}`);
    expect(md).toContain('导出日期：2025-01-15');
  });

  it('章节目录携带回跳链接', () => {
    expect(md).toContain(`- [00:00 导数定义](${course.url}?t=0)`);
    expect(md).toContain(`- [10:00 导数计算](${course.url}?t=600)`);
  });

  it('笔记按时间归入对应章节', () => {
    expect(md).toContain('## 导数定义（00:00）');
    expect(md).toContain('## 导数计算（10:00）');
    expect(md).toContain(`- [01:05](${course.url}?t=65) 可导必连续`);
    expect(md).toContain(`- [11:40](${course.url}?t=700) 链式法则例题`);
    const defIdx = md.indexOf('## 导数定义');
    const calcIdx = md.indexOf('## 导数计算');
    const n1Idx = md.indexOf('可导必连续');
    const n2Idx = md.indexOf('链式法则例题');
    expect(defIdx).toBeLessThan(n1Idx);
    expect(n1Idx).toBeLessThan(calcIdx);
    expect(calcIdx).toBeLessThan(n2Idx);
  });

  it('截图笔记按 base64 内嵌，标题作为图片 alt', () => {
    expect(md).toContain('![链式法则例题](data:image/jpeg;base64,AAA)');
  });

  it('书签笔记带标记', () => {
    expect(md).toContain(`- [15:00](${course.url}?t=900) **书签**`);
  });

  it('默认输出页脚', () => {
    expect(md).toContain(`由「学知云课记」插件生成 · ${FOOTER_CREDIT_URL}`);
  });
});

describe('generateMarkdown · 导出偏好', () => {
  it('file 模式使用相对路径', () => {
    const md = generateMarkdown(course, notes, chapters, makeOptions({ embedImage: 'file' }));
    expect(md).toContain('![链式法则例题](images/img1.jpg)');
    expect(md).not.toContain('data:image/jpeg;base64');
  });

  it('所选形态缺失时回退另一种', () => {
    const md = generateMarkdown(course, notes, chapters, makeOptions({
      embedImage: 'file',
      images: { img1: { dataUrl: 'data:image/jpeg;base64,AAA' } },
    }));
    expect(md).toContain('data:image/jpeg;base64,AAA');
  });

  it('无标题截图的 alt 回退为时间戳；多行标题压成单行并去除方括号', () => {
    const bare: Note[] = [
      { id: 'n4', courseId: 'c1', type: 'screenshot', timestampSec: 700, content: '', imageId: 'img1', createdAt: 1, updatedAt: 1 },
      { id: 'n5', courseId: 'c1', type: 'screenshot', timestampSec: 700, content: '第一行\n第[二]行', imageId: 'img1', createdAt: 2, updatedAt: 2 },
    ];
    const md = generateMarkdown(course, bare, [], makeOptions());
    expect(md).toContain('![截图 11:40](data:image/jpeg;base64,AAA)');
    expect(md).toContain('![第一行 第二行](data:image/jpeg;base64,AAA)');
  });

  it('图片记录缺失时省略图片行', () => {
    const md = generateMarkdown(course, notes, chapters, makeOptions({ images: {} }));
    expect(md).not.toContain('![');
  });

  it('footerCredit = false 时无页脚', () => {
    const md = generateMarkdown(course, notes, chapters, makeOptions({ footerCredit: false }));
    expect(md).not.toContain('由「学知云课记」');
  });
});

describe('generateMarkdown · 结构变体', () => {
  it('无章节 → 无目录，笔记归入「笔记」区', () => {
    const md = generateMarkdown(course, notes, [], makeOptions());
    expect(md).not.toContain('章节目录');
    expect(md).toContain('## 笔记');
  });

  it('有章节但笔记早于首章 → 「未分章笔记」区', () => {
    const lateChapters: Chapter[] = [
      { id: 'ch9', courseId: 'c1', title: '后半程', startSec: 600, summary: '', source: 'rule' },
    ];
    const md = generateMarkdown(course, notes, lateChapters, makeOptions());
    expect(md).toContain('## 未分章笔记');
    expect(md.indexOf('## 未分章笔记')).toBeLessThan(md.indexOf('可导必连续'));
    expect(md.indexOf('可导必连续')).toBeLessThan(md.indexOf('## 后半程'));
  });

  it('无笔记章节显示占位行', () => {
    const md = generateMarkdown(course, [], chapters, makeOptions());
    expect(md).toContain('（本章暂无笔记）');
  });

  it('缺省 makeJumpUrl 退化为课程 URL', () => {
    const md = generateMarkdown(course, notes, chapters, makeOptions({ makeJumpUrl: undefined }));
    expect(md).toContain(`- [01:05](${course.url}) 可导必连续`);
  });

  it('多行笔记内容缩进保持在列表内', () => {
    const multiline: Note[] = [
      { id: 'n9', courseId: 'c1', type: 'text', timestampSec: 10, content: '第一行\n第二行', createdAt: 1, updatedAt: 1 },
    ];
    const md = generateMarkdown(course, multiline, [], makeOptions());
    expect(md).toContain('第一行\n  第二行');
  });

  it('平台显示名映射', () => {
    const mooc = { ...course, platform: 'icourse163' as const };
    expect(generateMarkdown(mooc, [], [], makeOptions())).toContain('中国大学MOOC');
    const generic = { ...course, platform: 'generic' as const };
    expect(generateMarkdown(generic, [], [], makeOptions())).toContain('通用页面');
  });

  it('AI 概述与章节摘要进入导出文档', () => {
    const aiCourse = { ...course, summary: '本课讲授导数的定义与计算方法。' };
    const aiChapters: Chapter[] = [
      { ...chapters[0]!, summary: '从变化率引入导数概念。' },
      chapters[1]!,
    ];
    const md = generateMarkdown(aiCourse, notes, aiChapters, makeOptions());
    expect(md).toContain('## 课程概述');
    expect(md).toContain('本课讲授导数的定义与计算方法。');
    expect(md).toContain('> 摘要：从变化率引入导数概念。');
    // 无摘要的章节不输出摘要行
    expect(md).not.toContain('> 摘要：\n');
  });
});

describe('generateMarkdown · 英文 locale', () => {
  const md = generateMarkdown(course, notes, chapters, makeOptions({ locale: 'en' }));

  it('课程头/章节/书签/页脚全英文', () => {
    expect(md).toContain('Platform: bilibili');
    expect(md).toContain(`Course: ${course.url}`);
    expect(md).toContain(`Exported: ${new Date(2025, 0, 15).toLocaleDateString('en-US')}`);
    expect(md).toContain('## Chapters');
    expect(md).toContain('## 导数定义 (00:00)');
    expect(md).toContain('**Bookmark**');
    expect(md).toContain(`Generated by XZY Notes · ${FOOTER_CREDIT_URL}`);
  });

  it('无标题截图使用英文 alt', () => {
    const shot: Note[] = [
      { id: 'n4', courseId: 'c1', type: 'screenshot', timestampSec: 700, content: '', imageId: 'img1', createdAt: 4, updatedAt: 4 },
    ];
    const md = generateMarkdown(course, shot, [], makeOptions({ locale: 'en' }));
    expect(md).toContain('![Screenshot 11:40]');
  });

  it('结构变体按英文渲染', () => {
    const noNotes = generateMarkdown(course, [], chapters, makeOptions({ locale: 'en' }));
    expect(noNotes).toContain('(No notes in this chapter yet)');
    const lateChapters: Chapter[] = [
      { id: 'ch9', courseId: 'c1', title: '后半程', startSec: 600, summary: '', source: 'rule' },
    ];
    const unassigned = generateMarkdown(course, notes, lateChapters, makeOptions({ locale: 'en' }));
    expect(unassigned).toContain('## Uncategorized Notes');
  });

  it('缺省 locale 输出中文（向后兼容）', () => {
    const md = generateMarkdown(course, notes, chapters, makeOptions());
    expect(md).toContain('来源平台：B站');
    expect(md).toContain(`由「学知云课记」插件生成 · ${FOOTER_CREDIT_URL}`);
  });
});
