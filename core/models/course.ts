import { z } from 'zod';

export const PlatformSchema = z.enum([
  'bilibili',
  'icourse163',
  'xuetangx',
  'zhihuishu',
  'youtube',
  'generic',
]);
export type Platform = z.infer<typeof PlatformSchema>;

export const CourseSchema = z.object({
  id: z.string().min(1),
  platform: PlatformSchema,
  title: z.string().min(1),
  url: z.url(),
  coverUrl: z.url().optional(),
  /** AI 生成的整课概述；未生成及旧数据为空串 */
  summary: z.string().default(''),
  /** 用户改过标题后锁定：页面侧重建的标题不再覆盖（旧数据缺省为 false） */
  titleLocked: z.boolean().default(false),
  updatedAt: z.number().int().nonnegative(),
});
export type Course = z.infer<typeof CourseSchema>;
