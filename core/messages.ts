import type { AsrHostCommand } from './asr/host';
import type { Chapter, Course, Note, Setting, SubtitleCue, Transcript } from './models';
import type { BackupData } from './storage/backup';

/**
 * 扩展内部消息协议：纯类型定义，不含任何浏览器 API。
 * 面板/内容脚本 → 后台 走 RequestMessage；后台 → 面板 广播走 PushMessage；
 * 后台 → 内容脚本 走 ContentRequest。所有响应统一 ApiResponse<T>。
 */

/** 当前视频页上下文（content script 采集） */
export interface CourseContext {
  course: Course;
  tabId: number;
  windowId: number;
  /** true = 平台选择器疑似失效，已降级 generic 模式 */
  degraded: boolean;
}

/** 截图结果（content script 返回） */
export interface CaptureResult {
  dataUrl: string;
  width: number;
  height: number;
  /** 抓取时的视频时间点（秒） */
  time: number;
}

/** 图片的可传输形态（Blob 无法跨消息传递，统一转 dataURL） */
export interface ImagePayload {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
}

/** export:course 的打包结果 */
export interface ExportBundle {
  course: Course;
  notes: Note[];
  /** 章节大纲（无字幕课程为空数组） */
  chapters: Chapter[];
  /** imageId → 图片 */
  images: Record<string, ImagePayload>;
  setting: Setting;
}

/** 全部课程首页的课程聚合条目 */
export interface CourseSummary {
  course: Course;
  noteCount: number;
  screenshotCount: number;
  /** AI/规则章节数（0 表示尚未生成章节） */
  chapterCount: number;
  /** 本地语音转写记录摘要；无转写为 undefined */
  transcript?: { cueCount: number; durationSec: number; updatedAt: number };
  /** 最新一张截图的 imageId，用作列表封面；无截图为 undefined */
  coverImageId?: string;
}

/** ai:generateChapters 的返回：落库后的章节 + 整课概述 */
export interface AiGenerateResult {
  chapters: Chapter[];
  overview: string;
}

/** 视频播放信息（语音转写进度分母用）；duration 不可知时为 0 */
export interface PlaybackInfo {
  currentTime: number;
  duration: number;
  paused: boolean;
  /** 播放器是否静音（静音时音频捕获只能拿到无声流，转写诊断为「无声音输入」） */
  muted: boolean;
  /** 播放器音量 0..1 */
  volume: number;
  /** 播放倍速（语音转写时间轴锚定用；视频时钟速度 = 音频时钟 × playbackRate） */
  playbackRate: number;
}

