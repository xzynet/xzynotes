/**
 * 内容脚本与激活弹窗文案：content.* 为页面悬浮按钮与 err() 错误串，
 * popup.* 为激活语音转写弹窗（activate-popup）的静态文案。
 * launcherTitle 的 {brand} 由调用方传入 t('brand.name')，避免重复定义品牌名。
 */
export const zh = {
  'content.launcherTitle': '打开{brand}笔记面板（如无反应，请点击浏览器工具栏图标或按 Alt+K）',
  'content.err.noVideoElement': '未找到视频元素',
  'content.err.subtitleFetchFailed': '字幕获取失败：{error}',
  'content.err.unknownMessage': '未知内容脚本消息',
  'popup.title': '激活语音转写',
  'popup.activated': '✓ 本页语音转写已激活',
  'popup.desc':
    '面板会在 2 秒内自动继续转写，此弹窗随后自动关闭。若面板已关闭，请重新打开并再点一次「开始转写」。',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'content.launcherTitle':
    'Open the {brand} notes panel (if nothing happens, click the browser toolbar icon or press Alt+K)',
  'content.err.noVideoElement': 'Video element not found',
  'content.err.subtitleFetchFailed': 'Failed to get subtitles: {error}',
  'content.err.unknownMessage': 'Unknown content script message',
  'popup.title': 'Activate Speech Transcription',
  'popup.activated': '✓ Speech transcription activated for this page',
  'popup.desc':
    'The panel will resume transcription within 2 seconds and this popup will close automatically. If the panel has been closed, reopen it and click "Start Transcription" again.',
};
