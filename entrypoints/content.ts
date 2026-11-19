import { browser } from 'wxt/browser';
import { captureVideoFrame, genericAdapter, NoSubtitlesError, resolvePlatformAdapter } from '../adapters/platforms';
import { genericCanonicalUrl, resolveDirectMediaUrls } from '../adapters/platforms/generic';
import { startSubtitleCaptureListener } from '../adapters/platforms/subtitle-capture';
import { createTranslator, detectLocale, resolveLocale, type Translator } from '../core/i18n';
import {
  err,
  ok,
  readableError,
  type ApiResponse,
  type CaptureResult,
  type ContentRequest,
  type CourseContext,
  type PlaybackInfo,
} from '../core/messages';
import type { Course, Setting } from '../core/models';

export default defineContentScript({
  matches: [
    '*://*.bilibili.com/video/*',
    '*://*.icourse163.org/*',
    '*://*.xuetangx.com/*',
    '*://*.zhihuishu.com/*',
    '*://*.youtube.com/watch*',
  ],
  main() {
    // 后台按需注入（scripting.executeScript）与清单注入可能落在同一 isolated world：
    // 防双跑（扩展重载后的注入是新 world，无此标记，可正常复活）
    const GUARD = '__kedaibiaoContentLoaded';
    const win = window as unknown as Record<string, boolean>;
    if (win[GUARD]) return;
    win[GUARD] = true;

    // 语言初始化：同步按浏览器 UI 语言兜底，异步叠加设置里的手动指定；
    // 文案消费方（handle 错误串、悬浮按钮）在 tReady 后取词，保证手动语言即时生效
    let t: Translator = createTranslator(detectLocale(browser.i18n.getUILanguage()));
    const tReady = (async () => {
      try {
        const resp = (await browser.runtime.sendMessage({
          type: 'setting:get',
        })) as ApiResponse<Setting>;
        if (resp.ok) {
          t = createTranslator(resolveLocale(resp.data.language, browser.i18n.getUILanguage()));
        }
      } catch {
        // 后台不可达（扩展重载等）：维持 UI 语言兜底
      }
    })();

    // MOOC 等平台字幕走 MAIN world 拦截器，这里接收 postMessage 回传；
    // 捕获到新分段时广播给面板实时刷新
    startSubtitleCaptureListener(() => {
      void browser.runtime.sendMessage({ type: 'subtitles:changed' }).catch(() => {});
    });

    const primary = resolvePlatformAdapter(location.href);
    /**
     * 平台选择器失效时降级 generic，并向面板上报 degraded。
     * 只在 course:getContext 实时评估（身份信息失效才降级，恢复即回到平台模式）；
     * 视频元素暂未挂载属瞬态（页面加载中/播放器重建），不能粘滞为永久降级——
     * 否则 YouTube 等重页面在面板首轮轮询时就会被误标 generic，
     * 课程 id 也会串成 generic: 形态、与正常状态分裂成两门课。
     */
    let degraded = false;

    const getVideo = (): HTMLVideoElement | null =>
      primary.getVideoEl() ?? genericAdapter.getVideoEl();

    /**
     * 等待视频元素出现：播放器懒加载 / SPA 重建时 <video> 未必已在文档里。
     * MutationObserver 观察文档树，轮询兜底 shadow root 内部的挂载；超时返回 null。
     */
    const SEEK_VIDEO_WAIT_MS = 10_000;
    function waitForVideo(): Promise<HTMLVideoElement | null> {
      const existing = getVideo();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (v: HTMLVideoElement | null) => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          window.clearInterval(poll);
          window.clearTimeout(timer);
          resolve(v);
        };
        const check = () => {
          const v = getVideo();
          if (v) finish(v);
        };
        const observer = new MutationObserver(check);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        const poll = window.setInterval(check, 500);
        const timer = window.setTimeout(() => finish(null), SEEK_VIDEO_WAIT_MS);
      });
    }
    /** 连续点击章节/笔记时，等待中的旧 seek 不落地，以最后一次为准 */
    let seekSeq = 0;

    // ---- A-B 循环复读：轮询实现，对 SPA 换视频元素健壮 ----
    let loopRange: { a: number; b: number } | null = null;
    window.setInterval(() => {
      if (!loopRange) return;
      const v = getVideo();
      if (v && v.currentTime > loopRange.b + 0.25) {
        v.currentTime = loopRange.a;
        void v.play().catch(() => {});
      }
    }, 250);

    // 截图质量设置（页面级缓存一次）
    let cachedQuality: number | null = null;
    async function getCaptureQuality(): Promise<number> {
      if (cachedQuality !== null) return cachedQuality;
      try {
        const resp = (await browser.runtime.sendMessage({
          type: 'setting:get',
        })) as ApiResponse<Setting>;
        if (resp.ok) cachedQuality = resp.data.capturePrefs.quality;
      } catch {
        // 用默认值
      }
      return cachedQuality ?? 0.85;
    }

    function canonicalUrl(): string {
      // 通用模式（含平台降级）：身份含 search+hash（SPA 哈希路由的视频身份在 hash 里），
      // 平台页维持原样（去 t、去 hash；MOOC 课节身份在课程 id 里而非 URL）
      if (degraded || primary.name === 'generic') return genericCanonicalUrl(location.href);
      const u = new URL(location.href);
      u.searchParams.delete('t');
      u.hash = '';
      return u.toString();
    }

    async function handle(msg: ContentRequest): Promise<ApiResponse<unknown>> {
      // 等语言就绪（仅首轮有实际等待），错误串按生效语言返回
      await tReady;
      switch (msg.type) {
        case 'course:getContext': {
          // 每次实时评估降级：仅平台身份信息失效才降级，瞬态故障恢复后自动回到平台模式
          let info;
          let infoFailed = false;
          try {
            info = primary.getCourseInfo();
          } catch {
            infoFailed = true;
          }
          if (!info?.title) {
            infoFailed = true;
            info = genericAdapter.getCourseInfo();
          }
          degraded = infoFailed && primary.name !== 'generic';
          const course: Course = {
            id: info.courseId,
            platform: degraded ? 'generic' : (primary.name as Course['platform']),
            title: info.title,
            url: canonicalUrl(),
            coverUrl: info.coverUrl,
            summary: '',
            titleLocked: false,
            updatedAt: Date.now(),
          };
          return ok({ course, degraded } satisfies Omit<CourseContext, 'tabId' | 'windowId'>);
        }

        case 'video:getTime': {
          const v = getVideo();
          return v ? ok(v.currentTime) : err(t('content.err.noVideoElement'));
        }

        case 'video:getPlaybackInfo': {
          const v = getVideo();
          if (!v) return err(t('content.err.noVideoElement'));
          // 直播/未就绪时 duration 为 Infinity/NaN，归一为 0 表示未知
          const duration = Number.isFinite(v.duration) ? v.duration : 0;
          return ok({
            currentTime: v.currentTime,
            duration,
            paused: v.paused,
            muted: v.muted,
            volume: v.volume,
            playbackRate: v.playbackRate,
          } satisfies PlaybackInfo);
        }

        case 'media:resolveAudio': {
          try {
            // 平台 adapter 优先（如 B站 playurl 纯音轨）；通用直链兜底
            const fromAdapter = primary.getAudioDownloadUrl
              ? await primary.getAudioDownloadUrl()
              : null;
            const urls =
              fromAdapter && fromAdapter.length > 0 ? fromAdapter : resolveDirectMediaUrls();
            return ok(urls.length > 0 ? urls : null);
          } catch (e) {
            return err(readableError(e));
          }
        }

        case 'video:seek': {
          // 播放器懒加载时等待视频元素就绪，而不是立刻报错
          const seq = ++seekSeq;
          const v = await waitForVideo();
          if (!v) return err(t('content.err.noVideoElement'));
          if (seq !== seekSeq) return ok(null);
          v.currentTime = msg.sec;
          await v.play().catch(() => {});
          return ok(null);
        }

        case 'video:capture': {
          const v = getVideo();
          if (!v) return err(t('content.err.noVideoElement'));
          try {
            // 优先平台 adapter；选择器失效则降级 generic 抓帧；质量走设置
            const frame = await captureVideoFrame(v, undefined, await getCaptureQuality());
            return ok({
              dataUrl: await blobToDataUrlCompat(frame.blob),
              width: frame.width,
              height: frame.height,
              time: v.currentTime,
            } satisfies CaptureResult);
          } catch (e) {
            // canvas 污染/DRM：抛给后台走 captureVisibleTab 降级
            return err(readableError(e));
          }
        }

        case 'video:setLoop':
          loopRange = { a: msg.a, b: msg.b };
          return ok(null);

        case 'video:clearLoop':
          loopRange = null;
          return ok(null);

        case 'video:jumpUrl': {
          try {
            return ok(degraded ? genericAdapter.makeJumpUrl() : primary.makeJumpUrl(msg.sec));
          } catch (e) {
            return err(readableError(e));
          }
        }

        case 'subtitles:get': {
          try {
            return ok(await primary.getSubtitles());
          } catch (e) {
            if (e instanceof NoSubtitlesError) return err(e.message);
            return err(t('content.err.subtitleFetchFailed', { error: readableError(e) }));
          }
        }

        case 'danmaku:get': {
          try {
            // 弹幕密度是可选增强：无实现/降级/失败都按空数据处理
            if (!degraded && primary.getDanmakuDensity) {
              return ok(await primary.getDanmakuDensity());
            }
            return ok([]);
          } catch {
            return ok([]);
          }
        }

        default:
          return err(t('content.err.unknownMessage'));
      }
    }

    const KNOWN_TYPES = new Set([
      'course:getContext',
      'video:getTime',
      'video:getPlaybackInfo',
      'media:resolveAudio',
      'video:seek',
      'video:capture',
      'video:setLoop',
      'video:clearLoop',
      'video:jumpUrl',
      'subtitles:get',
      'danmaku:get',
    ]);

    browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
      const msg = raw as ContentRequest;
      if (!msg || typeof msg.type !== 'string' || !KNOWN_TYPES.has(msg.type)) return false;
      handle(msg)
        .then(sendResponse)
        .catch((e: unknown) => sendResponse(err(readableError(e))));
      return true;
    });

    // ---- 页面内悬浮按钮：一键打开侧栏 ----
    function mountLauncher(): void {
      if (document.getElementById('kedaibiao-launcher')) return;
      const btn = document.createElement('button');
      btn.id = 'kedaibiao-launcher';
      btn.textContent = t('brand.name');
      btn.title = t('content.launcherTitle', { brand: t('brand.name') });
      btn.style.cssText =
        'position:fixed;right:16px;bottom:96px;z-index:2147483646;' +
        'padding:8px 12px;border-radius:8px;border:none;background:#2563eb;color:#fff;' +
        'font-size:13px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)';
      btn.addEventListener('click', () => {
        void browser.runtime.sendMessage({ type: 'panel:open' }).catch(() => {});
      });
      document.body.appendChild(btn);
    }

    // 智慧树反作弊会检测页面注入元素并拒绝播放，该域名不挂载悬浮按钮，
    // 面板走工具栏图标/快捷键打开（ Alt+K ）
    // 挂载等语言就绪，按钮文案直接按生效语言渲染
    if (primary.name !== 'zhihuishu') void tReady.then(() => mountLauncher());
  },
});

/** content script 里有 FileReader，优先使用；异常时回退手动 base64 */
async function blobToDataUrlCompat(blob: Blob): Promise<string> {
  try {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    const { blobToDataUrl } = await import('../core/utils/dataurl');
    return blobToDataUrl(blob);
  }
}
