/**
 * ASR 转写链路错误 key：entrypoints/sidepanel/asr/ 下各纯 TS 模块
 * （capture / downloader / engine.worker / file-pipeline / stream-pipeline /
 * manager / punctuation / punct.worker）抛出的错误统一改用本表 key，
 * 展示端（AsrCard 等）经 localizeError 翻译。
 * 带动态细节的原文（主机名/文件路径/状态码/wasm 异常码）改为抛出前
 * console.warn 落诊断，message 保持静态 key 以便整串匹配。
 */
export const zh = {
  'asrErr.captureNeedsActivation': '扩展尚未在当前视频页激活',
  'asrErr.tabCaptureUnsupported': '当前浏览器不支持标签页音频捕获（需 Chrome 116+）',
  'asrErr.pageNotCapturable': '该页面不支持音频捕获（浏览器内置页面、扩展商店页等）',
  'asrErr.downloadCancelled': '下载已取消',
  'asrErr.noResponseBody': '响应无数据流',
  'asrErr.fileSizeMismatch': '文件大小校验失败',
  'asrErr.modelFileDownloadFailed': '模型文件下载失败',
  'asrErr.engineInternalError': '引擎内部异常，请重试或更换模型',
  'asrErr.wasmMissingFsCreateDataFile': 'WASM 运行时缺少 FS_createDataFile（构建导出缺失）',
  'asrErr.engineAborted': '引擎运行中止',
  'asrErr.modelCacheIncomplete': '模型缓存缺少文件，请重新下载',
  'asrErr.punctModelCacheIncomplete': '标点模型缓存不完整',
  'asrErr.punctDisabled': '标点恢复已停用',
  'asrErr.punctLoadFailed': '标点模型加载失败，本次转写不含标点',
  'asrErr.punctNotReady': '标点模型未就绪',
  'asrErr.punctDisposed': '标点服务已销毁',
  'asrErr.punctNotInitialized': '标点模型未初始化',
  'asrErr.punctTokensMissingUnk': 'tokens.json 缺少 <unk>',
  'asrErr.downloadStalled': '下载停滞（10 秒无数据）',
  'asrErr.downloadTooSlow': '下载速度过低（防盗链限速）',
  'asrErr.mediaSourceNotAuthorized': '该媒体源未授权跨域访问',
  'asrErr.readStalled': '读取停滞（10 秒无数据）',
  'asrErr.rangeNotSupported': '该媒体源不支持分段（Range）读取',
  'asrErr.missingContentRange': '无法获取媒体文件大小（响应缺少 Content-Range）',
  'asrErr.noAudioTrack': '媒体文件中没有音轨',
  'asrErr.cannotDecodeAudio': '浏览器无法解码该媒体的音频编码',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'asrErr.captureNeedsActivation': 'The extension has not been activated on the current video page',
  'asrErr.tabCaptureUnsupported':
    'This browser does not support tab audio capture (Chrome 116+ required)',
  'asrErr.pageNotCapturable':
    'This page does not support audio capture (browser internal pages, extension store pages, etc.)',
  'asrErr.downloadCancelled': 'Download cancelled',
  'asrErr.noResponseBody': 'The response has no data stream',
  'asrErr.fileSizeMismatch': 'File size verification failed',
  'asrErr.modelFileDownloadFailed': 'Failed to download a model file',
  'asrErr.engineInternalError': 'Internal engine error. Please retry or switch to another model',
  'asrErr.wasmMissingFsCreateDataFile':
    'The WASM runtime is missing FS_createDataFile (missing build export)',
  'asrErr.engineAborted': 'The transcription engine aborted',
  'asrErr.modelCacheIncomplete': 'The model cache is missing files. Please download again',
  'asrErr.punctModelCacheIncomplete': 'The punctuation model cache is incomplete',
  'asrErr.punctDisabled': 'Punctuation restoration has been disabled',
  'asrErr.punctLoadFailed':
    'Failed to load the punctuation model. This transcription will not include punctuation',
  'asrErr.punctNotReady': 'The punctuation model is not ready',
  'asrErr.punctDisposed': 'The punctuation service has been disposed',
  'asrErr.punctNotInitialized': 'The punctuation model is not initialized',
  'asrErr.punctTokensMissingUnk': 'tokens.json is missing <unk>',
  'asrErr.downloadStalled': 'Download stalled (no data received for 10 seconds)',
  'asrErr.downloadTooSlow': 'Download speed is too low (CDN anti-leech throttling)',
  'asrErr.mediaSourceNotAuthorized': 'Cross-origin access to this media source was not granted',
  'asrErr.readStalled': 'Reading stalled (no data received for 10 seconds)',
  'asrErr.rangeNotSupported': 'This media source does not support byte-range requests',
  'asrErr.missingContentRange':
    'Unable to determine the media file size (the response is missing Content-Range)',
  'asrErr.noAudioTrack': 'The media file contains no audio track',
  'asrErr.cannotDecodeAudio': 'The browser cannot decode the audio codec of this media',
};
