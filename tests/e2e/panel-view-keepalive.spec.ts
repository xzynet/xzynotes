import path from 'node:path';
import { expect, test as base, chromium, type BrowserContext, type Page } from '@playwright/test';

/** 扩展构建产物（pnpm build 产物目录） */
const EXT_PATH = path.resolve('.output/chrome-mv3');

/** 扩展页内的 chrome.*（页面上下文无扩展类型定义） */
declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
  windows: { getCurrent(): Promise<{ id?: number }> };
};

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      // channel: 'chromium' 用完整版浏览器（headless shell 不支持扩展）
      channel: 'chromium',
      headless: true,
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

/** 面板课程视图只在收到后台 course:context 广播后才渲染，这里伪造一份（无需真实视频页） */
const FAKE_CONTEXT = {
  course: {
    id: 'test-course-keepalive',
    platform: 'generic',
    title: '测试课程',
    url: 'https://example.invalid/video',
    summary: '',
  },
  tabId: 999_999,
  windowId: -1,
  degraded: false,
};

/** 从另一个扩展页发一次课程上下文广播（runtime.onMessage 会派发到同扩展的其他页面） */
async function pushContext(sender: Page, windowId: number, context: unknown): Promise<void> {
  await sender.evaluate(
    async (payload) => {
      try {
        await chrome.runtime.sendMessage({ type: 'course:context', ...payload });
      } catch {
        // 后台没有该消息的处理分支时会 reject，不影响面板侧收广播
      }
    },
    { windowId, context },
  );
}

/**
 * 离开「当前课程」页不卸载转写卡片：转写任务跑在 AsrCard 里（引擎 worker + 媒体流），
 * 卡片一旦被卸载就会 dispose 引擎、终止正在进行的转写。这里锁住该不变量——
 * 切到「全部课程」后卡片只是被 CSS 隐藏，仍挂在 DOM 上（数量仍为 1、且不重复挂载）。
 */
test('离开当前课程页：转写卡片保持挂载（仅隐藏），且无重复实例', async ({
  context,
  extensionId,
}) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByRole('button', { name: '全部课程' })).toBeVisible();

  const windowId = (await panel.evaluate(() => chrome.windows.getCurrent().then((w) => w.id))) as
    | number
    | undefined;
  expect(windowId).toBeTruthy();

  // 伪造课程上下文（面板需等 init 注册好监听器，故轮询重发几次）
  const sender = await context.newPage();
  await sender.goto(`chrome-extension://${extensionId}/options.html`);
  await expect
    .poll(
      async () => {
        await pushContext(sender, windowId!, FAKE_CONTEXT);
        return panel.getByText('测试课程').count();
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  // 无平台字幕 + 无本地转写缓存 → 落到「无字幕兜底」并挂出转写卡片。
  // 面板初始停在「全部课程」，课程视图此时已常驻挂载（仅隐藏）——先切过去看它的可见态
  const cardTitle = panel.getByText('本地语音转写（无字幕兜底）');
  await panel.getByRole('button', { name: '当前课程' }).click();
  await expect(cardTitle).toBeVisible({ timeout: 20_000 });
  await expect(cardTitle).toHaveCount(1);

  // 切回「全部课程」：卡片只是隐藏，仍在 DOM 上（未卸载 → 转写任务不会被 dispose）
  await panel.getByRole('button', { name: '全部课程' }).click();
  await expect(panel.getByText('还没有记录任何课程')).toBeVisible();
  await expect(cardTitle).toBeHidden();
  await expect(cardTitle).toHaveCount(1);

  // 再切回「当前课程」：同一份卡片重新可见，且没有出现第二个实例
  await panel.getByRole('button', { name: '当前课程' }).click();
  await expect(cardTitle).toBeVisible();
  await expect(cardTitle).toHaveCount(1);
});
