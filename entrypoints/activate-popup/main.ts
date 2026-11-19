import { browser } from 'wxt/browser';
import { createTranslator, detectLocale, resolveLocale, type Locale } from '~/core/i18n';
import type { ApiResponse, RequestMessage } from '~/core/messages';
import type { Setting } from '~/core/models';

/**
 * 激活反馈弹窗：侧栏「等待激活」期间该 tab 的工具栏图标被切换成此弹窗，
 * 用户点图标即弹出本页。「点击图标」本身就是 Chrome 认可的激活手势
 * （activeTab 语义），弹窗打开即完成激活。本页只做两件事：给出即时反馈，
 * 并通知后台清除本 tab 的弹窗覆盖，让图标恢复「打开侧栏」
 * （chrome.action 在各页面上下文可用性不一，清除统一由后台代劳）。
 */

const msg: RequestMessage = { type: 'asr:clearActivationPopup' };
void browser.runtime.sendMessage(msg).catch(() => {
  // 清除失败无碍本次激活：侧栏在激活成功/取消/切课时也会恢复图标行为
});
window.setTimeout(() => window.close(), 2500);

/**
 * 纯静态页无 React：解析语言后直接改写 DOM 文案与 document.title。
 * HTML 中保留的中文原文即无 JS / 后台不可达时的兜底，此处失败不影响激活流程。
 */
async function applyLocale(): Promise<void> {
  let locale: Locale = detectLocale(browser.i18n.getUILanguage());
  try {
    const resp = (await browser.runtime.sendMessage({
      type: 'setting:get',
    })) as ApiResponse<Setting>;
    if (resp.ok) locale = resolveLocale(resp.data.language, browser.i18n.getUILanguage());
  } catch {
    // 后台不可达：按浏览器 UI 语言兜底
  }
  const t = createTranslator(locale);
  document.documentElement.lang = locale;
  document.title = t('popup.title');
  const activatedEl = document.getElementById('popup-activated');
  if (activatedEl) activatedEl.textContent = t('popup.activated');
  const descEl = document.getElementById('popup-desc');
  if (descEl) descEl.textContent = t('popup.desc');
}
void applyLocale();
