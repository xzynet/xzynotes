import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ASR_MODELS, type AsrModelId } from '../../core/asr';
import type { SubtitleCue } from '../../core/models';
import { createAsrManager } from '../../entrypoints/sidepanel/asr/manager';
import { putModelFile } from '../../entrypoints/sidepanel/asr/model-store';

/**
 * feedBuffer 冲刷时序回归：快进喂入时音频块积压 worker 队列，每块都会回
 * 'processed' 事件。旧实现 flushEngine 在首个 'processed' 即返回并 terminate，
 * 丢掉全部未处理音频（文件模式 0 句的线上事故）。修复后必须等 'flushed'。
 * 这里的 mock worker 一个宏任务只处理一条消息，精确复现「面板发得比引擎解得快」。
 */

type Handler = (e: MessageEvent) => void;

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: Handler | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  private listeners = new Set<Handler>();
  private queue: Array<Record<string, unknown>> = [];
  private pumping = false;
  private audioSeen = 0;

  constructor(public readonly url: unknown) {
    MockWorker.instances.push(this);
  }

  addEventListener(_type: string, fn: Handler): void {
    this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: Handler): void {
    this.listeners.delete(fn);
  }
  terminate(): void {
    this.terminated = true;
    this.queue.length = 0;
  }
  postMessage(msg: Record<string, unknown>): void {
    this.queue.push(msg);
    void this.pump();
  }

  private emit(data: Record<string, unknown>): void {
    const e = new MessageEvent('message', { data });
    this.onmessage?.(e);
    for (const fn of [...this.listeners]) fn(e);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length > 0 && !this.terminated) {
      const msg = this.queue.shift()!;
      // 慢速解码：一条消息一个宏任务；面板在此期间可连续 post 多条
      await new Promise((r) => setTimeout(r, 0));
      if (this.terminated) break;
      this.handle(msg);
    }
    this.pumping = false;
  }

  private handle(msg: Record<string, unknown>): void {
    if (msg['type'] === 'init') {
      this.emit({ type: 'ready' });
      return;
    }
    if (msg['type'] === 'audio') {
      this.audioSeen++;
      // 与真实 worker 一致：每块都回 processed
      this.emit({ type: 'processed', seconds: this.audioSeen / 2 });
      return;
    }
    if (msg['type'] === 'flush') {
      // 冲刷时积压已清空：每 2 块出一句话，最后发 flushed
      const cueCount = Math.floor(this.audioSeen / 2);
      for (let i = 0; i < cueCount; i++) {
        this.emit({ type: 'segment', cue: { start: i, end: i + 1, text: `句子${i}` } });
      }
      this.emit({ type: 'flushed' });
    }
  }
}

async function seedModel(modelId: AsrModelId): Promise<void> {
  for (const f of ASR_MODELS[modelId].files) {
    await putModelFile(modelId, f.path, new Blob([new Uint8Array(8)]));
  }
}

describe('AsrManager feedBuffer 冲刷时序', () => {
  beforeEach(() => {
    MockWorker.instances = [];
    vi.stubGlobal('Worker', MockWorker);
  });

  it('快进喂入等 flushed 收尾：全部音频处理完，cue 一句不丢', async () => {
    await seedModel('paraformer-streaming');
    const segments: SubtitleCue[] = [];
    const errors: string[] = [];
    const manager = createAsrManager({
      onPhase: () => {},
      onDownloadProgress: () => {},
      onSegment: (c) => segments.push(c),
      onPartial: () => {},
      onProcessed: () => {},
      onAudioLevel: () => {},
      onCaptureDiag: () => {},
      onError: (m) => errors.push(m),
    });

    await manager.boot();
    expect(manager.phase).toBe('loading');

    // 10 块 × 0.5s = 5s 音频；mock 每 2 块出一句 → 5 句
    const cues = await manager.feedBuffer(new Float32Array(8000 * 10));

    expect(errors).toEqual([]);
    expect(cues).toHaveLength(5);
    expect(cues.map((c) => c.text)).toEqual(['句子0', '句子1', '句子2', '句子3', '句子4']);
    expect(segments).toHaveLength(5);
    expect(manager.phase).toBe('idle');
  });
});

describe('AsrManager feedStream 流式喂入', () => {
  beforeEach(() => {
    MockWorker.instances = [];
    vi.stubGlobal('Worker', MockWorker);
  });

  const makeEvents = (segments: SubtitleCue[], errors: string[]) => ({
    onPhase: () => {},
    onDownloadProgress: () => {},
    onSegment: (c: SubtitleCue) => segments.push(c),
    onPartial: () => {},
    onProcessed: () => {},
    onAudioLevel: () => {},
    onCaptureDiag: () => {},
    onError: (m: string) => errors.push(m),
  });

  it('逐块喂入并等 flushed 收尾：与 feedBuffer 等价', async () => {
    await seedModel('paraformer-streaming');
    const segments: SubtitleCue[] = [];
    const errors: string[] = [];
    const manager = createAsrManager(makeEvents(segments, errors));

    await manager.boot();
    const chunks = (async function* () {
      for (let i = 0; i < 10; i++) yield new Float32Array(8000);
    })();
    const cues = await manager.feedStream(chunks, 5);

    expect(errors).toEqual([]);
    expect(cues).toHaveLength(5);
    expect(cues.map((c) => c.text)).toEqual(['句子0', '句子1', '句子2', '句子3', '句子4']);
    expect(manager.phase).toBe('idle');
    expect(MockWorker.instances[0]?.terminated).toBe(true);
  });

  it('流中途抛错：原样上抛，worker 保留交由调用方处置', async () => {
    await seedModel('paraformer-streaming');
    const errors: string[] = [];
    const manager = createAsrManager(makeEvents([], errors));

    await manager.boot();
    const chunks = (async function* () {
      yield new Float32Array(8000);
      throw new Error('读取停滞');
    })();
    await expect(manager.feedStream(chunks, 5)).rejects.toThrow('读取停滞');
    // 不自动收尾：worker 仍存活，等调用方 reset/dispose
    expect(MockWorker.instances[0]?.terminated).toBe(false);
    await manager.dispose();
  });

  it('dispose 取消：停止喂入并立即交还已产出 cue（不冲刷）', async () => {
    await seedModel('paraformer-streaming');
    const errors: string[] = [];
    const manager = createAsrManager(makeEvents([], errors));

    await manager.boot();
    const chunks = (async function* () {
      for (let i = 0; i < 1000; i++) {
        yield new Float32Array(8000);
        await new Promise((r) => setTimeout(r, 0));
      }
    })();
    const feeding = manager.feedStream(chunks, 500);
    await new Promise((r) => setTimeout(r, 20));
    const partial = await manager.dispose();
    const cues = await feeding;

    // mock 只在 flush 时出句，dispose 不冲刷 → 两边都是同一批（空）结果
    expect(cues).toEqual(partial);
    expect(MockWorker.instances[0]?.terminated).toBe(true);
    expect(errors).toEqual([]);
  });
});
