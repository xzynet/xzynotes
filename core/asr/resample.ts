/**
 * 音频重采样纯函数（core 纯净：不依赖 Web Audio API）。
 * 捕获端 AudioContext 的采样率由系统决定（常 48kHz），引擎要求 16kHz。
 */

/** 多声道混成单声道（逐样本平均） */
export function mixToMono(channels: ReadonlyArray<Float32Array>): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return new Float32Array(first);
  const len = first.length;
  const out = new Float32Array(len);
  for (const ch of channels) {
    for (let i = 0; i < len; i++) out[i] = (out[i] ?? 0) + (ch[i] ?? 0);
  }
  const inv = 1 / channels.length;
  for (let i = 0; i < len; i++) out[i] = (out[i] ?? 0) * inv;
  return out;
}

/**
 * 线性插值重采样。
 * 语音转写对保真要求低，线性插值足够； ratio = srcRate / dstRate > 1 表示降采样。
 */
export function resampleLinear(
  samples: Float32Array,
  srcRate: number,
  dstRate: number,
): Float32Array {
  if (srcRate === dstRate || samples.length === 0) return new Float32Array(samples);
  if (srcRate <= 0 || dstRate <= 0) throw new Error(`非法采样率：${srcRate} → ${dstRate}`);
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[idx] ?? 0;
    const b = idx + 1 < samples.length ? (samples[idx + 1] ?? a) : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
