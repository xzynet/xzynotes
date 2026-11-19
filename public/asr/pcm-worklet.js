/**
 * AudioWorkletProcessor：把输入声道混成单声道，按 4096 帧切块 post 给面板。
 * 重采样（→16kHz）在面板侧做（core/asr/resample.ts，有单测）；
 * 本文件是 public 静态资源，不经构建，保持零依赖。
 */
class PcmCollectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._length = 0;
    this._target = 4096;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const frames = input[0].length;
      const mono = new Float32Array(frames);
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < frames; i++) mono[i] += ch[i];
      }
      const inv = 1 / input.length;
      for (let i = 0; i < frames; i++) mono[i] *= inv;

      this._chunks.push(mono);
      this._length += frames;

      while (this._length >= this._target) {
        const out = new Float32Array(this._target);
        let offset = 0;
        while (offset < this._target) {
          const head = this._chunks[0];
          const take = Math.min(head.length, this._target - offset);
          out.set(head.subarray(0, take), offset);
          offset += take;
          if (take === head.length) this._chunks.shift();
          else this._chunks[0] = head.subarray(take);
        }
        this._length -= this._target;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('kedaibiao-pcm', PcmCollectorProcessor);
