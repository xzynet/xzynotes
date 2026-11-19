import { describe, expect, it } from 'vitest';
import {
  ASR_MODELS,
  CoverageTracker,
  MODEL_BASE_URLS,
  StreamCueTracker,
  VideoTimeline,
  WindowSegmenter,
  formatBytes,
  isModelFileComplete,
  makeCue,
  mixToMono,
  modelFileUrl,
  resampleLinear,
  samplesToSeconds,
  type AsrModelId,
} from '../../core/asr';

describe('asr/models · 模型注册表', () => {
  it('两个模型文件清单非空且字节数合理', () => {
    for (const id of Object.keys(ASR_MODELS) as AsrModelId[]) {
      const spec = ASR_MODELS[id];
      expect(spec.files.length).toBeGreaterThan(0);
      expect(spec.files.every((f) => f.bytes > 0 && f.path.length > 0)).toBe(true);
      expect(spec.totalBytes).toBe(spec.files.reduce((a, f) => a + f.bytes, 0));
      // tokens.txt 必须存在（识别器配置依赖）
      expect(spec.files.some((f) => f.path === 'tokens.txt')).toBe(true);
    }
  });

  it('modelFileUrl 拼接 resolve/main 路径并容忍尾部斜杠', () => {
    const spec = ASR_MODELS['paraformer-streaming'];
    const file = spec.files[0]!;
    expect(modelFileUrl(spec, file, 'https://huggingface.co')).toBe(
      `https://huggingface.co/${spec.hfRepo}/resolve/main/${file.path}`,
    );
    expect(modelFileUrl(spec, file, 'https://hf-mirror.com/')).toBe(
      `https://hf-mirror.com/${spec.hfRepo}/resolve/main/${file.path}`,
    );
  });

  it('镜像列表含官方源与 hf-mirror 回退', () => {
    expect(MODEL_BASE_URLS[0]).toBe('https://huggingface.co');
    expect(MODEL_BASE_URLS).toContain('https://hf-mirror.com');
  });

  it('formatBytes 人类可读', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(237_202_501)).toBe('226.2 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });

  it('isModelFileComplete 校验文件齐全且字节吻合', () => {
    const spec = ASR_MODELS['sensevoice'];
    expect(isModelFileComplete(spec, spec.files.map((f) => ({ path: f.path, bytes: f.bytes })))).toBe(true);
    // 缺文件
    expect(isModelFileComplete(spec, [{ path: 'tokens.txt', bytes: spec.files[1]!.bytes }])).toBe(false);
    // 字节不符
    expect(
      isModelFileComplete(spec, spec.files.map((f) => ({ path: f.path, bytes: f.bytes + 1 }))),
    ).toBe(false);
    // 空缓存
    expect(isModelFileComplete(spec, [])).toBe(false);
  });
});

describe('asr/segment · 流式出句跟踪', () => {
  it('endpointCue 按喂入样本数换算秒并推进起点', () => {
    const tracker = new StreamCueTracker(16000);
    tracker.feed(16000 * 5); // 5s
    const cue = tracker.endpointCue(' 你好 ');
    expect(cue).toEqual({ start: 0, end: 5, text: '你好' });

    tracker.feed(16000 * 3); // 8s
    // 空文本：不出 cue，但起点推进
    expect(tracker.endpointCue('   ')).toBeNull();

    tracker.feed(16000); // 9s
    expect(tracker.endpointCue('世界')).toEqual({ start: 8, end: 9, text: '世界' });
    expect(tracker.fedSeconds).toBe(9);
  });

  it('makeCue 保证 end >= start 且拒绝空文本', () => {
    expect(makeCue(2, 5, ' x ')).toEqual({ start: 2, end: 5, text: 'x' });
    expect(makeCue(5, 2, 'x')).toEqual({ start: 5, end: 5, text: 'x' });
    expect(makeCue(0, 1, '  ')).toBeNull();
  });

  it('samplesToSeconds', () => {
    expect(samplesToSeconds(16000)).toBe(1);
    expect(samplesToSeconds(8000, 16000)).toBe(0.5);
  });
});

describe('asr/segment · 离线定长切窗', () => {
  const RATE = 16000;
  const fill = (n: number) => new Float32Array(n).fill(0.1);

  it('攒满整窗才切出，时间区间按全局偏移', () => {
    const seg = new WindowSegmenter(RATE, 15);
    expect(seg.push(fill(10 * RATE))).toEqual([]); // 10s 不足一窗
    const windows = seg.push(fill(10 * RATE)); // 累计 20s → 切出 15s 一窗
    expect(windows).toHaveLength(1);
    expect(windows[0]!.startSec).toBe(0);
    expect(windows[0]!.endSec).toBe(15);
    expect(windows[0]!.samples.length).toBe(15 * RATE);
    // 残余 5s 留在缓冲
    const rest = seg.flush();
    expect(rest?.startSec).toBe(15);
    expect(rest?.endSec).toBe(20);
    expect(rest?.samples.length).toBe(5 * RATE);
    expect(seg.flush()).toBeNull();
  });

  it('一次喂入可切出多窗', () => {
    const seg = new WindowSegmenter(RATE, 15);
    const windows = seg.push(fill(40 * RATE));
    expect(windows).toHaveLength(2);
    expect(windows[1]!.startSec).toBe(15);
    expect(windows[1]!.endSec).toBe(30);
    expect(seg.flush()?.samples.length).toBe(10 * RATE);
  });

  it('flush 丢弃不足 0.5 秒的尾巴', () => {
    const seg = new WindowSegmenter(RATE, 15);
    seg.push(fill(Math.floor(0.4 * RATE)));
    expect(seg.flush()).toBeNull();
  });
});

describe('asr/resample', () => {
  it('mixToMono 单声道直返、双声道取平均', () => {
    const mono = new Float32Array([0.5, -0.5]);
    expect([...mixToMono([mono])]).toEqual([0.5, -0.5]);
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect([...mixToMono([a, b])]).toEqual([0.5, 0.5]);
    expect(mixToMono([]).length).toBe(0);
  });

  it('resampleLinear 同采样率透传', () => {
    const src = new Float32Array([1, 2, 3]);
    expect([...resampleLinear(src, 16000, 16000)]).toEqual([1, 2, 3]);
  });

  it('resampleLinear 48k→16k 长度三分之一且恒定信号不衰减', () => {
    const src = new Float32Array(4800).fill(0.7);
    const out = resampleLinear(src, 48000, 16000);
    expect(out.length).toBe(1600);
    expect(out[0]).toBeCloseTo(0.7, 5);
    expect(out[1599]).toBeCloseTo(0.7, 5);
  });

  it('resampleLinear 线性插值', () => {
    // 4Hz → 3Hz：ratio=4/3，out[1] 落在原 1.33 处 = 10 + 10/3
    const out = resampleLinear(new Float32Array([0, 10, 20, 30]), 4, 3);
    expect(out.length).toBe(3);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(13.333, 2);
    expect(out[2]).toBeCloseTo(26.667, 2);
  });

  it('resampleLinear 拒绝非法采样率', () => {
    expect(() => resampleLinear(new Float32Array(1), 0, 16000)).toThrow();
  });
});

describe('asr/timeline · 视频时间轴锚定', () => {
  /** 模拟正常播放推进：音频与视频时钟同速走 dt 秒 */
  const advance = (tl: VideoTimeline, fed: number, video: number, dt: number, rate = 1) =>
    tl.update(fed + dt, { videoSec: video + dt * rate, paused: false, rate });

  it('以开始转写时的播放位置为基准偏移', () => {
    const tl = new VideoTimeline();
    tl.reset(215, 1); // 视频已播到 3:35 才开始转写
    expect(tl.toVideoSec(0)).toBeCloseTo(215, 5);
    expect(tl.toVideoSec(30)).toBeCloseTo(245, 5);
  });

  it('正常播放不重对齐，映射保持稳定', () => {
    const tl = new VideoTimeline();
    tl.reset(0, 1);
    let fed = 0;
    let video = 0;
    for (let i = 0; i < 60; i++) {
      expect(advance(tl, fed, video, 1)).toBe(false);
      fed += 1;
      video += 1;
    }
    expect(tl.toVideoSec(45)).toBeCloseTo(45, 5);
  });

  it('向前拖动进度条：重对齐，之后的句子按新位置计时', () => {
    const tl = new VideoTimeline();
    tl.reset(10, 1);
    let fed = 0;
    let video = 10;
    for (let i = 0; i < 30; i++) {
      tl.update(fed + 1, { videoSec: video + 1, paused: false, rate: 1 });
      fed += 1;
      video += 1;
    }
    // 用户从 40s 拖到 300s；下一次采样视频位置跳变
    const rebased = tl.update(fed + 1, { videoSec: 301, paused: false, rate: 1 });
    expect(rebased).toBe('seek');
    // 拖动前出的句仍按旧映射
    expect(tl.toVideoSec(20)).toBeCloseTo(30, 5);
    // 拖动后出的句按新映射（分界点 ≈ 重对齐时的 fed 位置）
    expect(tl.toVideoSec(fed + 6)).toBeCloseTo(306, 5);
  });

  it('向后拖动进度条同样重对齐', () => {
    const tl = new VideoTimeline();
    tl.reset(100, 1);
    advance(tl, 0, 100, 10);
    const rebased = tl.update(11, { videoSec: 20, paused: false, rate: 1 });
    expect(rebased).toBe('seek');
    expect(tl.toVideoSec(16)).toBeCloseTo(25, 5);
  });

  it('小幅抖动（解码/采样滞后）不误判为拖动', () => {
    const tl = new VideoTimeline();
    tl.reset(0, 1);
    // 视频时钟比音频时钟慢 0.8s（低于 1.5s 阈值）
    expect(tl.update(5, { videoSec: 4.2, paused: false, rate: 1 })).toBe(false);
    expect(tl.update(6, { videoSec: 5.2, paused: false, rate: 1 })).toBe(false);
  });

  it('视频暂停期间音频时钟空走不算漂移，恢复播放时重对齐', () => {
    const tl = new VideoTimeline();
    tl.reset(50, 1);
    advance(tl, 0, 50, 5);
    // 视频暂停 30s（静音仍被喂入，fed 空走 30s）
    expect(tl.update(35, { videoSec: 55, paused: true, rate: 1 })).toBe(false);
    // 恢复播放：重对齐到当前视频位置
    expect(tl.update(36, { videoSec: 55, paused: false, rate: 1 })).toBe('resume');
    // 暂停期间出的句（静音，一般不会出）按旧段换算；恢复后的句从 55 继续
    expect(tl.toVideoSec(40)).toBeCloseTo(59, 5);
  });

  it('2 倍速播放：视频时钟增速为音频两倍，不误判', () => {
    const tl = new VideoTimeline();
    tl.reset(0, 2);
    let rebased = false;
    for (let i = 1; i <= 30; i++) {
      if (tl.update(i, { videoSec: i * 2, paused: false, rate: 2 })) rebased = true;
    }
    expect(rebased).toBe(false);
    expect(tl.toVideoSec(20)).toBeCloseTo(40, 5);
  });

  it('播放中变速：重对齐，之后按新倍速映射', () => {
    const tl = new VideoTimeline();
    tl.reset(0, 1);
    advance(tl, 0, 0, 10);
    expect(tl.update(11, { videoSec: 11, paused: false, rate: 2 })).toBe('rate');
    // 变速点之后：fed 走 1s = 视频走 2s
    expect(tl.toVideoSec(16)).toBeCloseTo(21, 5);
    // 变速点之前仍按 1x 旧段
    expect(tl.toVideoSec(5)).toBeCloseTo(5, 5);
  });

  it('boundaryVideoSec：跨重对齐边界的句尾钳制在边界视频位置', () => {
    const tl = new VideoTimeline();
    tl.reset(10, 1);
    let fed = 0;
    let video = 10;
    for (let i = 0; i < 30; i++) {
      tl.update(fed + 1, { videoSec: video + 1, paused: false, rate: 1 });
      fed += 1;
      video += 1;
    }
    // 拖动 → 边界落在 fed=31、视频位置 301
    tl.update(fed + 1, { videoSec: 301, paused: false, rate: 1 });
    // 残句 fed 20→31.5 跨边界：边界视频位置 301
    expect(tl.boundaryVideoSec(20, 31.5)).toBeCloseTo(301, 5);
    // 边界之前的句不受影响
    expect(tl.boundaryVideoSec(5, 20)).toBeNull();
    // 边界之后的新句不含该边界
    expect(tl.boundaryVideoSec(32, 40)).toBeNull();
  });
});

describe('asr/timeline · 已转写覆盖区间（CoverageTracker）', () => {
  it('连续推进合并为单一区间', () => {
    const c = new CoverageTracker();
    for (let t = 0; t <= 60; t++) c.extend(t);
    expect(c.isCovered(0)).toBe(true);
    expect(c.isCovered(59.6)).toBe(true);
    expect(c.isCovered(61)).toBe(false);
  });

  it('间隙超过阈值开新区间；间隙内判定为未覆盖', () => {
    const c = new CoverageTracker();
    for (let t = 0; t <= 10; t++) c.extend(t);
    for (let t = 100; t <= 110; t++) c.extend(t);
    expect(c.isCovered(50)).toBe(false);
    expect(c.isCovered(105)).toBe(true);
  });

  it('回拖到已覆盖区间 → 已覆盖；回拖到未覆盖区间 → 未覆盖且可前插推进', () => {
    const c = new CoverageTracker();
    for (let t = 100; t <= 160; t++) c.extend(t);
    expect(c.isCovered(120)).toBe(true); // 已转写过 → 跳过
    expect(c.isCovered(40)).toBe(false); // 未转写过 → 续转
    // 在未覆盖区继续推进：前插新区间，不影响旧区间
    for (let t = 40; t <= 50; t++) c.extend(t);
    expect(c.isCovered(45)).toBe(true);
    expect(c.isCovered(70)).toBe(false);
    expect(c.isCovered(130)).toBe(true);
  });

  it('从中间补齐间隙时合并相邻区间', () => {
    const c = new CoverageTracker();
    for (let t = 0; t <= 10; t++) c.extend(t);
    for (let t = 20; t <= 30; t++) c.extend(t);
    // 补齐 12..18：与前、后区间都在合并阈值内 → 三区合一
    for (let t = 12; t <= 18; t++) c.extend(t);
    expect(c.isCovered(15)).toBe(true);
    expect(c.isCovered(0)).toBe(true);
    expect(c.isCovered(29.6)).toBe(true);
  });

  it('尾部 0.5s 余量内仍算覆盖，超过则未覆盖', () => {
    const c = new CoverageTracker();
    c.extend(10);
    expect(c.isCovered(10.4)).toBe(true);
    expect(c.isCovered(11)).toBe(false);
  });
});

describe('asr/timeline · 跳过判定（isCoveredForSkip）', () => {
  it('正常转写：覆盖前沿同步生长，永不误判为已转写过', () => {
    const c = new CoverageTracker();
    // 模拟每秒采样：判定 → 推进，循环 5 分钟
    for (let t = 0; t <= 300; t++) {
      expect(c.isCoveredForSkip(t)).toBe(false);
      c.extend(t);
    }
  });

  it('回拖到区间深处才判定重复；贴近前沿不判定', () => {
    const c = new CoverageTracker();
    for (let t = 100; t <= 160; t++) c.extend(t);
    expect(c.isCoveredForSkip(120)).toBe(true); // 回拖到中间 → 跳过
    expect(c.isCoveredForSkip(158)).toBe(true); // 距右端 2s > 1.5 → 仍算重复
    expect(c.isCoveredForSkip(159)).toBe(false); // 贴近前沿 → 续转
    expect(c.isCoveredForSkip(200)).toBe(false); // 区间外 → 续转
  });

  it('驶出覆盖区后在前沿续转，覆盖顺势合并延伸', () => {
    const c = new CoverageTracker();
    for (let t = 100; t <= 160; t++) c.extend(t);
    // 回拖到 120 开始跳过（不 extend），播到 160.5 驶出后续转
    expect(c.isCoveredForSkip(160.5)).toBe(false);
    c.extend(160.5);
    c.extend(161.5);
    expect(c.isCovered(161)).toBe(true);
  });
});
