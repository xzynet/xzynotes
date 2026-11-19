import Dexie, { type Table } from 'dexie';
import { ChapterSchema, type Chapter } from '../models/chapter';
import { CourseSchema, type Course } from '../models/course';
import { ImageSchema, type Image } from '../models/image';
import { NoteSchema, type Note } from '../models/note';
import { DEFAULT_SETTING, SettingSchema, type Setting } from '../models/setting';
import { TranscriptSchema, type Transcript } from '../models/transcript';
import { blobToDataUrl, dataUrlToBlob } from '../utils/dataurl';
import { BACKUP_VERSION, BackupDataSchema, type BackupData, type TableCounts } from './backup';
import type { IStorage } from './types';

const SETTING_ID = 'global';

type SettingRecord = Setting & { id: string };

class KedaibiaoDatabase extends Dexie {
  courses!: Table<Course, string>;
  notes!: Table<Note, string>;
  chapters!: Table<Chapter, string>;
  images!: Table<Image, string>;
  settings!: Table<SettingRecord, string>;
  transcripts!: Table<Transcript, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      courses: 'id, platform, updatedAt',
      notes: 'id, courseId, timestampSec, updatedAt',
      chapters: 'id, courseId, startSec',
      images: 'id',
      settings: 'id',
    });
    // v2：本地语音转写结果（id 即 courseId，一课一份）
    this.version(2).stores({
      transcripts: 'id, updatedAt',
    });
  }
}

/** Dexie / IndexedDB 实现的 IStorage。写入时一律过 zod 校验，脏数据直接拒绝。 */
export class DexieStorage implements IStorage {
  private readonly db: KedaibiaoDatabase;

  constructor(dbName = 'kedaibiao') {
    this.db = new KedaibiaoDatabase(dbName);
  }

  // ---- Course ----

  async getCourse(id: string): Promise<Course | undefined> {
    return this.db.courses.get(id);
  }

  async upsertCourse(course: Course): Promise<void> {
    await this.db.courses.put(CourseSchema.parse(course));
  }

  async listCourses(): Promise<Course[]> {
    return this.db.courses.orderBy('updatedAt').reverse().toArray();
  }

