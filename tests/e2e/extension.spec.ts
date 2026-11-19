import path from 'node:path';
import { expect, test as base, chromium, type BrowserContext } from '@playwright/test';
import { createTranslator, type MessageKey } from '../../core/i18n';

/** 扩展构建产物（pnpm build 产物目录） */
const EXT_PATH = path.resolve('.output/chrome-mv3');

/** 扩展页内的 chrome.runtime.sendMessage 调用类型（页面上下文无扩展类型定义） */
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
  tabs: {
    query(queryInfo: { url?: string }): Promise<Array<{ id?: number; windowId: number; url?: string }>>;
  };
};

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      // channel: 'chromium' 用完整版浏览器（headless shell 不支持扩展）
      channel: 'chromium',
      headless: true,
      // 面板默认跟随浏览器 UI 语言（setting.language='auto'），固定中文环境以断言中文文案
      locale: 'zh-CN',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await use(new URL(sw.url()).host);
  },
});

test('扩展加载：后台 service worker 注册成功', async ({ extensionId }) => {
  expect(extensionId).toBeTruthy();
});

test('后台存储服务往返：sidepanel 页消息 → setting:get 返回默认设置', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // 面板骨架渲染（无视频页时应显示首页/空态而非白屏）
  await expect(page.getByText('全部课程')).toBeVisible();

  const resp = (await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'setting:get' }),
  )) as { ok: boolean; data: { shortcuts: Record<string, string> } };
  expect(resp.ok).toBe(true);
  expect(resp.data.shortcuts.capture).toBe('Alt+S');
});

test('B站真实视频页：内容脚本注入并挂载悬浮按钮', async ({ context }) => {
  // Node 侧取当前热门视频，避免写死的 BV 号失效
  let bvid: string | null;
  try {
    const resp = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=1', {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com' },
    });
    const json = (await resp.json()) as { data?: { list?: Array<{ bvid?: string }> } };
    bvid = json.data?.list?.[0]?.bvid ?? null;
  } catch {
    bvid = null;
  }
  if (!bvid) {
    test.skip(true, '无法访问 B站 API（离线环境跳过）');
    return;
  }

  const page = await context.newPage();
  await page.goto(`https://www.bilibili.com/video/${bvid}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  // 内容脚本注入 + 悬浮按钮挂载
  await expect(page.locator('#kedaibiao-launcher')).toBeVisible({ timeout: 20_000 });
});

test('通用 HTML5 视频页：未激活时 panel:init 优雅降级（新文案引导激活）', async ({
  context,
  extensionId,
}) => {
  // 伪造一个非内置平台的 https 视频页（manifest matches 不含它，无自动注入）
  await context.route('https://generic-test.example/video', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>通用视频页</title><video src="a.mp4"></video>',
    });
  });
  const videoPage = await context.newPage();
  await videoPage.goto('https://generic-test.example/video');
  await expect(videoPage.locator('video')).toHaveCount(1);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // panel:init 解析的是「窗口活动标签页」，先把视频页切回前台
  await videoPage.bringToFront();

  const resp = (await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://generic-test.example/*' });
    const tab = tabs[0];
    if (!tab) return { ok: false, error: 'test setup: 未找到视频页标签' };
    return chrome.runtime.sendMessage({ type: 'panel:init', windowId: tab.windowId });
  })) as { ok: boolean; error?: string };

  // 无激活手势（activeTab 未授予）→ 按需注入被拒 → 返回引导激活的新文案，
  // 而非旧的「当前页面不是支持的视频页（支持 B站 / 中国大学MOOC / 学堂在线 / 智慧树）」
  // 注意：后台错误统一是文案 key，由展示端 localizeError 翻译，断言前先翻译
  expect(resp.ok).toBe(false);
  const message = createTranslator('zh-CN')(resp.error as MessageKey);
  expect(message).toContain('激活');
  expect(message).not.toContain('不是支持的视频页');
});
