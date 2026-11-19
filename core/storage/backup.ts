import { z } from 'zod';
import { ChapterSchema } from '../models/chapter';
import { CourseSchema } from '../models/course';
import { NoteSchema } from '../models/note';
import { SettingSchema } from '../models/setting';
import { TranscriptSchema } from '../models/transcript';

/** 备份文件格式版本 */
export const BACKUP_VERSION = 1;

export const BackupImageSchema = z.object({
  dataUrl: z.string().startsWith('data:'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/** 全量备份数据（zip 内的 backup.json 内容） */
export const BackupDataSchema = z.object({
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.number().int().nonnegative(),
  courses: z.array(CourseSchema),
  notes: z.array(NoteSchema),
  chapters: z.array(ChapterSchema),
  settings: SettingSchema,
  /** imageId → 图片（dataURL 形态，zip 打包时转二进制） */
  images: z.record(z.string(), BackupImageSchema),
  /** 本地语音转写结果；旧版本备份无此字段，导入时按空数组处理 */
  transcripts: z.array(TranscriptSchema).default([]),
});
export type BackupData = z.infer<typeof BackupDataSchema>;

/** 各表记录数（存储占用可视化 / 导入结果计数） */
export interface TableCounts {
  courses: number;
  notes: number;
  chapters: number;
  images: number;
  transcripts: number;
}
