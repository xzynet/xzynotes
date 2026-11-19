import type { Chapter } from '../models/chapter';
import type { Course } from '../models/course';
import type { Image } from '../models/image';
import type { Note } from '../models/note';
import type { Setting } from '../models/setting';
import type { Transcript } from '../models/transcript';
import type { BackupData, TableCounts } from './backup';

/**
 * 存储接口：core 内唯一的持久化抽象。
 * 业务代码只依赖本接口，实现可替换（当前为 Dexie/IndexedDB）。
 */
export interface IStorage {
  // Course
  getCourse(id: string): Promise<Course | undefined>;
  upsertCourse(course: Course): Promise<void>;
  /** 按 updatedAt 倒序 */
  listCourses(): Promise<Course[]>;
  /** 级联删除该课程的笔记、章节及笔记引用的截图 */
  deleteCourse(id: string): Promise<void>;
  /**
   * 整课改挂：课程行迁到 newId，笔记/章节/转写的 courseId 一并改（图片被笔记引用，不动）。
   * oldId 不存在或 newId 已有课程时不做合并，返回 false。
   */
  rekeyCourse(oldId: string, newId: string): Promise<boolean>;

  // Note
  addNote(note: Note): Promise<void>;
  updateNote(id: string, patch: Partial<Omit<Note, 'id' | 'courseId'>>): Promise<void>;
  getNote(id: string): Promise<Note | undefined>;
  /** 同时删除其引用的截图 */
  deleteNote(id: string): Promise<void>;
  /** 按 timestampSec 升序 */
  listNotesByCourse(courseId: string): Promise<Note[]>;

  // Chapter
  /** 全量替换某课程的章节（切分引擎产出后落库） */
  replaceChapters(courseId: string, chapters: Chapter[]): Promise<void>;
  /** 按 startSec 升序 */
  listChaptersByCourse(courseId: string): Promise<Chapter[]>;

  // Transcript（本地语音转写结果，无字幕课程的兜底字幕源；一课一份）
  getTranscript(courseId: string): Promise<Transcript | undefined>;
  /** 覆盖式保存（同课程新转写覆盖旧转写） */
  saveTranscript(transcript: Transcript): Promise<void>;

  // Image
  putImage(image: Image): Promise<void>;
  getImage(id: string): Promise<Image | undefined>;
  deleteImage(id: string): Promise<void>;

  // Setting（全局单例；不存在时返回 DEFAULT_SETTING）
  getSetting(): Promise<Setting>;
  saveSetting(setting: Setting): Promise<void>;

  // 统计与备份
  /** 各表记录数（存储占用可视化用） */
  countRecords(): Promise<TableCounts>;
  /** 全量导出（备份） */
  exportAll(): Promise<BackupData>;
  /** 全量导入（备份恢复，按 id 覆盖合并）；返回各类记录导入数 */
  importAll(data: BackupData): Promise<TableCounts>;
}
