import { ChromiumBrowserAdapter } from './chromium';
import { FirefoxBrowserAdapter } from './firefox';
import type { BrowserAdapter } from './base';

/** 按构建目标返回对应 BrowserAdapter */
export function createBrowserAdapter(): BrowserAdapter {
  return import.meta.env.FIREFOX ? new FirefoxBrowserAdapter() : new ChromiumBrowserAdapter();
}

export type { BrowserAdapter } from './base';
