import { translate, type Locale, type MessageKey } from '~/core/i18n';
import type { Chapter } from '../models/chapter';
import type { Course, Platform } from '../models/course';
import type { Note } from '../models/note';

/** 页脚落地页占位域名 */
export const FOOTER_CREDIT_URL = 'https://kedaibiao.example.com';

/** 截图引用：两种导出形态由调用方预先准备好，生成器按 embedImage 选用 */
export interface ExportImageRef {
  /** base64 dataURL（embedImage = 'base64' 时使用） */
  dataUrl?: string;
  /** 相对路径，如 images/xxx.jpg（embedImage = 'file' 时使用） */
  filePath?: string;
}

export interface ExportOptions {
  embedImage: 'base64' | 'file';
  footerCredit: boolean;
  /** 时间戳回跳链接生成器（由 PlatformAdapter.makeJumpUrl 提供；缺省退化为课程 URL） */
  makeJumpUrl?: (sec: number) => string;
  /** imageId → 图片引用 */
  images?: Record<string, ExportImageRef>;
  /** 导出时间，可注入便于测试 */
  generatedAt?: Date;
  /** 文档语言，缺省中文 */
  locale?: Locale;
}

/** 平台显示名 → 共享文案 key（按 locale 取 platform.*） */
const PLATFORM_KEYS: Record<Platform, MessageKey> = {
  bilibili: 'platform.bilibili',
  icourse163: 'platform.icourse163',
  xuetangx: 'platform.xuetangx',
  zhihuishu: 'platform.zhihuishu',
  youtube: 'platform.youtube',
  generic: 'platform.generic',
};

/** 秒 → mm:ss / h:mm:ss（始终补零分、秒） */
export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const rr = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

function renderNote(
  note: Note,
  jump: (sec: number) => string,
  images: Record<string, ExportImageRef>,
  embedImage: 'base64' | 'file',
  locale: Locale,
): string[] {
  const ts = formatTimestamp(note.timestampSec);
  let firstLine = `- [${ts}](${jump(note.timestampSec)})`;
  if (note.type === 'bookmark') firstLine += ` **${translate(locale, 'export.bookmark')}**`;
  const content = note.content.trim();
  if (content) firstLine += ` ${content.split('\n').join('\n  ')}`;

  const lines = [firstLine];
  if (note.type === 'screenshot' && note.imageId) {
    const ref = images[note.imageId];
    const src =
      embedImage === 'base64' ? (ref?.dataUrl ?? ref?.filePath) : (ref?.filePath ?? ref?.dataUrl);
    if (src) {
      // 有标题的截图用标题作 alt；压成单行并去掉方括号，防破坏 Markdown 图片语法
      const alt = content
        ? content.replace(/\s*\n\s*/g, ' ').replace(/[[\]]/g, '')
        : translate(locale, 'export.screenshotAlt', { ts });
      lines.push(`  ![${alt}](${src})`);
    }
  }
  return lines;
}

/** 笔记所属章节：最后一个 startSec <= 笔记时间点的章节 */
function findChapterFor(timestampSec: number, chapters: Chapter[]): Chapter | undefined {
  let found: Chapter | undefined;
  for (const ch of chapters) {
    if (ch.startSec <= timestampSec) found = ch;
    else break;
  }
  return found;
}

/**
 * Markdown 生成器（纯函数）：课程头 → 章节目录 → 各章节下按时间排列笔记 → 页脚。
 * 文案按 locale 取 i18n 字典，缺省中文（现有调用方行为不变）。
 */
export function generateMarkdown(
  course: Course,
  notes: Note[],
  chapters: Chapter[],
  options: ExportOptions,
): string {
  const locale = options.locale ?? 'zh-CN';
  const jump = options.makeJumpUrl ?? (() => course.url);
  const images = options.images ?? {};
  const date = options.generatedAt ?? new Date();
  const dateStr =
    locale === 'en'
      ? date.toLocaleDateString('en-US')
      : [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, '0'),
          String(date.getDate()).padStart(2, '0'),
        ].join('-');

  const sortedChapters = [...chapters].sort((a, b) => a.startSec - b.startSec);
  const sortedNotes = [...notes].sort((a, b) => a.timestampSec - b.timestampSec);

  const lines: string[] = [];
  lines.push(`# ${course.title}`, '');
  lines.push(
    `> ${translate(locale, 'export.headerLine', {
      platform: translate(locale, PLATFORM_KEYS[course.platform]),
      url: course.url,
      date: dateStr,
    })}`,
    '',
  );

  if (course.summary) {
    lines.push(`## ${translate(locale, 'export.summaryHeading')}`, '', course.summary, '');
  }

  if (sortedChapters.length > 0) {
    lines.push(`## ${translate(locale, 'export.tocHeading')}`, '');
    for (const ch of sortedChapters) {
      lines.push(`- [${formatTimestamp(ch.startSec)} ${ch.title}](${jump(ch.startSec)})`);
    }
    lines.push('');
  }

  const byChapter = new Map<string, Note[]>();
  const unassigned: Note[] = [];
  for (const note of sortedNotes) {
    const ch = findChapterFor(note.timestampSec, sortedChapters);
    if (ch) {
      const list = byChapter.get(ch.id) ?? [];
      list.push(note);
      byChapter.set(ch.id, list);
    } else {
      unassigned.push(note);
    }
  }

  if (unassigned.length > 0) {
    const heading =
      sortedChapters.length > 0
        ? translate(locale, 'export.unassignedNotesHeading')
        : translate(locale, 'export.notesHeading');
    lines.push(`## ${heading}`, '');
    for (const note of unassigned) {
      lines.push(...renderNote(note, jump, images, options.embedImage, locale));
    }
    lines.push('');
  }

  for (const ch of sortedChapters) {
    const ts = formatTimestamp(ch.startSec);
    lines.push(`## ${translate(locale, 'export.chapterHeading', { title: ch.title, ts })}`, '');
    if (ch.summary) {
      lines.push(`> ${translate(locale, 'export.chapterSummary', { summary: ch.summary })}`, '');
    }
    const chapterNotes = byChapter.get(ch.id) ?? [];
    if (chapterNotes.length === 0) {
      lines.push(translate(locale, 'export.noNotesInChapter'), '');
    } else {
      for (const note of chapterNotes) {
        lines.push(...renderNote(note, jump, images, options.embedImage, locale));
      }
      lines.push('');
    }
  }

  if (options.footerCredit) {
    const brand = translate(locale, 'brand.name');
    lines.push(
      '---',
      '',
      `${translate(locale, 'export.footerCredit', { brand })} · ${FOOTER_CREDIT_URL}`,
      '',
    );
  }

  return lines.join('\n');
}
