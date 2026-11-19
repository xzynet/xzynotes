import type { DensityPoint } from '../../core/chapters';
import type { SubtitleCue } from '../../core/models';

/** 平台无字幕时抛出（面板据此降级为"无章节"模式） */
export class NoSubtitlesError extends Error {
  constructor(message = 'err.noSubtitles') {
    super(message);
    this.name = 'NoSubtitlesError';
  }
}

export interface PlatformCourseInfo {
  /** 课程唯一 ID；分 P 视频必须包含分 P 维度 */
  courseId: string;
  title: string;
  coverUrl?: string;
}

/**
 * 平台差异收敛接口：业务代码只依赖本接口。
 * 所有实现必须防御性判空——选择器失效时抛错或返回空值，
 * 由调用方降级到 GenericAdapter 并提示用户。
 */
export interface PlatformAdapter {
  readonly name: string;
  /** 是否接管当前页面 */
  match(url: string): boolean;
  getVideoEl(): HTMLVideoElement | null;
  getCourseInfo(): PlatformCourseInfo;
  getCurrentTime(): number;
  seekTo(sec: number): void;
  /** 无字幕抛 NoSubtitlesError */
  getSubtitles(): Promise<SubtitleCue[]>;
  /** 弹幕密度（B站实现），无数据返回空数组 */
  getDanmakuDensity?(): Promise<DensityPoint[]>;
  /**
   * 语音转写的媒体源：返回可直接下载的音/视频文件 URL（按优先级排序）。
   * 返回 null 表示无法直接获取（如 MSE/HLS 流），调用方回退到实时捕获转写。
   */
  getAudioDownloadUrl?(): Promise<string[] | null>;
  /** 时间戳回跳链接，如 B站 ?t=74 */
  makeJumpUrl(sec: number): string;
  /** canvas 抓当前视频帧 */
  captureFrame(): Promise<Blob>;
}
