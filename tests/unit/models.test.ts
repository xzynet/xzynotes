import { describe, expect, it } from 'vitest';
import {
  ChapterSchema,
  CourseSchema,
  DEFAULT_SETTING,
  ImageSchema,
  NoteSchema,
  SettingSchema,
  ShortcutsSchema,
  SubtitleCueSchema,
} from '../../core/models';

describe('CourseSchema', () => {
  const valid = {
    id: 'c1',
    platform: 'bilibili',
    title: '高等数学',
    url: 'https://www.bilibili.com/video/BV1xx',
    updatedAt: 1700000000000,
  };

  it('接受合法课程', () => {
    const course = CourseSchema.parse(valid);
    expect(course.platform).toBe('bilibili');
    expect(course.coverUrl).toBeUndefined();
  });

  it('拒绝未知平台', () => {
    expect(() => CourseSchema.parse({ ...valid, platform: 'netflix' })).toThrow();
  });

  it('拒绝非法 URL', () => {
    expect(() => CourseSchema.parse({ ...valid, url: 'not-a-url' })).toThrow();
  });

  it('拒绝空 id', () => {
    expect(() => CourseSchema.parse({ ...valid, id: '' })).toThrow();
  });

  it('接受可选封面', () => {
    const course = CourseSchema.parse({ ...valid, coverUrl: 'https://example.com/cover.jpg' });
    expect(course.coverUrl).toBe('https://example.com/cover.jpg');
  });

  it('旧数据无 summary 字段时补空串', () => {
    expect(CourseSchema.parse(valid).summary).toBe('');
  });

  it('旧数据无 titleLocked 字段时补 false', () => {
    expect(CourseSchema.parse(valid).titleLocked).toBe(false);
  });
});

describe('NoteSchema', () => {
  const valid = {
    id: 'n1',
    courseId: 'c1',
    type: 'text',
    timestampSec: 65,
    content: '可导必连续',
    createdAt: 1,
    updatedAt: 1,
  };

  it('接受合法笔记（imageId/ocrText 可缺省）', () => {
    const note = NoteSchema.parse(valid);
    expect(note.imageId).toBeUndefined();
    expect(note.ocrText).toBeUndefined();
  });

  it('拒绝负数时间戳', () => {
    expect(() => NoteSchema.parse({ ...valid, timestampSec: -1 })).toThrow();
  });

  it('拒绝未知笔记类型', () => {
    expect(() => NoteSchema.parse({ ...valid, type: 'video' })).toThrow();
  });

  it('接受截图笔记', () => {
    const note = NoteSchema.parse({ ...valid, type: 'screenshot', imageId: 'img1' });
    expect(note.imageId).toBe('img1');
  });
});

describe('ChapterSchema', () => {
  it('接受三种来源', () => {
    for (const source of ['rule', 'ai', 'manual']) {
      expect(
        ChapterSchema.parse({ id: 'c', courseId: 'c1', title: 't', startSec: 0, source }).source,
      ).toBe(source);
    }
  });

  it('拒绝未知来源', () => {
    expect(() =>
      ChapterSchema.parse({ id: 'c', courseId: 'c1', title: 't', startSec: 0, source: 'gpt' }),
    ).toThrow();
  });

  it('旧数据无 summary 字段时补空串', () => {
    const ch = ChapterSchema.parse({ id: 'c', courseId: 'c1', title: 't', startSec: 0, source: 'rule' });
    expect(ch.summary).toBe('');
  });
});

describe('ImageSchema', () => {
  it('接受合法图片', () => {
    const image = ImageSchema.parse({
      id: 'img1',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      width: 1280,
      height: 720,
    });
    expect(image.width).toBe(1280);
  });

  it('拒绝非 Blob', () => {
    expect(() => ImageSchema.parse({ id: 'img1', blob: 'not-a-blob', width: 1, height: 1 })).toThrow();
  });
});

describe('SettingSchema', () => {
  it('默认设置通过校验', () => {
    expect(() => SettingSchema.parse(DEFAULT_SETTING)).not.toThrow();
  });

  it('快捷键必须是完整 Record<Command, string>', () => {
    const { capture: _drop, ...partial } = DEFAULT_SETTING.shortcuts;
    void _drop;
    expect(() => ShortcutsSchema.parse(partial)).toThrow();
  });

  it('拒绝未知主题', () => {
    expect(() =>
      SettingSchema.parse({ ...DEFAULT_SETTING, theme: 'pink' }),
    ).toThrow();
  });

  it('旧设置无 llm 字段时补默认配置', () => {
    const { llm: _drop, ...legacy } = DEFAULT_SETTING;
    void _drop;
    const parsed = SettingSchema.parse(legacy);
    expect(parsed.llm.baseUrl).toBe('https://api.openai.com/v1');
    expect(parsed.llm.model).toBe('');
    expect(parsed.llm.apiToken).toBe('');
  });
});

describe('SubtitleCueSchema', () => {
  it('接受合法分句', () => {
    expect(SubtitleCueSchema.parse({ start: 0, end: 2.5, text: '你好' }).end).toBe(2.5);
  });

  it('拒绝负起点', () => {
    expect(() => SubtitleCueSchema.parse({ start: -0.1, end: 1, text: 'x' })).toThrow();
  });
});
