import type { SubtitleCue } from '../models/subtitle';

/**
 * 转写分句的时间轴纯逻辑。
 * 引擎只认"喂入的样本数"，这里统一把样本数换算成秒并组装 SubtitleCue。
 * 两个模型共用一套换算，区别只在切分方式：
 * 流式（Paraformer）靠端点检测出句；离线（SenseVoice）按定长窗口切。
 */

export const ASR_SAMPLE_RATE = 16_000;

export function samplesToSeconds(samples: number, sampleRate = ASR_SAMPLE_RATE): number {
  return samples / sampleRate;
}

/** 组装 cue：裁剪文本、保证 end >= start；空文本返回 null */
export function makeCue(startSec: number, endSec: number, text: string): SubtitleCue | null {
  const t = text.trim();
  if (!t) return null;
  return { start: Math.max(0, startSec), end: Math.max(0, Math.max(startSec, endSec)), text: t };
}

/**
 * 流式识别（端点检测）的出句跟踪：
 * 端点触发时，以"上次端点位置 → 当前已喂入位置"作为本句时间区间。
 * 端点本身带拖尾静音（约 1-2 秒），end 会略大于实际语音结束点，属可接受近似。
 */
export class StreamCueTracker {
  /** 已喂入引擎的总样本数 */
  private fedSamples = 0;
  /** 当前句起点（样本数） */
  private segStartSamples = 0;

  constructor(private readonly sampleRate = ASR_SAMPLE_RATE) {}

  get fedSeconds(): number {
    return samplesToSeconds(this.fedSamples, this.sampleRate);
  }

  feed(sampleCount: number): void {
    this.fedSamples += sampleCount;
  }

  /** 端点触发出句；空文本只推进起点不出 cue。返回 null 表示本句无内容 */
  endpointCue(text: string): SubtitleCue | null {
    const cue = makeCue(
      samplesToSeconds(this.segStartSamples, this.sampleRate),
      this.fedSeconds,
      text,
    );
    this.segStartSamples = this.fedSamples;
    return cue;
  }

  /** 冲刷：句尾不到端点阈值时的收尾出句 */
  flushCue(text: string): SubtitleCue | null {
    return this.endpointCue(text);
  }
}

export interface AudioWindow {
  startSec: number;
  endSec: number;
  samples: Float32Array;
}

/**
 * 离线识别的定长切窗：攒够 windowSec 秒切一窗，时间区间按全局偏移计算。
 * SenseVoice 建议单次输入不宜过长（标点与 ITN 质量随长度下降），默认 15 秒。
 */
export class WindowSegmenter {
  private chunks: Float32Array[] = [];
  private bufferedSamples = 0;
  /** 已切出窗口覆盖的总样本数（全局偏移） */
  private emittedSamples = 0;

  constructor(
    private readonly sampleRate = ASR_SAMPLE_RATE,
    private readonly windowSec = 15,
  ) {}

  private get windowSamples(): number {
    return Math.floor(this.windowSec * this.sampleRate);
  }

  /** 喂入一批样本；返回所有新攒满的窗口（可能多个） */
  push(samples: Float32Array): AudioWindow[] {
    this.chunks.push(samples);
    this.bufferedSamples += samples.length;
    const out: AudioWindow[] = [];
    while (this.bufferedSamples >= this.windowSamples) {
      out.push(this.cut(this.windowSamples));
    }
    return out;
  }

  /** 收尾：残余不足一窗的样本也切出来（过短丢弃） */
  flush(): AudioWindow | null {
    if (this.bufferedSamples < this.sampleRate * 0.5) return null; // 不足 0.5s 的尾巴直接丢
    return this.cut(this.bufferedSamples);
  }

  private cut(n: number): AudioWindow {
    const taken: Float32Array[] = [];
    let remaining = n;
    while (remaining > 0) {
      const head = this.chunks[0];
      if (!head) break;
      if (head.length <= remaining) {
        taken.push(head);
        this.chunks.shift();
        remaining -= head.length;
      } else {
        taken.push(head.subarray(0, remaining));
        this.chunks[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    this.bufferedSamples -= n;
    const merged = new Float32Array(n);
    let offset = 0;
    for (const c of taken) {
      merged.set(c, offset);
      offset += c.length;
    }
    const startSec = samplesToSeconds(this.emittedSamples, this.sampleRate);
    this.emittedSamples += n;
    return { startSec, endSec: samplesToSeconds(this.emittedSamples, this.sampleRate), samples: merged };
  }
}
