/**
 * MAIN world 拦截器（mooc-interceptor.content.ts）通过 postMessage
 * 送回的响应体缓存。运行在隔离世界的 content script 里。
 *
 * MOOC 字幕分段加载：同一接口随播放进度多次返回不同内容，
 * 因此累积保存所有捕获（同 URL + 同内容视为重复抓取，跳过）。
 */

export interface CapturedSubtitlePayload {
  url: string;
  text: string;
  /** 请求体（POST 分页参数诊断用） */
  requestBody?: string;
}

const captured: CapturedSubtitlePayload[] = [];
let listening = false;
let onCapture: (() => void) | null = null;

/** 开始监听；onNewPayload 在每次捕获到新内容时触发 */
export function startSubtitleCaptureListener(onNewPayload?: () => void): void {
  if (onNewPayload) onCapture = onNewPayload;
  if (listening) return;
  listening = true;
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data as
      | { source?: string; url?: string; text?: string; requestBody?: string }
      | null;
    if (!data || data.source !== 'kedaibiao-subtitle') return;
    if (typeof data.url !== 'string' || typeof data.text !== 'string') return;
    if (captured.some((p) => p.url === data.url && p.text === data.text)) return;
    captured.push({ url: data.url, text: data.text, requestBody: data.requestBody });
    console.log(
      `[kedaibiao] 捕获字幕分段 #${captured.length}（${data.text.length} 字符）` +
        `${data.requestBody ? `，请求体: ${data.requestBody.slice(0, 200)}` : ''}：` +
        `${data.url.slice(0, 120)}`,
    );
    onCapture?.();
  });
}

export function getCapturedSubtitlePayloads(): CapturedSubtitlePayload[] {
  return captured.slice();
}
