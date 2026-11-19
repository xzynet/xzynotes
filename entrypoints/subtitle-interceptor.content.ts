/**
 * MAIN world 拦截器（MOOC / 学堂在线 / YouTube）：包装页面的 fetch / XMLHttpRequest，
 * 把字幕相关接口的响应体通过 postMessage 送回隔离世界的 content script。
 * 只读响应、不改请求，对页面零侵入。
 * （B站字幕走 wbi API 直取，不需要拦截器。YouTube 兜底路径：用户开 CC 后
 * 播放器自拉的 /api/timedtext 响应会被这里捕获，主路径仍是 captionTracks 直取。）
 */
export default defineContentScript({
  matches: ['*://*.icourse163.org/*', '*://*.xuetangx.com/*', '*://*.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const SUBTITLE_RE = /getVideoSubtitle|downloadVideoSrt|\.srt(\?|$)|\.vtt(\?|$)|subtitle|caption|timedtext/i;

    // 调试出口：页面控制台可用 window.__kedaibiaoSubtitles 查看/导出完整捕获原文
    interface KedaibiaoDebugWindow extends Window {
      __kedaibiaoSubtitles?: Array<{ url: string; text: string; requestBody?: string }>;
    }

    function post(url: string, text: string, requestBody?: string): void {
      const w = window as KedaibiaoDebugWindow;
      (w.__kedaibiaoSubtitles ??= []).push({ url, text, requestBody });
      window.postMessage({ source: 'kedaibiao-subtitle', url, text, requestBody }, location.origin);
    }

    /** 把各种形态的请求体转成字符串（用于诊断） */
    function bodyToString(body: unknown): string | undefined {
      if (typeof body === 'string') return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof FormData) {
        return [...body.entries()].map(([k, v]) => `${k}=${String(v)}`).join('&');
      }
      return undefined;
    }

    // ---- fetch ----
    const boundFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const resp = await boundFetch(...args);
      try {
        const input = args[0];
        const url =
          typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (SUBTITLE_RE.test(url)) {
          const init = args[1];
          const reqBody = bodyToString(init?.body);
          const text = await resp.clone().text();
          post(url, text, reqBody);
        }
      } catch {
        // 拦截失败不影响原请求
      }
      return resp;
    };

    // ---- XMLHttpRequest ----
    const xhrUrls = new WeakMap<XMLHttpRequest, string>();
    const origOpen = XMLHttpRequest.prototype.open;
    const looseOpen = origOpen as (...args: unknown[]) => void;
    XMLHttpRequest.prototype.open = function (...args: unknown[]) {
      xhrUrls.set(this, String(args[1]));
      return looseOpen.apply(this, args);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const url = xhrUrls.get(this);
      if (url && SUBTITLE_RE.test(url)) {
        const reqBody = bodyToString(body);
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              post(url, this.responseText, reqBody);
            }
          } catch {
            // 忽略二进制响应
          }
        });
      }
      origSend.call(this, body);
    };
  },
});
