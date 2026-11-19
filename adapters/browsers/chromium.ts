import { browser } from 'wxt/browser';
import { dataUrlToBlob } from '../../core/utils/dataurl';
import type { BrowserAdapter } from './base';

/** Chrome / Edge：sidePanel + captureVisibleTab */
export class ChromiumBrowserAdapter implements BrowserAdapter {
  openSidebar(windowId?: number): void {
    browser.sidePanel
      .open({ windowId: windowId ?? browser.windows.WINDOW_ID_CURRENT })
      .catch((e: unknown) => {
        console.warn('[kedaibiao] 打开侧栏失败：', e);
      });
  }

  /** Chrome 侧栏无编程关闭 API，toggle 等价于 open（Chrome 116+） */
  toggleSidebar(windowId?: number): void {
    this.openSidebar(windowId);
  }

  async captureVisibleTab(windowId?: number): Promise<Blob> {
    try {
      const dataUrl = (await browser.tabs.captureVisibleTab(
        windowId ?? browser.windows.WINDOW_ID_CURRENT,
        { format: 'jpeg', quality: 85 },
      )) as unknown as string;
      return dataUrlToBlob(dataUrl);
    } catch (e) {
      throw new Error(
        `整页截图失败（可能被浏览器权限拦截）：${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  notify(msg: string): void {
    void browser.runtime
      .sendMessage({ type: 'toast', level: 'info', text: msg })
      .catch(() => {});
  }
}