  async deleteCourse(id: string): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.courses, this.db.notes, this.db.chapters, this.db.images, this.db.transcripts],
      async () => {
        const notes = await this.db.notes.where('courseId').equals(id).toArray();
        const imageIds = notes.flatMap((n) => (n.imageId ? [n.imageId] : []));
        await this.db.images.bulkDelete(imageIds);
        await this.db.notes.where('courseId').equals(id).delete();
        await this.db.chapters.where('courseId').equals(id).delete();
        await this.db.transcripts.delete(id);
        await this.db.courses.delete(id);
      },
    );
  }

  async rekeyCourse(oldId: string, newId: string): Promise<boolean> {
    return this.db.transaction(
      'rw',
      [this.db.courses, this.db.notes, this.db.chapters, this.db.transcripts],
      async () => {
        const course = await this.db.courses.get(oldId);
        if (!course || (await this.db.courses.get(newId))) return false;
        await this.db.courses.put(CourseSchema.parse({ ...course, id: newId }));
        await this.db.courses.delete(oldId);
        await this.db.notes.where('courseId').equals(oldId).modify({ courseId: newId });
        await this.db.chapters.where('courseId').equals(oldId).modify({ courseId: newId });
        const transcript = await this.db.transcripts.get(oldId);
        if (transcript) {
          await this.db.transcripts.put({ ...transcript, id: newId, courseId: newId });
          await this.db.transcripts.delete(oldId);
        }
        return true;
      },
    );
  }

  // ---- Note ----

  async addNote(note: Note): Promise<void> {
    await this.db.notes.add(NoteSchema.parse(note));
  }

  async updateNote(id: string, patch: Partial<Omit<Note, 'id' | 'courseId'>>): Promise<void> {
    const updated = await this.db.notes.update(id, patch);
    if (updated === 0) throw new Error('err.noteNotFound');
  }

  async getNote(id: string): Promise<Note | undefined> {
    return this.db.notes.get(id);
  }

  async deleteNote(id: string): Promise<void> {
    await this.db.transaction('rw', [this.db.notes, this.db.images], async () => {
      const note = await this.db.notes.get(id);
      if (note?.imageId) await this.db.images.delete(note.imageId);
      await this.db.notes.delete(id);
    });
  }

  async listNotesByCourse(courseId: string): Promise<Note[]> {
    const notes = await this.db.notes.where('courseId').equals(courseId).toArray();
    return notes.sort((a, b) => a.timestampSec - b.timestampSec);
  }

  // ---- Chapter ----

  async replaceChapters(courseId: string, chapters: Chapter[]): Promise<void> {
    const parsed = chapters.map((c) => ChapterSchema.parse(c));
    await this.db.transaction('rw', this.db.chapters, async () => {
      await this.db.chapters.where('courseId').equals(courseId).delete();
      await this.db.chapters.bulkAdd(parsed);
    });
  }

  async listChaptersByCourse(courseId: string): Promise<Chapter[]> {
    const chapters = await this.db.chapters.where('courseId').equals(courseId).toArray();
    return chapters.sort((a, b) => a.startSec - b.startSec);
  }

  // ---- Transcript ----

  async getTranscript(courseId: string): Promise<Transcript | undefined> {
    return this.db.transcripts.get(courseId);
  }

  async saveTranscript(transcript: Transcript): Promise<void> {
    await this.db.transcripts.put(TranscriptSchema.parse(transcript));
  }

  // ---- Image ----

  async putImage(image: Image): Promise<void> {
    await this.db.images.put(ImageSchema.parse(image));
  }

  async getImage(id: string): Promise<Image | undefined> {
    return this.db.images.get(id);
  }

  async deleteImage(id: string): Promise<void> {
    await this.db.images.delete(id);
  }

  // ---- Setting ----

  async getSetting(): Promise<Setting> {
    const record = await this.db.settings.get(SETTING_ID);
    if (!record) return { ...DEFAULT_SETTING };
    const { id, ...setting } = record;
    void id;
    return SettingSchema.parse(setting);
  }

  async saveSetting(setting: Setting): Promise<void> {
    await this.db.settings.put({ id: SETTING_ID, ...SettingSchema.parse(setting) });
  }

  // ---- 统计与备份 ----

  async countRecords(): Promise<TableCounts> {
    const [courses, notes, chapters, images, transcripts] = await Promise.all([
      this.db.courses.count(),
      this.db.notes.count(),
      this.db.chapters.count(),
      this.db.images.count(),
      this.db.transcripts.count(),
    ]);
    return { courses, notes, chapters, images, transcripts };
  }

  async exportAll(): Promise<BackupData> {
    const [courses, notes, chapters, settings, images, transcripts] = await Promise.all([
      this.db.courses.toArray(),
      this.db.notes.toArray(),
      this.db.chapters.toArray(),
      this.getSetting(),
      this.db.images.toArray(),
      this.db.transcripts.toArray(),
    ]);
    const imageMap: BackupData['images'] = {};
    for (const img of images) {
      imageMap[img.id] = {
        dataUrl: await blobToDataUrl(img.blob),
        width: img.width,
        height: img.height,
      };
    }
    return {
      version: BACKUP_VERSION,
      exportedAt: Date.now(),
      courses,
      notes,
      chapters,
      settings,
      images: imageMap,
      transcripts,
    };
  }

  async importAll(data: BackupData): Promise<TableCounts> {
    const parsed = BackupDataSchema.parse(data);
    const imageRecords = Object.entries(parsed.images).map(([id, img]) => ({
      id,
      blob: dataUrlToBlob(img.dataUrl),
      width: img.width,
      height: img.height,
    }));
    await this.db.transaction(
      'rw',
      [
        this.db.courses,
        this.db.notes,
        this.db.chapters,
        this.db.images,
        this.db.settings,
        this.db.transcripts,
      ],
      async () => {
        await this.db.courses.bulkPut(parsed.courses);
        await this.db.notes.bulkPut(parsed.notes);
        await this.db.chapters.bulkPut(parsed.chapters);
        await this.db.images.bulkPut(imageRecords);
        await this.db.settings.put({ id: SETTING_ID, ...parsed.settings });
        await this.db.transcripts.bulkPut(parsed.transcripts);
      },
    );
    return {
      courses: parsed.courses.length,
      notes: parsed.notes.length,
      chapters: parsed.chapters.length,
      images: imageRecords.length,
      transcripts: parsed.transcripts.length,
    };
  }
}
