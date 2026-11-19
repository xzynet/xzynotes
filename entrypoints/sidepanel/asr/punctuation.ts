import type { PunctEvent, PunctRequest } from './punct.worker';

/**
 * 标点恢复服务（面板侧）：持有 punct.worker，提供文本 → 带标点文本。
 * 模型加载失败是非致命的（onFatal 通知上层降级为无标点转写）；
 * 单条推理失败只拒掉该条，不影响后续请求。
 */
export interface PunctService {
  /** 用缓存模型初始化 worker（幂等）；失败抛错 */
  init(model: ArrayBuffer, tokens: ArrayBuffer): Promise<void>;
  /** 单段文本恢复标点 */
  punctuate(text: string): Promise<string>;
  /** 等待所有在途推理完成（转写收尾前调用，保证 cues 已替换为带标点版本） */
  drain(): Promise<void>;
  dispose(): void;
  readonly ready: boolean;
}

interface PendingEntry {
  promise: Promise<string>;
  resolve: (text: string) => void;
  reject: (e: Error) => void;
}

export function createPunctService(onFatal: (message: string) => void): PunctService {
  let worker: Worker | null = null;
  let seq = 0;
  let ready = false;
  const pending = new Map<number, PendingEntry>();

  const failAll = (message: string) => {
    for (const [, p] of pending) p.reject(new Error(message));
    pending.clear();
  };

  return {
    get ready() {
      return ready;
    },

    init(model, tokens) {
      if (worker) return Promise.resolve();
      const w = new Worker(new URL('./punct.worker.ts', import.meta.url));
      worker = w;
      const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
        const onMessage = (e: MessageEvent<PunctEvent>) => {
          const ev = e.data;
          if (ev.type === 'ready') {
            ready = true;
            w.removeEventListener('message', onMessage);
            resolveReady();
          } else if (ev.type === 'error' && ev.fatal) {
            w.removeEventListener('message', onMessage);
            rejectReady(new Error(ev.message));
          }
        };
        w.addEventListener('message', onMessage);
      });
      w.onmessage = (e: MessageEvent<PunctEvent>) => {
        const ev = e.data;
        if (ev.type === 'punct') {
          const p = pending.get(ev.seq);
          if (p) {
            pending.delete(ev.seq);
            p.resolve(ev.text);
          }
        } else if (ev.type === 'error') {
          if (ev.fatal) {
            failAll(ev.message);
            // 初始化阶段的 fatal 已由 init 的 reject 上报（避免双重提示）；
            // 这里只上抛就绪之后发生的运行期致命错误
            if (ready) onFatal(ev.message);
          } else {
            // worker 内推理串行：失败的一定是最早提交的在途请求
            const oldest = pending.keys().next().value;
            if (oldest !== undefined) {
              const p = pending.get(oldest)!;
              pending.delete(oldest);
              p.reject(new Error(ev.message));
            }
          }
        }
      };
      const initMsg: PunctRequest = { type: 'init', model, tokens };
      w.postMessage(initMsg, [model, tokens]);
      return readyPromise;
    },

    punctuate(text) {
      const w = worker;
      if (!w || !ready) return Promise.reject(new Error('asrErr.punctNotReady'));
      const id = seq++;
      let resolveFn!: (text: string) => void;
      let rejectFn!: (e: Error) => void;
      const promise = new Promise<string>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      pending.set(id, { promise, resolve: resolveFn, reject: rejectFn });
      w.postMessage({ type: 'punct', seq: id, text } satisfies PunctRequest);
      return promise;
    },

    async drain() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending.values()].map((p) => p.promise));
      }
    },

    dispose() {
      failAll('asrErr.punctDisposed');
      worker?.terminate();
      worker = null;
      ready = false;
    },
  };
}
