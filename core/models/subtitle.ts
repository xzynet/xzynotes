import { z } from 'zod';

/** 平台字幕的一个分句（PlatformAdapter.getSubtitles 的返回元素） */
export const SubtitleCueSchema = z.object({
  /** 开始时间（秒） */
  start: z.number().nonnegative(),
  /** 结束时间（秒） */
  end: z.number().nonnegative(),
  text: z.string(),
});
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>;
