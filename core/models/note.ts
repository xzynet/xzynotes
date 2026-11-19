import { z } from 'zod';

export const NoteTypeSchema = z.enum(['screenshot', 'text', 'bookmark']);
export type NoteType = z.infer<typeof NoteTypeSchema>;

export const NoteSchema = z.object({
  id: z.string().min(1),
  courseId: z.string().min(1),
  type: NoteTypeSchema,
  /** 视频内时间点（秒） */
  timestampSec: z.number().nonnegative(),
  /** 文字内容 */
  content: z.string(),
  /** 截图存独立 Image 表，面板内懒加载 */
  imageId: z.string().min(1).optional(),
  /** V1.5 OCR 文本 */
  ocrText: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Note = z.infer<typeof NoteSchema>;
