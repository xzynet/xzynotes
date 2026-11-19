/**
 * 后台（MV3 service worker）文案：toast 广播、ApiResponse 错误串、右键菜单标题。
 * bg.err.* 以 key 形式透传给面板/选项页，由展示端 localizeError 翻译；
 * bg.toast.* 在后台本地翻译后广播，{error}/{time} 为插值占位符。
 */
export const zh = {
  'bg.contextMenuActivate': '学知云课记：激活本页语音转写',
  'bg.err.noActiveTab': '未找到活动标签页',
  'bg.err.connectPage': '无法连接页面，请刷新视频页后重试',
  'bg.err.connectPageScript': '无法连接页面脚本（扩展更新/重载后旧页面会失效），请刷新视频页后重试',
  'bg.err.pageNotActivated': '当前页面暂不可用：请先点击浏览器工具栏图标激活本页（浏览器内置页/商店页不支持）',
  'bg.err.pageUnsupported': '当前页面不支持（浏览器内置页面/扩展商店页等无法注入脚本）',
  'bg.err.courseScriptInactive': '该课程页脚本未激活：已切换到该页，请点击浏览器工具栏上的扩展图标激活本页后重试',
  'bg.err.courseScriptStale': '该课程页面的脚本已失效（扩展更新/重载所致），已切换到该页，请刷新后重试',
  'bg.err.aiNotConfigured': '请先在设置页配置 AI 大模型（Base URL / 模型名 / API Token）',
  'bg.err.noSubtitleContent': '没有可用的字幕内容',
  'bg.err.aiNoChapters': 'AI 未返回有效章节',
  'bg.err.aiModelTokenRequired': '请先填写模型名与 API Token 并保存',
  'bg.err.aiConsentRequired':
    'AI 功能需要你先授权「网站内容」外传（Firefox 会在点击时询问，可在扩展的「权限与数据」里随时关闭）',
  'bg.err.titleEmpty': '标题不能为空',
  'bg.err.courseNotFound': '课程不存在',
  'bg.err.noteNotFound': '笔记不存在',
  'bg.err.imageNotFound': '截图不存在',
  'bg.err.invalidUrl': '非法 URL',
  'bg.err.httpOnly': '仅支持 http(s) 资源',
  'bg.err.unknownMessage': '未知消息类型',
  'bg.err.asrHostUnsupported': '当前浏览器不支持后台转写（需 Chrome 的 offscreen 能力）',
  'bg.err.asrHostNoResponse': '转写宿主无响应（扩展内部错误，请重试）',
  'bg.toast.captureFailed': '截图失败：{error}',
  'bg.toast.duplicateCapture': '该时间点 1 秒内已有截图，未重复创建',
  'bg.toast.captureSaved': '已保存截图笔记 {time}',
  'bg.toast.bookmarkSaved': '已收藏时间点 {time}',
  'bg.toast.commandFailed': '操作失败：{error}',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'bg.contextMenuActivate': 'XZY Notes: Activate on-page transcription',
  'bg.err.noActiveTab': 'No active tab found',
  'bg.err.connectPage': 'Cannot reach the page. Refresh the video page and try again',
  'bg.err.connectPageScript':
    'Cannot reach the page script (pages opened before an extension update/reload go stale). Refresh the video page and try again',
  'bg.err.pageNotActivated':
    'This page is not available yet: click the extension icon in the browser toolbar to activate it first (browser built-in pages and store pages are not supported)',
  'bg.err.pageUnsupported':
    'This page is not supported (scripts cannot be injected into browser built-in pages, the extension store, and similar pages)',
  'bg.err.courseScriptInactive':
    'The script on this course page is not activated. Switched to that tab — click the extension icon in the browser toolbar to activate the page, then try again',
  'bg.err.courseScriptStale':
    'The script on this course page went stale (due to an extension update/reload). Switched to that tab — refresh the page and try again',
  'bg.err.aiNotConfigured':
    'Set up the AI model on the settings page first (Base URL / model / API token)',
  'bg.err.noSubtitleContent': 'No subtitle content available',
  'bg.err.aiNoChapters': 'The AI returned no valid chapters',
  'bg.err.aiModelTokenRequired': 'Fill in the model name and API token, then save first',
  'bg.err.aiConsentRequired':
    'AI features need your authorization to transmit "website content" (Firefox asks when you click; you can turn it off anytime under the extension\'s Permissions and data)',
  'bg.err.titleEmpty': 'Title cannot be empty',
  'bg.err.courseNotFound': 'Course not found',
  'bg.err.noteNotFound': 'Note not found',
  'bg.err.imageNotFound': 'Screenshot not found',
  'bg.err.invalidUrl': 'Invalid URL',
  'bg.err.httpOnly': 'Only http(s) resources are supported',
  'bg.err.unknownMessage': 'Unknown message type',
  'bg.err.asrHostUnsupported':
    'This browser does not support hosted transcription (requires the Chrome offscreen API)',
  'bg.err.asrHostNoResponse': 'The transcription host did not respond (internal error; please retry)',
  'bg.toast.captureFailed': 'Capture failed: {error}',
  'bg.toast.duplicateCapture':
    'A screenshot already exists within 1 second of this point; skipped',
  'bg.toast.captureSaved': 'Screenshot note saved at {time}',
  'bg.toast.bookmarkSaved': 'Bookmarked {time}',
  'bg.toast.commandFailed': 'Action failed: {error}',
};
