import type { Theme } from '~/core/models';

/** 应用主题到当前扩展页面（panel/options 共用）；auto 跟随系统 */
export function applyTheme(theme: Theme): void {
  const dark =
    theme === 'dark' ||
    (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
