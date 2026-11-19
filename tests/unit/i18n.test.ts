import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  detectLocale,
  isMessageKey,
  localizeError,
  resolveLocale,
  translate,
  type MessageKey,
} from '../../core/i18n';
import { zhCN } from '../../core/i18n/messages/zh-CN';
import { en } from '../../core/i18n/messages/en';

describe('detectLocale · 系统语言 → 支持语言', () => {
  it('中文各变体归 zh-CN', () => {
    for (const tag of ['zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans', 'zh']) {
      expect(detectLocale(tag)).toBe('zh-CN');
    }
  });

  it('非中文（含未支持语言）回退英文', () => {
    for (const tag of ['en', 'en-US', 'ja-JP', 'de-DE', 'fr', '']) {
      expect(detectLocale(tag)).toBe('en');
    }
  });
});

describe('resolveLocale · 设置项叠加系统语言', () => {
  it('auto 跟随系统', () => {
    expect(resolveLocale('auto', 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale('auto', 'en-US')).toBe('en');
    expect(resolveLocale('auto', 'ja-JP')).toBe('en');
  });

  it('手动指定优先于系统', () => {
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
  });
});

describe('translate · 取文案与插值', () => {
  it('按 locale 取文案', () => {
    expect(translate('zh-CN', 'brand.name')).toBe('学知云课记');
    expect(translate('en', 'brand.name')).toBe('XZY Notes');
  });

  it('{name} 占位符插值，支持数字', () => {
    expect(translate('en', 'options.llmTestSuccess', { model: 'gpt-4o' })).toBe(
      'Connected: gpt-4o',
    );
    expect(translate('zh-CN', 'export.footerCredit', { brand: 'X' })).toBe('由「X」插件生成');
  });

  it('未知 key 回退 key 本身（防御）', () => {
    expect(translate('en', 'no.such.key' as MessageKey)).toBe('no.such.key');
  });

  it('createTranslator 闭包绑定 locale', () => {
    const t = createTranslator('en');
    expect(t('common.save')).toBe('Save');
    expect(createTranslator('zh-CN')('common.save')).toBe('保存');
  });
});

describe('字典对齐', () => {
  it('en 与 zhCN 的 key 完全一致且值非空', () => {
    const zhKeys = Object.keys(zhCN).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(zhKeys);
    for (const key of zhKeys) {
      expect(zhCN[key as MessageKey].length, `zhCN ${key}`).toBeGreaterThan(0);
      expect(en[key as MessageKey].length, `en ${key}`).toBeGreaterThan(0);
    }
  });

  it('en 译文不含中文（漏译检测）', () => {
    for (const [key, text] of Object.entries(en)) {
      expect(/[\u4e00-\u9fff]/.test(text), `en ${key} 含中文`).toBe(false);
    }
  });
});

describe('localizeError · 跨层错误翻译', () => {
  const t = createTranslator('en');

  it('message 是已注册 key 时翻译', () => {
    expect(localizeError(t, new Error('err.noVideoElement'))).toBe(
      translate('en', 'err.noVideoElement'),
    );
  });

  it('未知 message 原样透传', () => {
    expect(localizeError(t, new Error('HTTP 500'))).toBe('HTTP 500');
    expect(localizeError(t, new Error('笔记不存在'))).toBe('笔记不存在');
  });

  it('非 Error 值转字符串处理', () => {
    expect(localizeError(t, 'common.requestFailed')).toBe('Request failed');
    expect(localizeError(t, 42)).toBe('42');
  });

  it('isMessageKey 类型守卫', () => {
    expect(isMessageKey('brand.name')).toBe(true);
    expect(isMessageKey('brand.name.z')).toBe(false);
  });
});
