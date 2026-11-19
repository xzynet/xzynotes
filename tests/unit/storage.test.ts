import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Chapter, Course, Image, Note, Transcript } from '../../core/models';
import { DEFAULT_SETTING } from '../../core/models';
import { DexieStorage, type IStorage } from '../../core/storage';
import { newId } from '../../core/utils/id';

let storage: IStorage;

beforeEach(() => {
  storage = new DexieStorage(`test-${newId()}`);
});

function makeCourse(id: string, updatedAt = 1): Course {
  return {
    id,
    platform: 'bilibili',
    title: `课程${id}`,
    url: 'https://www.bilibili.com/video/BV1xx',
    summary: '',
    titleLocked: false,
    updatedAt,
  };
}

function makeNote(id: string, courseId: string, timestampSec: number, imageId?: string): Note {
  return {
    id,
    courseId,
    type: imageId ? 'screenshot' : 'text',
    timestampSec,
    content: `笔记${id}`,
    imageId,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeImage(id: string): Image {
  return { id, blob: new Blob(['x'], { type: 'image/jpeg' }), width: 1280, height: 720 };
}

function makeChapter(id: string, courseId: string, startSec: number): Chapter {
  return { id, courseId, title: `章节${id}`, startSec, summary: '', source: 'rule' };
}

function makeTranscript(courseId: string): Transcript {
  return {
    id: courseId,
    courseId,
    modelId: 'paraformer-streaming',
    cues: [
      { start: 0, end: 5, text: '第一句' },
      { start: 5, end: 12, text: '第二句' },
    ],
    durationSec: 12,
    updatedAt: 1,
  };
}

describe('DexieStorage · Course', () => {
  it('upsert + get', async () => {
    await storage.upsertCourse(makeCourse('c1'));
    expect((await storage.getCourse('c1'))?.title).toBe('课程c1');
    expect(await storage.getCourse('missing')).toBeUndefined();
  });

  it('改名后的锁定标题随课程往返保存', async () => {
    await storage.upsertCourse(makeCourse('c1'));
    const stored = (await storage.getCourse('c1'))!;
    await storage.upsertCourse({ ...stored, title: '改名后的课程', titleLocked: true });
    const renamed = await storage.getCourse('c1');
    expect(renamed?.title).toBe('改名后的课程');
    expect(renamed?.titleLocked).toBe(true);
  });

  it('listCourses 按 updatedAt 倒序', async () => {
    await storage.upsertCourse(makeCourse('c1', 100));
    await storage.upsertCourse(makeCourse('c2', 300));
    await storage.upsertCourse(makeCourse('c3', 200));
    expect((await storage.listCourses()).map((c) => c.id)).toEqual(['c2', 'c3', 'c1']);
  });

  it('deleteCourse 级联删除笔记/章节/截图/转写', async () => {
    await storage.upsertCourse(makeCourse('c1'));
    await storage.putImage(makeImage('img1'));
    await storage.addNote(makeNote('n1', 'c1', 10, 'img1'));
    await storage.addNote(makeNote('n2', 'c1', 20));
    await storage.replaceChapters('c1', [makeChapter('ch1', 'c1', 0)]);
    await storage.saveTranscript(makeTranscript('c1'));

    await storage.deleteCourse('c1');

    expect(await storage.getCourse('c1')).toBeUndefined();
    expect(await storage.listNotesByCourse('c1')).toEqual([]);
    expect(await storage.listChaptersByCourse('c1')).toEqual([]);
    expect(await storage.getImage('img1')).toBeUndefined();
    expect(await storage.getTranscript('c1')).toBeUndefined();
  });

  it('rekeyCourse 整课改挂：笔记/章节/转写随迁，课程行保留标题与锁定标记', async () => {
    await storage.upsertCourse({ ...makeCourse('old'), title: '改名后的课程', titleLocked: true });
    await storage.putImage(makeImage('img1'));
    await storage.addNote(makeNote('n1', 'old', 10, 'img1'));
    await storage.addNote(makeNote('n2', 'old', 20));
    await storage.addNote(makeNote('n3', 'other', 30));
    await storage.replaceChapters('old', [makeChapter('ch1', 'old', 0)]);
    await storage.saveTranscript(makeTranscript('old'));

    expect(await storage.rekeyCourse('old', 'new')).toBe(true);

    expect(await storage.getCourse('old')).toBeUndefined();
    const moved = (await storage.getCourse('new'))!;
    expect(moved.title).toBe('改名后的课程');
    expect(moved.titleLocked).toBe(true);
    expect((await storage.listNotesByCourse('new')).map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(await storage.listNotesByCourse('old')).toEqual([]);
    // 其它课程的笔记不受影响
    expect((await storage.listNotesByCourse('other')).map((n) => n.id)).toEqual(['n3']);
    expect((await storage.listChaptersByCourse('new')).map((c) => c.id)).toEqual(['ch1']);
    expect((await storage.getTranscript('new'))?.courseId).toBe('new');
    expect(await storage.getTranscript('old')).toBeUndefined();
    // 截图被笔记引用，不随课程删除/迁移
    expect(await storage.getImage('img1')).toBeDefined();
  });

  it('rekeyCourse：旧课不存在或新课已有数据时不做合并', async () => {
    expect(await storage.rekeyCourse('missing', 'new')).toBe(false);
    await storage.upsertCourse(makeCourse('old'));
    await storage.upsertCourse(makeCourse('new'));
    expect(await storage.rekeyCourse('old', 'new')).toBe(false);
    expect(await storage.getCourse('old')).toBeDefined();
  });

  it('写入非法数据直接拒绝', async () => {
    await expect(
      storage.upsertCourse({ ...makeCourse('c1'), platform: 'netflix' } as unknown as Course),
    ).rejects.toThrow();
  });
});

describe('DexieStorage · Note', () => {
  it('add + listNotesByCourse 按时间戳升序', async () => {
    await storage.addNote(makeNote('n1', 'c1', 30));
    await storage.addNote(makeNote('n2', 'c1', 10));
    await storage.addNote(makeNote('n3', 'c2', 5));
    const notes = await storage.listNotesByCourse('c1');
    expect(notes.map((n) => n.id)).toEqual(['n2', 'n1']);
  });

  it('updateNote 局部更新', async () => {
    await storage.addNote(makeNote('n1', 'c1', 10));
    await storage.updateNote('n1', { content: '改后的内容', updatedAt: 2 });
    const note = await storage.getNote('n1');
    expect(note?.content).toBe('改后的内容');
    expect(note?.timestampSec).toBe(10);
  });

  it('updateNote 不存在的笔记抛错', async () => {
    await expect(storage.updateNote('missing', { content: 'x' })).rejects.toThrow(
      'err.noteNotFound',
    );
  });

  it('deleteNote 同时删除引用截图', async () => {
    await storage.putImage(makeImage('img1'));
    await storage.addNote(makeNote('n1', 'c1', 10, 'img1'));
    await storage.deleteNote('n1');
    expect(await storage.getNote('n1')).toBeUndefined();
    expect(await storage.getImage('img1')).toBeUndefined();
  });
});

describe('DexieStorage · Chapter', () => {
  it('replaceChapters 全量替换且按 startSec 升序', async () => {
    await storage.replaceChapters('c1', [makeChapter('ch2', 'c1', 100), makeChapter('ch1', 'c1', 0)]);
    await storage.replaceChapters('c1', [makeChapter('ch3', 'c1', 50)]);
    const chapters = await storage.listChaptersByCourse('c1');
    expect(chapters.map((c) => c.id)).toEqual(['ch3']);
  });
});

describe('DexieStorage · Image', () => {
  it('put / get / delete', async () => {
    await storage.putImage(makeImage('img1'));
    const image = await storage.getImage('img1');
    expect(image?.width).toBe(1280);
    expect(image?.blob.size).toBeGreaterThan(0);
    await storage.deleteImage('img1');
    expect(await storage.getImage('img1')).toBeUndefined();
  });
});

describe('DexieStorage · Setting', () => {
  it('未设置时返回 DEFAULT_SETTING', async () => {
    expect(await storage.getSetting()).toEqual(DEFAULT_SETTING);
  });

  it('save + get 往返一致', async () => {
    const setting = {
      ...DEFAULT_SETTING,
      theme: 'dark' as const,
      shortcuts: { ...DEFAULT_SETTING.shortcuts, capture: 'Alt+Q' },
    };
    await storage.saveSetting(setting);
    expect(await storage.getSetting()).toEqual(setting);
  });

  it('写入非法设置直接拒绝', async () => {
    await expect(
      storage.saveSetting({ ...DEFAULT_SETTING, theme: 'pink' } as never),
    ).rejects.toThrow();
  });

  it('旧版本设置（无 capturePrefs）读取时自动补默认值', async () => {
    const legacy = {
      shortcuts: DEFAULT_SETTING.shortcuts,
      theme: 'auto',
      exportPrefs: { embedImage: 'base64', footerCredit: true },
    };
    // 模拟旧版本写入（绕过新 schema 的输入校验）
    await storage.saveSetting(legacy as unknown as typeof DEFAULT_SETTING);
    const read = await storage.getSetting();
    expect(read.capturePrefs).toEqual({ quality: 0.85 });
  });
});

describe('DexieStorage · 备份', () => {
  it('countRecords 统计各表记录数', async () => {
    await storage.upsertCourse(makeCourse('c1'));
    await storage.putImage(makeImage('img1'));
    await storage.addNote(makeNote('n1', 'c1', 10, 'img1'));
    await storage.replaceChapters('c1', [makeChapter('ch1', 'c1', 0)]);
    await storage.saveTranscript(makeTranscript('c1'));
    expect(await storage.countRecords()).toEqual({
      courses: 1,
      notes: 1,
      chapters: 1,
      images: 1,
      transcripts: 1,
    });
  });

  it('exportAll → importAll 往返一致（含截图、设置与转写）', async () => {
    await storage.upsertCourse(makeCourse('c1', 100));
    await storage.putImage(makeImage('img1'));
    await storage.addNote(makeNote('n1', 'c1', 10, 'img1'));
    await storage.replaceChapters('c1', [makeChapter('ch1', 'c1', 0)]);
    await storage.saveTranscript(makeTranscript('c1'));
    await storage.saveSetting({ ...DEFAULT_SETTING, theme: 'dark' });

    const backup = await storage.exportAll();
    expect(backup.version).toBe(1);
    expect(backup.courses).toHaveLength(1);
    expect(backup.transcripts).toHaveLength(1);
    expect(backup.images['img1']?.dataUrl.startsWith('data:')).toBe(true);

    const fresh = new DexieStorage(`test-${newId()}`);
    const counts = await fresh.importAll(backup);
    expect(counts).toEqual({ courses: 1, notes: 1, chapters: 1, images: 1, transcripts: 1 });
    expect((await fresh.getCourse('c1'))?.title).toBe('课程c1');
    expect((await fresh.getImage('img1'))?.blob.size).toBeGreaterThan(0);
    expect((await fresh.getSetting()).theme).toBe('dark');
    expect((await fresh.listNotesByCourse('c1')).map((n) => n.id)).toEqual(['n1']);
    expect((await fresh.listChaptersByCourse('c1')).map((c) => c.id)).toEqual(['ch1']);
    expect((await fresh.getTranscript('c1'))?.cues).toHaveLength(2);
  });

  it('importAll 兼容无 transcripts 字段的旧备份', async () => {
    const backup = await storage.exportAll();
    const legacy = { ...backup } as Record<string, unknown>;
    delete legacy['transcripts'];
    const fresh = new DexieStorage(`test-${newId()}`);
    await expect(fresh.importAll(legacy as never)).resolves.toMatchObject({ transcripts: 0 });
  });

  it('importAll 拒绝非法备份数据', async () => {
    await expect(storage.importAll({ version: 99 } as never)).rejects.toThrow();
  });
});

describe('DexieStorage · Transcript', () => {
  it('saveTranscript / getTranscript 往返一致', async () => {
    await storage.saveTranscript(makeTranscript('c1'));
    const t = await storage.getTranscript('c1');
    expect(t?.modelId).toBe('paraformer-streaming');
    expect(t?.cues.map((c) => c.text)).toEqual(['第一句', '第二句']);
    expect(await storage.getTranscript('missing')).toBeUndefined();
  });

  it('同课程重复保存覆盖旧转写', async () => {
    await storage.saveTranscript(makeTranscript('c1'));
    const newer = { ...makeTranscript('c1'), modelId: 'sensevoice', updatedAt: 2 };
    await storage.saveTranscript(newer);
    const t = await storage.getTranscript('c1');
    expect(t?.modelId).toBe('sensevoice');
    expect(t?.updatedAt).toBe(2);
  });

  it('写入非法转写数据直接拒绝', async () => {
    await expect(
      storage.saveTranscript({ ...makeTranscript('c1'), cues: [{ start: -1, end: 0, text: '' }] }),
    ).rejects.toThrow();
  });
});
