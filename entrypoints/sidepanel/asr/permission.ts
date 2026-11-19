import { browser } from 'wxt/browser';

/**
 * 媒体源跨域授权策略。
 *
 * 下载/流式读取媒体时 CORS 被拒（TypeError）后需要该源的 host 权限重试：
 * - 面板内：当场 `permissions.request` 弹窗申请（必须处在用户手势链路里，故只在点击后触发）；
 * - 宿主（offscreen）：弹窗 API 在手势之外不可用，只能查「是否已授权」——
 *   未授权时任务失败并回 `asrErr.mediaSourceNotAuthorized`，由面板在用户点击后授权再重跑
 *   （见 AsrCard 的「授权媒体源并重试」）。
 */
export type CorsAuthorizer = (origin: string) => Promise<boolean>;

/** 面板侧：弹窗申请（用户手势链路内调用） */
export const panelAuthorizer: CorsAuthorizer = (origin) =>
  browser.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);

/** 宿主侧：只查已授权（不能弹窗） */
export const hostAuthorizer: CorsAuthorizer = (origin) =>
  browser.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false);

/** 面板侧：一次申请多个源的 host 权限（必须由用户点击触发，故只在按钮链路里调用） */
export function requestOrigins(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return Promise.resolve(false);
  return browser.permissions
    .request({ origins: origins.map((o) => `${o}/*`) })
    .catch(() => false);
}
