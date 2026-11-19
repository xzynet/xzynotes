import { ASR_MODELS, type AsrModelId } from '~/core/asr';

/**
 * 转写能力矩阵（构建期按目标浏览器固化，对应 wxt.config.ts 里的浏览器分支）。
 *
 * - 文件/流式转写：**跨浏览器**。两条路都只用标准 Web API，与 tabCapture 无关——
 *   下载直链走扩展页 fetch（跨域被拒时按需申请该源 host 权限），文件模式用
 *   decodeAudioData 解码、流式模式用 WebCodecs（mediabunny，Firefox 130+ 桌面版支持）边下边解。
 * - 实时转写：**仅 Chrome**。核心 API chrome.tabCapture.getMediaStreamId 为 Chrome 独占，
 *   Firefox 无等价物（getDisplayMedia 每次都要用户手动选共享源，无法跟随播放）。
 * - 跨源隔离：COOP/COEP 只能写进 Chrome 的 manifest（Firefox 不认 cross_origin_* 键），
 *   因此 Firefox 扩展页的 crossOriginIsolated 恒为 false、拿不到 SharedArrayBuffer，
 *   pthread 构建的运行时不可用。
 */

/** 是否支持捕获标签页音频（实时转写） */
export const LIVE_CAPTURE_SUPPORTED = !import.meta.env.FIREFOX;

/** 扩展页是否跨源隔离（SharedArrayBuffer 可用） */
export const CROSS_ORIGIN_ISOLATED = !import.meta.env.FIREFOX;

/** 按能力挑出可用模型：运行时依赖 SAB 而当前上下文不隔离时剔除（纯函数，便于单测） */
export function modelsForCapabilities(opts: { crossOriginIsolated: boolean }): AsrModelId[] {
  return (Object.keys(ASR_MODELS) as AsrModelId[]).filter(
    (id) => !ASR_MODELS[id].needsSharedArrayBuffer || opts.crossOriginIsolated,
  );
}

/** 当前浏览器可用的转写模型 */
export const SUPPORTED_ASR_MODELS: AsrModelId[] = modelsForCapabilities({
  crossOriginIsolated: CROSS_ORIGIN_ISOLATED,
});