/** 面板/页面悬浮按钮 → 后台 */
export type RequestMessage =
  | { type: 'panel:init'; windowId?: number }
  | { type: 'panel:open' }
  /** 面板按钮触发：截图 → 打开标注器（等同 Alt+A 流程）；windowId 定位视频所在窗口 */
  | { type: 'capture:annotate'; windowId?: number }
  | { type: 'courses:list' }
  /** 删除课程及其全部关联数据（笔记、章节、截图），不可恢复 */
  | { type: 'course:delete'; courseId: string }
  /** 修改课程标题；改后锁定，页面重建的标题不再覆盖 */
  | { type: 'course:rename'; courseId: string; title: string }
  | { type: 'notes:list'; courseId: string }
  | { type: 'note:createText'; courseId: string; tabId: number; content: string }
  | { type: 'note:delete'; id: string }
  /** 修改笔记文字内容（当前用作截图标题）；空串表示清除 */
  | { type: 'note:update'; id: string; content: string }
  | { type: 'note:restore'; note: Note; image?: ImagePayload }
  | { type: 'image:get'; id: string }
  | { type: 'image:replace'; id: string; dataUrl: string; width: number; height: number }
  | { type: 'image:delete'; id: string }
  | { type: 'note:createImage'; courseId: string; imageId: string; timestampSec: number }
  | { type: 'chapters:list'; courseId: string }
  | { type: 'chapters:replace'; courseId: string; chapters: Chapter[] }
  | { type: 'setting:get' }
  | { type: 'setting:save'; setting: Setting }
  | { type: 'stats:counts' }
  | { type: 'backup:export' }
  | { type: 'backup:import'; data: BackupData }
  | { type: 'video:seek'; tabId: number; sec: number }
  /** 在已打开的标签页中寻找该课程并跳转；找不到返回 handled:false；excludeTabId 用于跳过刚失败的 tab */
  | { type: 'video:seekCourse'; courseId: string; sec: number; windowId?: number; excludeTabId?: number }
  | { type: 'video:getTime'; tabId: number }
  /** 当前时间 + 总时长 + 播放态（转写进度展示用） */
  | { type: 'video:getPlaybackInfo'; tabId: number }
  /** 解析可直接下载的音/视频文件 URL 列表（语音转写文件模式）；无法获取返回 null */
  | { type: 'media:resolveAudio'; tabId: number }
  | { type: 'video:setLoop'; tabId: number; a: number; b: number }
  | { type: 'video:clearLoop'; tabId: number }
  | { type: 'video:jumpUrl'; tabId: number; sec: number }
  | { type: 'subtitles:get'; tabId: number }
  | { type: 'danmaku:get'; tabId: number }
  /** 查询课程的本地语音转写缓存（无字幕时的兜底字幕源），无缓存返回 null */
  | { type: 'transcript:get'; courseId: string }
  /** 覆盖式保存课程的本地语音转写结果 */
  | { type: 'transcript:save'; transcript: Transcript }
  /** 等待激活期间切换/恢复该 tab 的工具栏图标为激活弹窗（Chrome 专属，Firefox no-op） */
  | { type: 'asr:setActivationPopup'; tabId: number; enable: boolean }
  /** 激活弹窗打开后自我清除图标覆盖（由后台解析当前活动 tab） */
  | { type: 'asr:clearActivationPopup' }
  /** 查询扩展图标是否已固定到工具栏（激活引导文案用）；失败/不支持返回 null */
  | { type: 'asr:actionIconOnToolbar' }
  /** content script 受页面 CORS 限制时的后台中转抓取（字幕等文本资源） */
  | { type: 'net:fetchText'; url: string }
  | { type: 'export:course'; courseId: string }
  /** AI 章节切分 + 内容总结；章节落库后返回 */
  | { type: 'ai:generateChapters'; courseId: string; cues: SubtitleCue[] }
  /** 用设置中已保存的 LLM 配置做最小调用，验证连通性 */
  | { type: 'ai:testConnection' }
  /**
   * 转写任务宿主（offscreen）命令，由后台拆包后中继给宿主文档（见 core/asr/host.ts）。
   * 面板用这层包装而不是直接发 asrHost:* —— 否则面板发的命令 SW 与宿主会各收一份、
   * 各跑一遍（快照里的标点回填会被重复消费）。
   */
  | { type: 'asr:hostCommand'; command: AsrHostCommand }
  /** 宿主转写完成：面板多半没开着，请后台在图标上打完成标记 */
  | { type: 'asr:jobDone'; cueCount: number };

/** 后台 → 内容脚本 */
export type ContentRequest =
  | { type: 'course:getContext' }
  | { type: 'video:getTime' }
  | { type: 'video:getPlaybackInfo' }
  | { type: 'media:resolveAudio' }
  | { type: 'video:seek'; sec: number }
  | { type: 'video:capture' }
  | { type: 'video:setLoop'; a: number; b: number }
  | { type: 'video:clearLoop' }
  | { type: 'video:jumpUrl'; sec: number }
  | { type: 'subtitles:get' }
  | { type: 'danmaku:get' };

/** 后台 → 面板 广播 */
export type PushMessage =
  | { type: 'toast'; level: 'info' | 'success' | 'error'; text: string }
  | { type: 'notes:changed'; courseId: string; highlightNoteId?: string }
  /** 设置已保存（语言/主题等），面板据此即时刷新 */
  | { type: 'setting:changed'; setting: Setting }
  | { type: 'panel:focusNewNote' }
  /** Alt+A：截图已就绪，面板打开标注器 */
  | { type: 'panel:annotate'; imageId: string; courseId: string; time: number }
  /** 拦截器捕获到新的字幕分段（MOOC 分段加载） */
  | { type: 'subtitles:changed' }
  /** 活动标签页的课程上下文变化（切 tab / 页面内 SPA 跳转）；windowId 用于多窗口区分 */
  | { type: 'course:context'; windowId: number; context: CourseContext | null };

export interface ApiOk<T> {
  ok: true;
  data: T;
}
export interface ApiErr {
  ok: false;
  error: string;
}
export type ApiResponse<T> = ApiOk<T> | ApiErr;

export const ok = <T>(data: T): ApiOk<T> => ({ ok: true, data });
export const err = (error: string): ApiErr => ({ ok: false, error });

/** 把 unknown 异常转成用户可读文本 */
export function readableError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
