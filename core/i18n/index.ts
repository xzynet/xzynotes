import { zhCN } from './messages/zh-CN';
import { en } from './messages/en';

/**
 * 应用层 i18n（纯 TS，无 browser API —— core 纯净性铁律）。
 * 语言来源由入口层解析：browser.i18n.getUILanguage() → detectLocale，
 * 叠加设置里的手动指定（'auto' | 'zh-CN' | 'en'）→ resolveLocale。
 * 新增语言：加 messages/<locale>.ts 字典 + Locale 联合成员 + _locales 目录。
 */

export type AppLanguage = 'auto' | 'zh-CN' | 'en';
export type Locale = 'zh-CN' | 'en';
export type MessageKey = keyof typeof zhCN;
export type MessageParams = Record<string, string | number>;

/** 浏览器/系统 UI 语言 → 支持的语言；中文各变体（zh-TW/zh-HK 等）归 zh-CN，其余回退英文 */
export function detectLocale(uiLanguage: string): Locale {
  return uiLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** 设置项 + 系统语言 → 实际生效语言 */
export function resolveLocale(language: AppLanguage, uiLanguage: string): Locale {
  return language === 'auto' ? detectLocale(uiLanguage) : language;
}

const DICTS: Record<Locale, Record<MessageKey, string>> = { 'zh-CN': zhCN, en };

/** 取文案并做 {name} 占位符插值；异常时回退中文、再回退 key 本身 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  let text: string = DICTS[locale][key] ?? zhCN[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

export type Translator = (key: MessageKey, params?: MessageParams) => string;

export function createTranslator(locale: Locale): Translator {
  return (key, params) => translate(locale, key, params);
}

/** err.message 是否为注册过的文案 key（跨层错误用 key 抛掷，展示边界再翻译） */
export function isMessageKey(text: string): text is MessageKey {
  return text in zhCN;
}

/** 错误本地化：message 是已知 key 则翻译，否则原样透传（行为不回归） */
export function localizeError(t: Translator, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return isMessageKey(message) ? t(message) : message;
}
