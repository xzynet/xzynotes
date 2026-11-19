/**
 * core 基础设施文案：章节切分兜底标题、ASR 模型卡片、跨层错误 key。
 * err.* 由 core/adapters 以 key 形式抛掷（throw new Error('err.xxx')），
 * 展示端统一 localizeError(t, err) 翻译；model.* 为 MessageKey，展示端 t() 后渲染。
 */
export const zh = {
  'chapters.untitled': '未命名章节',
  'chapters.emptySegment': '空分段',
  'model.paraformer.label': 'Paraformer 中英双语（流式）',
  'model.paraformer.description': '边说边出字，转写进度跟随播放实时刷新',
  'model.sensevoice.label': 'SenseVoice 多语种（离线分段）',
  'model.sensevoice.description': '标点与多语种效果更好，按约 15 秒分段出结果',
  'model.punct.label': 'CT-Transformer 标点恢复',
  'err.noteNotFound': '笔记不存在',
  'err.ocrUnavailable': 'OCR 功能将在 V1.5 提供（tesseract.js）',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'chapters.untitled': 'Untitled chapter',
  'chapters.emptySegment': 'Empty segment',
  'model.paraformer.label': 'Paraformer bilingual (streaming)',
  'model.paraformer.description': 'Words appear as the video plays, with progress refreshing in real time',
  'model.sensevoice.label': 'SenseVoice multilingual (offline segments)',
  'model.sensevoice.description': 'Better punctuation and multilingual quality, with results in ~15-second segments',
  'model.punct.label': 'CT-Transformer punctuation restoration',
  'err.noteNotFound': 'Note not found',
  'err.ocrUnavailable': 'OCR will be available in V1.5 (tesseract.js)',
};
