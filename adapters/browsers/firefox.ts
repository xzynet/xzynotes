import { browser } from 'wxt/browser';
import { dataUrlToBlob } from '../../core/utils/dataurl';
import type { BrowserAdapter } from './base';

/** webext 类型不含 Firefox 专有的 sidebarAction，手动补型 */
interface SidebarActionApi {
  open(): Promise<void>;
  toggle(): Promise<void>;
}

const sidebarAction = (): SidebarActionApi | undefined =>
  (browser as unknown as { sidebarAction?: SidebarActionApi }).sidebarAction;

/**
 * Firefox 适配（V1.1 启用）：sidebarAction 替代 sidePanel。
 * 当前版本 Firefox MV3 构建走 event page 模型，本实现保持接口对齐。
 */
export class FirefoxBrowserAdapter implements BrowserAdapter {
  openSidebar(): void {
    sidebarAction()
      ?.open()
      .catch((e: unknown) => {
        console.warn('[kedaibiao] 打开侧栏失败：', e);
      });
  }

  toggleSidebar(): void {
    sidebarAction()
      ?.toggle()
      .catch((e: unknown) => {
        console.warn('[kedaibiao] 切换侧栏失败：', e);
      });
  }

  async captureVisibleTab(windowId?: number): Promise<Blob> {
    const dataUrl = (await browser.tabs.captureVisibleTab(
      windowId ?? browser.windows.WINDOW_ID_CURRENT,
      { format: 'jpeg', quality: 85 },
    )) as unknown as string;
    return dataUrlToBlob(dataUrl);
  }

  notify(msg: string): void {
    void browser.runtime
      .sendMessage({ type: 'toast', level: 'info', text: msg })
      .catch(() => {});
  }
}
