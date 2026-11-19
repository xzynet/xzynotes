/**
 * 浏览器差异收敛接口：侧栏 / 整页截图 / 通知。
 * 实现运行在后台（service worker / event page）上下文。
 */
export interface BrowserAdapter {
  openSidebar(windowId?: number): void;
  toggleSidebar(windowId?: number): void;
  /** DRM/跨域导致 canvas 抓帧失败时的降级方案（需 activeTab 授权） */
  captureVisibleTab?(windowId?: number): Promise<Blob>;
  /** 用户可读通知（面板内 toast 广播；面板未打开时静默丢弃） */
  notify(msg: string): void;
}
