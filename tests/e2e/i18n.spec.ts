import path from 'node:path';
import { expect, test, chromium, type BrowserContext } from '@playwright/test';

/** 扩展构建产物（pnpm build 产物目录） */
const EXT_PATH = path.resolve('.output/chrome-mv3');

/**
 * 界面语言冒烟：setting.language='auto' 时面板跟随浏览器 UI 语言。
 * 手动指定/回退的路径由单元测试覆盖（resolveLocale/detectLocale），此处验证真实浏览器端到端。
 */
async function launchWithLocale(locale: string): Promise<{
  context: BrowserContext;
  extensionId: string;
}> {
  const context = await chromium.launchPersistentContext('', {
    // channel: 'chromium' 用完整版浏览器（headless shell 不支持扩展）
    channel: 'chromium',
    headless: true,
    locale,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  return { context, extensionId: new URL(sw.url()).host };
}

test.describe('界面语言跟随浏览器 UI 语言', () => {
  test('中文环境显示中文面板', async () => {
    const { context, extensionId } = await launchWithLocale('zh-CN');
    try {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await expect(page.getByText('全部课程')).toBeVisible();
      await expect(page).toHaveTitle('学知云课记');
    } finally {
      await context.close();
    }
  });

  test('英文环境显示英文面板（XZY Notes）', async () => {
    const { context, extensionId } = await launchWithLocale('en-US');
    try {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await expect(page.getByText('All Courses')).toBeVisible();
      await expect(page).toHaveTitle('XZY Notes');
    } finally {
      await context.close();
    }
  });
});
