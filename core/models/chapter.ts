import { z } from 'zod';

export const ChapterSourceSchema = z.enum(['rule', 'ai', 'manual']);
export type ChapterSource = z.infer<typeof ChapterSourceSchema>;

export const ChapterSchema = z.object({
  id: z.string().min(1),
  courseId: z.string().min(1),
  title: z.string(),
  startSec: z.number().nonnegative(),
  source: ChapterSourceSchema,
  /** AI 生成的章节摘要；规则/手动章节及旧数据为空串 */
  summary: z.string().default(''),
});
export type Chapter = z.infer<typeof ChapterSchema>;
