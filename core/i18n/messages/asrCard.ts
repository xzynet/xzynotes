/**
 * 语音转写卡片（AsrCard）文案：模型下载进度、激活引导、错误诊断、实时转写状态机。
 * asr.err.* 是卡片内部抛掷的错误 key（沿 catch 链到 toast，经 localizeError 翻译）；
 * 模型 label/description 用 model.*（infra 分片），转写链路模块抛出的错误用
 * asrErr.*（asrChain 分片），本分片不重复定义。
 */
export const zh = {
  'asr.punctDownloadDone': '标点模型下载完成',
  'asr.punctDownloadFailed': '标点模型下载失败：{message}',
  'asr.timelineRebased': '检测到进度条拖动/暂停，时间轴已自动重新对齐',
  'asr.coverageSkipToast': '该区间已转写过，跳过重复转写',
  'asr.noSpeech': '未识别到语音内容',
  'asr.transcribeDone': '转写完成，共 {count} 句',
  'asr.fileModeStarted': '开始下载视频源文件，完成后自动进入快进转写',
  'asr.fileExtractFailed': '提取视频源文件失败（{message}），已切换为实时转写',
  'asr.fileExtractFailedNoLive': '提取视频源文件失败（{message}）',
  'asr.punctNotReady': '标点模型尚未下载完成，本次转写不含标点',
  'asr.streamExtractFailed': '流式提取失败（{message}），已切换为实时转写',
  'asr.streamExtractFailedKeepFile': '流式提取失败（{message}），可改用「下载并转写」',
  'asr.err.mediaDownloadFailed': '媒体下载失败',
  'asr.err.engineLoadFailed': '引擎加载失败',
  'asr.err.noDirectSource':
    '没能解析到视频源文件地址；当前浏览器不支持捕获标签页音频（实时转写需 Chrome），无法转写该页面',
  'asr.hostedHint': '任务在后台运行：可以关闭侧栏或切换页面，转写会继续进行',
  'asr.mediaSourceNeedsAuth': '该媒体源需要跨域访问授权，后台转写无法弹出授权窗',
  'asr.authorizeAndRetry': '授权并重试',
  'asr.authorizeDenied': '未获得授权，无法访问该媒体源',
  'asr.connectingSource': '正在连接媒体源…',
  'asr.resolvingSource': '正在解析视频源地址…',
  'asr.downloadingMedia': '正在下载视频源文件…',
  'asr.decodingAudio': '正在解码音频…',
  'asr.downloadMediaHint': '下载完成后整段快进转写，比跟随播放的实时转写快得多',
  'asr.mediaProgress': '{pct}%（{loaded} / {total}）· {speed}/s{eta} · {host}',
  'asr.mediaEta': ' · 约剩 {time}',
  'asr.mediaProgressNoTotal': '已下载 {loaded} · {speed}/s · {host}',
  'asr.mediaConnecting': '连接中（{host}）…',
  'asr.preparingDownload': '准备下载…',
  'asr.stallHint': '若长时间无数据，将自动切换其他来源或回退为实时转写',
  'asr.stallHintNoLive': '若长时间无数据，将自动切换其他来源',
  'asr.decodingHint': '视频文件较大时解码需要数十秒，请稍候',
  'asr.sourceDetected': '检测到可提取的视频源文件',
  'asr.sourceHosts': '来源：{hosts}',
  'asr.listSeparator': '、',
  'asr.sourceChoices':
    '「流式转写」边下边解码边转写：不占大量内存、即刻开始（推荐）；「下载并转写」把源文件（可能几百 MB）整个下载到内存后再快进转写；也可以不下载，直接实时转写。',
  'asr.sourceChoicesNoLive':
    '「流式转写」边下边解码边转写：不占大量内存、即刻开始（推荐）；「下载并转写」把源文件（可能几百 MB）整个下载到内存后再快进转写。',
  'asr.streamMode': '流式转写（免下载）',
  'asr.downloadAndTranscribe': '下载并转写',
  'asr.useLiveMode': '改用实时转写',
  'asr.cardTitle': '本地语音转写（无字幕兜底）',
  'asr.cardDesc':
    '用浏览器本地运行的语音识别模型（sherpa-onnx WASM）把视频声音转成文字：能拿到视频源文件时整段快进转写，否则捕获标签页音频跟随播放转写。模型仅首次使用时下载一次。',
  'asr.cardDescNoLive':
    '用浏览器本地运行的语音识别模型（sherpa-onnx WASM）把视频声音转成文字：解析到视频源文件后整段或流式快进转写（当前浏览器的扩展没有标签页音频捕获能力，无法跟随播放实时转写）。模型仅首次使用时下载一次。',
  'asr.cached': '已缓存',
  'asr.needsDownload': '需下载',
  'asr.start': '开始转写',
  'asr.punctToggle': '给 Paraformer 流式结果自动恢复标点',
  'asr.punctDesc':
    '{label}模型约 {size}，{status}；标点失败不影响转写。SenseVoice 自带标点，无需此项。',
  'asr.statusDownloading': '下载中…',
  'asr.punctWillDownload': '勾选后即开始下载，仅下载一次',
  'asr.firstDownloadTitle': '首次使用需下载模型',
  'asr.firstDownloadDesc':
    '{label}，约 {size}。仅下载一次，之后离线可用；下载源 HuggingFace（不可达时自动切换镜像）。',
  'asr.downloadAndStart': '下载并开始',
  'asr.downloadingModel': '正在下载模型…',
  'asr.modelProgress': '{pct}%（{loaded} / {total}）· {file}',
  'asr.cancelDownload': '取消下载',
  'asr.activationTitle': '还差一步：在当前视频页激活扩展',
  'asr.activationDesc':
    'Chrome 规定扩展必须先在本页「激活」才能捕获标签页声音（站点权限也不能豁免）。任选一种方式激活：',
  'asr.activationRecommended': '推荐：',
  'asr.activationStep1':
    '点一下浏览器工具栏上的「{brand}」图标——弹出「已激活」提示即完成激活{notPinned}。',
  'asr.activationNotPinned': '（图标未固定到工具栏：先点工具栏右侧拼图形状的扩展菜单找到它）',
  'asr.activationStep2':
    '或在视频页面上点击鼠标右键，选择菜单里的「{brand}：激活本页语音转写」（会顺带打开面板）。',
  'asr.activationPolling':
    '正在每 2 秒自动检测，激活成功后自动继续转写。若面板被收起：重新打开面板再点一次「开始转写」即可，激活状态在本页保持有效。',
  'asr.engineLoading': '引擎加载中…（模型载入内存，可能需要数十秒）',
  'asr.modeLive': '实时转写中',
  'asr.modeStream': '流式转写中',
  'asr.modeFile': '文件转写中',
  'asr.lineCount': '{count} 句',
  'asr.inputVolume': '输入音量',
  'asr.noAudioInput': '无声音输入',
  'asr.diag': '诊断：AudioContext={state} · 音轨{track}/{ready}',
  'asr.diagMuted': '已静音',
  'asr.diagUnmuted': '未静音',
  'asr.diagTab': ' · 标签页{audible}',
  'asr.diagAudible': '在发声',
  'asr.diagSilent': '未发声',
  'asr.diagSiteMuted': ' · 站点被浏览器静音',
  'asr.diagVideo': ' · 视频{volume}{state}',
  'asr.diagVideoVolume': '音量{percent}%',
  'asr.diagPaused': '/暂停',
  'asr.diagPlaying': '/播放中',
  'asr.siteMutedWarning':
    '浏览器把这个网站静音了（标签页上可见静音图标）。右键点击标签页 →「取消网站静音」后声音即恢复。',
  'asr.videoMutedWarning':
    '页面视频处于静音状态（播放器静音或音量为 0）——捕获到的只会是无声流。请先在播放器里取消静音、调大音量。',
  'asr.silentTabInaudible': '标签页当前不在发声：请确认视频正在播放、播放器未静音。',
  'asr.silentCaptureFailed':
    '标签页在发声但捕获不到声音，该页面音频可能受保护策略限制。可「停止并保存」后重新点「开始转写」——会优先尝试直接提取视频源文件。',
  'asr.videoPaused': '视频已暂停——继续播放以继续转写',
  'asr.coverageSkipping': '当前区间已转写过，正在跳过——播到未转写的位置会自动继续',
  'asr.liveHint': '转写期间请保持视频播放；暂停转写会跳过对应内容{suffix}',
  'asr.liveHintSenseVoice': '；SenseVoice 按约 15 秒分段出结果，首段稍慢',
  'asr.streamHint': '流式提取音频并转写中，无需保持播放{progress}',
  'asr.streamProgress': ' · 已读取 {loaded}{total}',
  'asr.fileHint': '文件模式快进转写中，无需保持播放',
  'asr.waitingSpeech': '等待语音…',
  'asr.editTitle': '点击编辑文本',
  'asr.resumeTranscribe': '继续转写',
  'asr.pauseTranscribe': '暂停转写',
  'asr.stopAndSave': '停止并保存',
  'asr.cancelKeep': '取消（保留已转写部分）',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'asr.punctDownloadDone': 'Punctuation model downloaded',
  'asr.punctDownloadFailed': 'Punctuation model download failed: {message}',
  'asr.timelineRebased': 'Seek or pause detected; the timeline has been re-aligned automatically',
  'asr.coverageSkipToast': 'This section was already transcribed; skipping duplicate transcription',
  'asr.noSpeech': 'No speech recognized',
  'asr.transcribeDone': 'Transcription complete: {count} sentences in total',
  'asr.fileModeStarted':
    'Downloading the video source file; fast-forward transcription starts automatically when finished',
  'asr.fileExtractFailed':
    'Failed to extract the video source file ({message}); switched to live transcription',
  'asr.fileExtractFailedNoLive': 'Failed to extract the video source file ({message})',
  'asr.punctNotReady':
    'The punctuation model has not finished downloading; this transcription will have no punctuation',
  'asr.streamExtractFailed': 'Streaming extraction failed ({message}); switched to live transcription',
  'asr.streamExtractFailedKeepFile':
    'Streaming extraction failed ({message}); you can switch to "Download & transcribe"',
  'asr.err.mediaDownloadFailed': 'Media download failed',
  'asr.err.engineLoadFailed': 'Engine failed to load',
  'asr.err.noDirectSource':
    'No video source file address could be resolved, and this browser cannot capture tab audio (live transcription requires Chrome), so this page cannot be transcribed',
  'asr.hostedHint':
    'Running in the background: you can close the side panel or switch pages and transcription continues',
  'asr.mediaSourceNeedsAuth':
    'This media source needs cross-origin access permission, which cannot be prompted for by a background task',
  'asr.authorizeAndRetry': 'Authorize & retry',
  'asr.authorizeDenied': 'Permission was not granted, so this media source cannot be accessed',
  'asr.connectingSource': 'Connecting to media source…',
  'asr.resolvingSource': 'Resolving video source address…',
  'asr.downloadingMedia': 'Downloading video source file…',
  'asr.decodingAudio': 'Decoding audio…',
  'asr.downloadMediaHint':
    'Once downloaded, the whole file is transcribed fast-forward — much faster than live transcription that follows playback',
  'asr.mediaProgress': '{pct}% ({loaded} / {total}) · {speed}/s{eta} · {host}',
  'asr.mediaEta': ' · ~{time} left',
  'asr.mediaProgressNoTotal': 'Downloaded {loaded} · {speed}/s · {host}',
  'asr.mediaConnecting': 'Connecting ({host})…',
  'asr.preparingDownload': 'Preparing download…',
  'asr.stallHint':
    'If no data arrives for a long time, another source is tried automatically, or it falls back to live transcription',
  'asr.stallHintNoLive': 'If no data arrives for a long time, another source is tried automatically',
  'asr.decodingHint': 'Decoding a large video file can take tens of seconds; please wait',
  'asr.sourceDetected': 'Extractable video source file detected',
  'asr.sourceHosts': 'Source: {hosts}',
  'asr.listSeparator': ', ',
  'asr.sourceChoices':
    '"Stream transcribe" decodes and transcribes while downloading: low memory usage and starts right away (recommended). "Download & transcribe" downloads the entire source file (possibly hundreds of MB) into memory before fast-forward transcription. You can also skip the download and transcribe live directly.',
  'asr.sourceChoicesNoLive':
    '"Stream transcribe" decodes and transcribes while downloading: low memory usage and starts right away (recommended). "Download & transcribe" downloads the entire source file (possibly hundreds of MB) into memory before fast-forward transcription.',
  'asr.streamMode': 'Stream transcribe (no download)',
  'asr.downloadAndTranscribe': 'Download & transcribe',
  'asr.useLiveMode': 'Use live transcription instead',
  'asr.cardTitle': 'Local speech transcription (fallback when there are no subtitles)',
  'asr.cardDesc':
    'Turns video audio into text with a speech recognition model running locally in the browser (sherpa-onnx WASM): when the video source file is available the whole file is transcribed fast-forward; otherwise tab audio is captured and transcribed along with playback. The model is downloaded only once, on first use.',
  'asr.cardDescNoLive':
    'Turns video audio into text with a speech recognition model running locally in the browser (sherpa-onnx WASM): once the video source file is resolved, the file is transcribed fast-forward, whole-file or streaming (this browser cannot capture tab audio, so playback-following live transcription is unavailable). The model is downloaded only once, on first use.',
  'asr.cached': 'Cached',
  'asr.needsDownload': 'Needs download',
  'asr.start': 'Start transcription',
  'asr.punctToggle': 'Automatically restore punctuation for Paraformer streaming results',
  'asr.punctDesc':
    'The {label} model is about {size}: {status}. Punctuation failure does not affect transcription. SenseVoice has built-in punctuation and does not need this.',
  'asr.statusDownloading': 'downloading…',
  'asr.punctWillDownload': 'starts downloading once checked, and only once',
  'asr.firstDownloadTitle': 'Model download required for first use',
  'asr.firstDownloadDesc':
    '{label}, about {size}. Downloaded only once, then available offline. Source: HuggingFace (automatically switches to a mirror when unreachable).',
  'asr.downloadAndStart': 'Download & start',
  'asr.downloadingModel': 'Downloading model…',
  'asr.modelProgress': '{pct}% ({loaded} / {total}) · {file}',
  'asr.cancelDownload': 'Cancel download',
  'asr.activationTitle': 'One more step: activate the extension on this video page',
  'asr.activationDesc':
    'Chrome requires the extension to be "activated" on this page before it can capture tab audio (site permissions cannot exempt this). Activate it in either of these ways:',
  'asr.activationRecommended': 'Recommended: ',
  'asr.activationStep1':
    'Click the "{brand}" icon on the browser toolbar — the "Activated" popup means activation is done{notPinned}.',
  'asr.activationNotPinned':
    ' (the icon is not pinned to the toolbar: find it first in the puzzle-shaped extensions menu at the right end of the toolbar)',
  'asr.activationStep2':
    'Or right-click on the video page and choose "{brand}: Activate speech transcription on this page" from the menu (this also opens the panel).',
  'asr.activationPolling':
    'Checking automatically every 2 seconds; transcription continues automatically once activated. If the panel was collapsed: reopen it and click "Start transcription" again — activation stays valid on this page.',
  'asr.engineLoading': 'Loading engine… (loading the model into memory can take tens of seconds)',
  'asr.modeLive': 'Live transcribing',
  'asr.modeStream': 'Stream transcribing',
  'asr.modeFile': 'File transcribing',
  'asr.lineCount': '{count} sentences',
  'asr.inputVolume': 'Input volume',
  'asr.noAudioInput': 'No audio input',
  'asr.diag': 'Diagnostics: AudioContext={state} · track {track}/{ready}',
  'asr.diagMuted': 'muted',
  'asr.diagUnmuted': 'unmuted',
  'asr.diagTab': ' · tab {audible}',
  'asr.diagAudible': 'audible',
  'asr.diagSilent': 'silent',
  'asr.diagSiteMuted': ' · site muted by the browser',
  'asr.diagVideo': ' · video {volume}{state}',
  'asr.diagVideoVolume': 'volume {percent}%',
  'asr.diagPaused': '/paused',
  'asr.diagPlaying': '/playing',
  'asr.siteMutedWarning':
    'The browser has muted this site (a mute icon is visible on the tab). Right-click the tab → "Unmute site" and the sound comes back.',
  'asr.videoMutedWarning':
    'The page video is muted (the player is muted or its volume is 0) — only a silent stream can be captured. Unmute the player and turn the volume up first.',
  'asr.silentTabInaudible':
    'The tab is not producing sound: make sure the video is playing and the player is not muted.',
  'asr.silentCaptureFailed':
    'The tab is producing sound but nothing can be captured — the audio on this page may be restricted by a protection policy. You can "Stop & save" and then click "Start transcription" again — extracting the video source file directly will be tried first.',
  'asr.videoPaused': 'Video paused — resume playback to continue transcribing',
  'asr.coverageSkipping':
    'This section was already transcribed and is being skipped — transcription continues automatically at untranscribed positions',
  'asr.liveHint':
    'Keep the video playing while transcribing; pausing transcription skips the corresponding content{suffix}',
  'asr.liveHintSenseVoice':
    '; SenseVoice returns results in ~15-second segments, so the first segment is slower',
  'asr.streamHint':
    'Streaming audio extraction and transcription in progress, no need to keep playing{progress}',
  'asr.streamProgress': ' · read {loaded}{total}',
  'asr.fileHint': 'Fast-forward file transcription in progress, no need to keep playing',
  'asr.waitingSpeech': 'Waiting for speech…',
  'asr.editTitle': 'Click to edit text',
  'asr.resumeTranscribe': 'Resume',
  'asr.pauseTranscribe': 'Pause',
  'asr.stopAndSave': 'Stop & save',
  'asr.cancelKeep': 'Cancel (keep transcribed part)',
};
