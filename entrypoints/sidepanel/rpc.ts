import { browser } from 'wxt/browser';
import type { ApiResponse, RequestMessage } from '~/core/messages';

/** 面板 → 后台的统一请求入口：失败时抛出用户可读错误 */
export async function send<T>(msg: RequestMessage): Promise<T> {
  const resp = (await browser.runtime.sendMessage(msg)) as ApiResponse<T> | undefined;
  if (!resp?.ok) throw new Error(resp?.error ?? 'common.requestFailed');
  return resp.data;
}
