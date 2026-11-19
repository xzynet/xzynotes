/**
 * 实时转写的视频时间轴锚定。
 * 引擎出的 cue 时间是「喂入音频秒数」（从 0 起的音频时钟），与视频进度条无关；
 * 这里按周期性采样的 video.currentTime 把音频时钟分段映射到视频时钟：
 * 每次检测到拖动进度条 / 暂停后恢复 / 变速，就切一个新分段重对齐。
 * 分段为单调追加，拖动前已出的句子保留旧映射，之后的句子走新映射。
 */

export interface TimelineSample {
  /** 采样时刻的 video.currentTime（秒） */
  videoSec: number;
  /** 视频是否暂停（暂停时捕获流只剩静音，音频时钟空走，不算漂移） */
  paused: boolean;
  /** 播放倍速（2 倍速时视频时钟走得比音频时钟快一倍） */
  rate: number;
}

interface TimelineSegment {
  /** 分段起点的音频时钟（秒） */
  fedSec: number;
  /** 分段起点对应的视频时钟（秒） */
  videoSec: number;
  /** 该分段的播放倍速 */
  rate: number;
}

export interface VideoTimelineOptions {
  /** 判定为拖动的偏差阈值（秒），默认 1.5 */
  driftToleranceSec?: number;
}

export class VideoTimeline {
  private segments: TimelineSegment[] = [];
  private last: (TimelineSample & { fedSec: number }) | null = null;
  private readonly tolerance: number;

  constructor(options: VideoTimelineOptions = {}) {
    this.tolerance = options.driftToleranceSec ?? 1.5;
  }

  /** 以当前视频位置为基准从零开始（开始捕获时调用） */
  reset(videoSec: number, rate = 1): void {
    this.segments = [{ fedSec: 0, videoSec, rate }];
    this.last = { fedSec: 0, videoSec, paused: false, rate };
  }

  /**
   * 喂入一次采样；fedSec 为采样时刻已喂入引擎的音频秒数。
   * 返回重对齐原因（'seek' 拖动 / 'resume' 暂停恢复 / 'rate' 变速），false 表示无重对齐。
   * seek/resume 意味着音频流出现断点，上层应立即强制切句（残句按旧时间轴落盘）。
   */
  update(fedSec: number, sample: TimelineSample): 'seek' | 'resume' | 'rate' | false {
    const last = this.last;
    if (!last) {
      this.reset(sample.videoSec, sample.rate);
      return false;
    }
    let reason: 'seek' | 'resume' | 'rate' | false = false;
    if (sample.paused) {
      // 视频暂停中：音频时钟空走静音，不重对齐；恢复播放时统一处理
    } else if (last.paused) {
      reason = 'resume'; // 暂停恢复：切新分段
      this.rebase(fedSec, sample);
    } else if (sample.rate !== last.rate) {
      reason = 'rate'; // 变速：音频流连续但时钟比例变化，切新分段
      this.rebase(fedSec, sample);
    } else {
      // 正常播放：视频增量应约等于音频增量 × 倍速；超阈值即判定为拖动进度条
      const fedDelta = fedSec - last.fedSec;
      const videoDelta = sample.videoSec - last.videoSec;
      if (Math.abs(videoDelta - fedDelta * sample.rate) > this.tolerance) {
        reason = 'seek';
        this.rebase(fedSec, sample);
      }
    }
    this.last = { fedSec, ...sample };
    return reason;
  }

  /** 音频时钟 → 视频时钟（用 fedSec 所在的最后一个分段换算） */
  toVideoSec(fedSec: number): number {
    let seg = this.segments[0];
    if (!seg) return fedSec;
    for (const s of this.segments) {
      if (s.fedSec <= fedSec) seg = s;
      else break;
    }
    return Math.max(0, seg.videoSec + (fedSec - seg.fedSec) * seg.rate);
  }

  /**
   * fedStart..fedEnd 跨越的第一个分段边界的视频位置（无边界返回 null）。
   * 用于把跨重对齐边界的句尾钳制在边界处（避免句尾跳到拖动后的位置）。
   */
  boundaryVideoSec(fedStart: number, fedEnd: number): number | null {
    for (const s of this.segments) {
      if (s.fedSec > fedStart && s.fedSec <= fedEnd) return s.videoSec;
    }
    return null;
  }

  private rebase(fedSec: number, sample: TimelineSample): true {
    this.segments.push({ fedSec, videoSec: sample.videoSec, rate: sample.rate });
    return true;
  }
}

/**
 * 已转写覆盖区间（视频时钟，秒）。
 * 实时转写期间按采样到的播放位置推进覆盖；回拖进度条时据此判断当前位置
 * 是否已转写过——已覆盖则跳过喂音（不重复转写），驶出覆盖区后自动续转。
 */
export class CoverageTracker {
  /** 有序、互不重叠（间隙 > mergeGapSec）的覆盖区间 */
  private intervals: Array<{ start: number; end: number }> = [];

  constructor(
    /** 间隙小于该值视为同一段连续覆盖（采样周期 1s + 端点拖尾，默认 3s） */
    private readonly mergeGapSec = 3,
  ) {}

  /** 喂入中推进覆盖到 videoSec（回退进旧区间时不产生任何效果） */
  extend(videoSec: number): void {
    const gap = this.mergeGapSec;
    // 能并入的区间：pos 落在 [start - gap, end + gap] 内
    const i = this.intervals.findIndex(
      (iv) => videoSec >= iv.start - gap && videoSec <= iv.end + gap,
    );
    if (i < 0) {
      // 与所有区间都不搭接：按序新开区间
      const at = this.intervals.findIndex((iv) => iv.start > videoSec);
      this.intervals.splice(at < 0 ? this.intervals.length : at, 0, {
        start: videoSec,
        end: videoSec,
      });
      return;
    }
    const iv = this.intervals[i]!;
    iv.start = Math.min(iv.start, videoSec);
    iv.end = Math.max(iv.end, videoSec);
    // 扩展后与后继区间搭接的顺手合并
    while (i + 1 < this.intervals.length && this.intervals[i + 1]!.start <= iv.end + gap) {
      iv.end = Math.max(iv.end, this.intervals[i + 1]!.end);
      this.intervals.splice(i + 1, 1);
    }
  }

  /** videoSec 是否落在已转写区间内（尾部留 0.5s 余量，边界处视作未覆盖以便续转） */
  isCovered(videoSec: number): boolean {
    return this.intervals.some((iv) => videoSec >= iv.start && videoSec < iv.end + 0.5);
  }

  /**
   * 跳过判定用：pos 是否「深度落入」已覆盖区间。
   * 正常播放时覆盖前沿随 pos 同步生长（end ≈ pos），必须排除，
   * 否则刚转写的内容会被误判成重复；只有回拖到区间内部
   * （距右端超过 marginSec）才视为重复转写区间。
   */
  isCoveredForSkip(videoSec: number, marginSec = 1.5): boolean {
    return this.intervals.some((iv) => videoSec >= iv.start && videoSec < iv.end - marginSec);
  }
}
