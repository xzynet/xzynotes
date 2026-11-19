/**
 * 平台 adapter 文案：adapters/platforms 抛出的错误 key。
 * err.* 以 key 形式抛掷（throw new Error('err.xxx')），经 ApiResponse.err() 冒泡，
 * 展示端统一 localizeError(t, err) 翻译；zh 值为改造前的原始中文。
 */
export const zh = {
  'err.noVideoElement': '未找到视频元素',
  'err.videoNotReady': '视频尚未加载完成，无法截图',
  'err.canvasContextFailed': '无法创建 canvas 上下文',
  'err.captureFailed': '截图失败（可能是版权保护内容）',
  'err.bvidParseFailed': '无法从 URL 解析 BV 号',
  'err.biliPagesFailed': '无法获取视频分 P 信息',
  'err.biliCidFailed': '无法获取视频 cid',
  'err.wbiKeysFailed': '无法获取 WBI 签名口令',
  'err.youtubeMissingVideoParam': 'YouTube watch 页缺少 v 参数',
  'err.noSubtitles': '该视频暂无字幕，章节功能不可用',
  'err.noSubtitlesIcourse163':
    '未检测到 MOOC 字幕资源。请确认课程有字幕、已在播放器中开启字幕，并先播放几秒后重试',
  'err.noSubtitlesXuetangx':
    '未检测到学堂在线字幕资源。请确认课程有字幕、已在播放器中开启字幕，并先播放几秒后重试',
  'err.noSubtitlesZhihuishu':
    '未检测到智慧树字幕资源。请确认课程有字幕、已在播放器中开启字幕，并先播放几秒后重试',
  'err.noSubtitlesYoutube': '未检测到 YouTube 字幕。请确认视频提供字幕（CC），并先播放几秒后重试',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'err.noVideoElement': 'Video element not found',
  'err.videoNotReady': 'The video has not finished loading, so the frame cannot be captured',
  'err.canvasContextFailed': 'Failed to create canvas context',
  'err.captureFailed': 'Screenshot failed (possibly copyright-protected content)',
  'err.bvidParseFailed': 'Failed to parse the BV ID from the URL',
  'err.biliPagesFailed': 'Failed to get the multi-part video info',
  'err.biliCidFailed': 'Failed to get the video cid',
  'err.wbiKeysFailed': 'Failed to get the WBI signing keys',
  'err.youtubeMissingVideoParam': 'The YouTube watch page is missing the "v" parameter',
  'err.noSubtitles': 'This video has no subtitles; chapters are unavailable',
  'err.noSubtitlesIcourse163':
    'No MOOC subtitles detected. Make sure the course has subtitles, enable them in the player, play a few seconds, then retry',
  'err.noSubtitlesXuetangx':
    'No XuetangX subtitles detected. Make sure the course has subtitles, enable them in the player, play a few seconds, then retry',
  'err.noSubtitlesZhihuishu':
    'No Zhihuishu subtitles detected. Make sure the course has subtitles, enable them in the player, play a few seconds, then retry',
  'err.noSubtitlesYoutube':
    'No YouTube subtitles detected. Make sure the video provides subtitles (CC), play a few seconds, then retry',
};
