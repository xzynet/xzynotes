import { z } from 'zod';
import { SubtitleCueSchema } from './subtitle';

/**
 * 本地语音转写结果（sherpa-onnx WASM ASR 产出）。
 * 无字幕课程的兜底字幕来源；一门课程只保留最新一次转写（id 即 courseId）。
 */
export const TranscriptSchema = z.object({
  /** 记录 id，约定等于 courseId（一课一份，覆盖式保存） */
  id: z.string().min(1),
  courseId: z.string().min(1),
  /** 产出所用的 ASR 模型 id（core/asr/models.ts 的 AsrModelId） */
  modelId: z.string().min(1),
  cues: z.array(SubtitleCueSchema),
  /** 本次转写覆盖的音频时长（秒） */
  durationSec: z.number().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;
