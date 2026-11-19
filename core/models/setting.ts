import { z } from 'zod';

export const CommandSchema = z.enum([
  'capture',
  'captureAnnotate',
  'newNote',
  'togglePanel',
  'bookmark',
]);
export type Command = z.infer<typeof CommandSchema>;

export const ShortcutsSchema = z.object({
  capture: z.string().min(1),
  captureAnnotate: z.string().min(1),
  newNote: z.string().min(1),
  togglePanel: z.string().min(1),
  bookmark: z.string().min(1),
}) satisfies z.ZodType<Record<Command, string>>;

export const ThemeSchema = z.enum(['auto', 'light', 'dark']);
export type Theme = z.infer<typeof ThemeSchema>;

/** 界面语言：auto 跟随系统 */
export const LanguageSchema = z.enum(['auto', 'zh-CN', 'en']);
export type Language = z.infer<typeof LanguageSchema>;

export const ExportPrefsSchema = z.object({
  embedImage: z.enum(['base64', 'file']),
  footerCredit: z.boolean(),
});

export const CapturePrefsSchema = z.object({
  /** JPEG 截图质量（0.3–1.0），默认 0.85 */
  quality: z.number().min(0.3).max(1),
});

/** OpenAI 兼容大模型配置；model/apiToken 为空串表示未配置 */
export const LlmConfigSchema = z.object({
  baseUrl: z.string(),
  model: z.string(),
  apiToken: z.string(),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  apiToken: '',
};

export const SettingSchema = z.object({
  shortcuts: ShortcutsSchema,
  theme: ThemeSchema,
  exportPrefs: ExportPrefsSchema,
  /** 旧数据无此字段，parse 时自动补默认值 */
  capturePrefs: CapturePrefsSchema.default({ quality: 0.85 }),
  /** 旧数据无此字段，parse 时自动补默认值 */
  llm: LlmConfigSchema.default(DEFAULT_LLM_CONFIG),
  /** 旧数据无此字段，parse 时自动补默认值 */
  language: LanguageSchema.default('auto'),
});
export type Setting = z.infer<typeof SettingSchema>;

/** 默认设置：快捷键与功能需求 7.1/7.2 对齐 */
export const DEFAULT_SETTING: Setting = {
  shortcuts: {
    capture: 'Alt+S',
    captureAnnotate: 'Alt+A',
    newNote: 'Alt+N',
    togglePanel: 'Alt+K',
    bookmark: 'Alt+B',
  },
  theme: 'auto',
  exportPrefs: { embedImage: 'base64', footerCredit: true },
  capturePrefs: { quality: 0.85 },
  llm: DEFAULT_LLM_CONFIG,
  language: 'auto',
};
