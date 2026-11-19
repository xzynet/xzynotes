/**
 * AI 模块文案：章节切分 prompt 模板（ai.*）与 LLM 调用/解析错误（aiErr.*）。
 * prompt 模板双语独立成文（英文 locale 时 AI 输出随之英文）；
 * JSON 字段名（chapters/startSec/title/summary/overview）两语言保持一致，解析逻辑依赖。
 */
export const zh = {
  'ai.systemPrompt':
    '你是网课内容分析助手，擅长把讲授字幕按话题切分章节并做内容摘要。' +
    '严格遵守：只输出一个 JSON 对象，不要输出 Markdown 围栏或任何解释性文字。',
  'ai.chunkNote':
    '本字幕为第 {index}/{count} 段，startSec 必须使用原时间轴的绝对秒数。',
  'ai.overviewNote': '，另有 "overview" 字段：整段讲授内容的整体概述（3~5 句话）',
  'ai.userPrompt': `课程标题：{courseTitle}
{chunkNote}
请按讲授话题把以下字幕切分为章节。要求：
1. 每章时长建议在 {minSec}~600 秒之间，切点落在话题转换处；
2. startSec 为该章起始位置的秒数（取对应字幕行的时间戳换算为秒）；
3. title 概括该章主题，不超过 20 字；summary 用 2~3 句话概括该章讲授内容；
4. 输出 JSON：{"chapters": [{"startSec": 秒数, "title": "...", "summary": "..."}]{overviewNote}}

字幕：
{transcript}`,
  'aiErr.parseNoJson': 'AI 返回内容中找不到 JSON 对象',
  'aiErr.parseInvalidJson': 'AI 返回内容无法解析为 JSON',
  'aiErr.parseBadShape': 'AI 返回的章节格式不正确',
  'aiErr.http401': 'API Token 无效或权限不足',
  'aiErr.http404': '接口不存在，请检查 Base URL（需 OpenAI 兼容地址）与模型名',
  'aiErr.http429': 'AI 服务限流，请稍后重试',
  'aiErr.httpFailed': 'AI 请求失败',
  'aiErr.fetchUnsupported': '当前环境不支持网络请求',
  'aiErr.network': '无法连接 AI 服务：请检查 Base URL、网络，以及设置页的域名访问授权',
  'aiErr.badResponse': 'AI 返回了非 JSON 响应，请检查 Base URL 是否为 OpenAI 兼容接口',
  'aiErr.missingChoices': 'AI 响应缺少 choices 内容',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'ai.systemPrompt':
    'You are an online-course content analysis assistant, skilled at splitting lecture ' +
    'transcripts into topic-based chapters and summarizing the content. ' +
    'Strictly follow: output exactly one JSON object, with no Markdown fences or any explanatory text.',
  'ai.chunkNote':
    'This transcript is part {index} of {count}; startSec must use absolute seconds on the original timeline.',
  'ai.overviewNote': ', plus an "overview" field: a 3~5 sentence overview of the entire lecture',
  'ai.userPrompt': `Course title: {courseTitle}
{chunkNote}
Split the following transcript into chapters by lecture topic. Requirements:
1. Each chapter should be {minSec}~600 seconds long; place cuts at topic transitions;
2. startSec is the chapter's start position in seconds (convert the timestamp of the corresponding transcript line into seconds);
3. title summarizes the chapter topic in at most 20 characters; summary describes the chapter's content in 2~3 sentences;
4. Output JSON: {"chapters": [{"startSec": seconds, "title": "...", "summary": "..."}]{overviewNote}}

Transcript:
{transcript}`,
  'aiErr.parseNoJson': 'No JSON object found in the AI response',
  'aiErr.parseInvalidJson': 'The AI response could not be parsed as JSON',
  'aiErr.parseBadShape': 'The chapters returned by the AI are not in the expected format',
  'aiErr.http401': 'Invalid API token or insufficient permissions',
  'aiErr.http404': 'Endpoint not found; check the Base URL (must be an OpenAI-compatible address) and the model name',
  'aiErr.http429': 'The AI service is rate-limited; please try again later',
  'aiErr.httpFailed': 'AI request failed',
  'aiErr.fetchUnsupported': 'Network requests are not supported in this environment',
  'aiErr.network':
    'Cannot reach the AI service; check the Base URL, your network, and the domain access permission on the settings page',
  'aiErr.badResponse':
    'The AI returned a non-JSON response; check that the Base URL is an OpenAI-compatible endpoint',
  'aiErr.missingChoices': 'The AI response is missing choices content',
};
