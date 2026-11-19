// 注意：不要加 /// <reference lib="webworker" /> —— webworker lib 会全局覆盖
// lib.dom 的 XHR 等类型，污染整个项目的编译（subtitle-interceptor 曾因此报错）。
// 本文件通过下方 scope 声明拿到所需的 worker 全局。
import {
  ASR_SAMPLE_RATE,
  StreamCueTracker,
  WindowSegmenter,
  makeCue,
  type EngineEvent,
  type EngineRequest,
} from '~/core/asr';

/**
 * 转写引擎 worker（classic worker，importScripts 加载 sherpa-onnx Emscripten 胶水）。
 *
 * 生命周期：init（加载 wasm + 写模型进 MEMFS + 建识别器）→ audio* → flush。
 * 两个模型对应两套运行时：
 *  - paraformer-streaming → online 运行时（createOnlineRecognizer，端点检测出句）
 *  - sensevoice           → offline 运行时（OfflineRecognizer，15s 定长窗口）
 */

// Emscripten 模块与胶水 API 的类型最弱化声明（胶水无类型包）
interface EmscriptenModule {
  FS_createDataFile?(parent: string, name: string, data: Uint8Array, canRead: boolean, canWrite: boolean): void;
  onRuntimeInitialized?: () => void;
  onAbort?: (why: unknown) => void;
  locateFile?: (path: string) => string;
  mainScriptUrlOrBlob?: string;
  [key: string]: unknown;
}

interface OnlineRecognizerLike {
  config: { modelConfig: { paraformer: { encoder: string } } };
  createStream(): OnlineStreamLike;
  isReady(s: OnlineStreamLike): boolean;
  decode(s: OnlineStreamLike): void;
  isEndpoint(s: OnlineStreamLike): boolean;
  reset(s: OnlineStreamLike): void;
  getResult(s: OnlineStreamLike): { text: string };
}

interface OnlineStreamLike {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  inputFinished(): void;
  free(): void;
}

interface OfflineRecognizerLike {
  createStream(): OfflineStreamLike;
  decode(s: OfflineStreamLike): void;
  getResult(s: OfflineStreamLike): { text: string };
}

interface OfflineStreamLike {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
}

declare function createOnlineRecognizer(Module: unknown, config: unknown): OnlineRecognizerLike;
declare const OfflineRecognizer: new (config: unknown, Module: unknown) => OfflineRecognizerLike;

const scope = self as unknown as {
  importScripts(...urls: string[]): void;
  Module: EmscriptenModule;
  postMessage(message: EngineEvent, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<EngineRequest>) => void) | null;
};

function post(event: EngineEvent): void {
  scope.postMessage(event);
}

const postError = (e: unknown) => {
  // C++ 层异常经 Emscripten 抛出时常为裸数字（异常指针/中止码），转成可读文案
  let message: string;
  if (e instanceof Error) message = e.message;
  else if (typeof e === 'number') {
    console.warn(`[kedaibiao] 引擎 wasm 异常码：${e}`);
    message = 'asrErr.engineInternalError';
  } else message = String(e);
  post({ type: 'error', message });
};

// ---- 会话状态（一次 init 建立，flush 后可复用） ----

let online: { recognizer: OnlineRecognizerLike; stream: OnlineStreamLike; tracker: StreamCueTracker; lastPartial: string } | null = null;
let offline: { recognizer: OfflineRecognizerLike; segmenter: WindowSegmenter; fedSamples: number } | null = null;

function writeFilesToMemfs(files: Record<string, ArrayBuffer>): void {
  const createDataFile = scope.Module.FS_createDataFile;
  if (!createDataFile) throw new Error('asrErr.wasmMissingFsCreateDataFile');
  for (const [path, buffer] of Object.entries(files)) {
    const name = path.split('/').pop() ?? path;
    createDataFile('/', name, new Uint8Array(buffer), true, true);
  }
}

function createOnline(recognizerModule: EmscriptenModule): void {
  const config = {
    featConfig: { sampleRate: ASR_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: '', decoder: '', joiner: '' },
      paraformer: { encoder: './encoder.int8.onnx', decoder: './decoder.int8.onnx' },
      zipformer2Ctc: { model: '' },
      nemoCtc: { model: '' },
      toneCtc: { model: '' },
      tokens: './tokens.txt',
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: '',
      modelingUnit: 'cjkchar',
      bpeVocab: '',
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
    hotwordsFile: '',
    hotwordsScore: 1.5,
    ctcFstDecoderConfig: { graph: '', maxActive: 3000 },
    ruleFsts: '',
    ruleFars: '',
  };
  const recognizer = createOnlineRecognizer(recognizerModule, config);
  online = {
    recognizer,
    stream: recognizer.createStream(),
    tracker: new StreamCueTracker(ASR_SAMPLE_RATE),
    lastPartial: '',
  };
}

function createOffline(recognizerModule: EmscriptenModule): void {
  const config = {
    featConfig: { sampleRate: ASR_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: './model.int8.onnx', useInverseTextNormalization: 1 },
      tokens: './tokens.txt',
      // offline 运行时为 pthread 构建（池 4），留 2 线程给解码与 UI
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  };
  const recognizer = new OfflineRecognizer(config, recognizerModule);
  offline = { recognizer, segmenter: new WindowSegmenter(ASR_SAMPLE_RATE, 15), fedSamples: 0 };
}

function handleInit(msg: Extract<EngineRequest, { type: 'init' }>): void {
  scope.Module = {
    locateFile: (p: string) => (p.endsWith('.wasm') ? msg.wasmUrls.mainWasm : p),
    // pthread 子 worker 直接以主 js 为入口（按 name=em-pthread 自检后进入消息等待）
    mainScriptUrlOrBlob: msg.wasmUrls.mainJs,
    onRuntimeInitialized: () => {
      try {
        writeFilesToMemfs(msg.files);
        if (msg.modelId === 'paraformer-streaming') createOnline(scope.Module);
        else createOffline(scope.Module);
        post({ type: 'ready' });
      } catch (e) {
        postError(e);
      }
    },
    onAbort: (why) => {
      console.warn('[kedaibiao] 引擎运行中止：', why);
      post({ type: 'error', message: 'asrErr.engineAborted' });
    },
  };
  scope.importScripts(msg.wasmUrls.mainJs, msg.wasmUrls.glueJs);
}

// ---- 流式（Paraformer）：喂样本 → 尽力解码 → 端点出句 ----

function handleOnlineAudio(samples: Float32Array): void {
  if (!online) return;
  const { recognizer, stream, tracker } = online;
  tracker.feed(samples.length);
  stream.acceptWaveform(ASR_SAMPLE_RATE, samples);
  while (recognizer.isReady(stream)) recognizer.decode(stream);

  const isEndpoint = recognizer.isEndpoint(stream);
  let text = recognizer.getResult(stream).text;

  // 官方示例的 Paraformer 尾垫技巧：端点触发后补 1 秒静音再取一次结果，补全尾部识别
  if (isEndpoint && recognizer.config.modelConfig.paraformer.encoder !== '') {
    stream.acceptWaveform(ASR_SAMPLE_RATE, new Float32Array(ASR_SAMPLE_RATE));
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    text = recognizer.getResult(stream).text;
  }

  if (text && text !== online.lastPartial) {
    online.lastPartial = text;
    post({ type: 'partial', text });
  }

  if (isEndpoint) {
    const cue = tracker.endpointCue(online.lastPartial);
    online.lastPartial = '';
    recognizer.reset(stream);
    if (cue) post({ type: 'segment', cue });
  }
  post({ type: 'processed', seconds: tracker.fedSeconds });
}

// ---- 离线（SenseVoice）：定长窗口解码 ----

function decodeOfflineWindow(window: { startSec: number; endSec: number; samples: Float32Array }): void {
  if (!offline) return;
  const stream = offline.recognizer.createStream();
  try {
    stream.acceptWaveform(ASR_SAMPLE_RATE, window.samples);
    offline.recognizer.decode(stream);
    const { text } = offline.recognizer.getResult(stream);
    const cue = makeCue(window.startSec, window.endSec, text);
    if (cue) post({ type: 'segment', cue });
  } finally {
    stream.free();
  }
}

function handleOfflineAudio(samples: Float32Array): void {
  if (!offline) return;
  offline.fedSamples += samples.length;
  for (const window of offline.segmenter.push(samples)) decodeOfflineWindow(window);
  post({ type: 'processed', seconds: offline.fedSamples / ASR_SAMPLE_RATE });
}

// ---- flush：冲刷收尾 ----

function handleFlush(): void {
  if (online) {
    const { recognizer, stream, tracker } = online;
    stream.inputFinished();
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = online.lastPartial || recognizer.getResult(stream).text;
    const cue = tracker.flushCue(text);
    if (cue) post({ type: 'segment', cue });
    post({ type: 'processed', seconds: tracker.fedSeconds });
  } else if (offline) {
    const rest = offline.segmenter.flush();
    if (rest) decodeOfflineWindow(rest);
    post({ type: 'processed', seconds: offline.fedSamples / ASR_SAMPLE_RATE });
  }
  // 收尾完成信号必须在最后：面板的 flushEngine 靠它与音频块的 processed 区分
  post({ type: 'flushed' });
}

// ---- cut：音频断点强制切句（拖动/暂停恢复/跳过已转写区间） ----

function handleCut(): void {
  if (online) {
    const { recognizer, stream, tracker } = online;
    const text = online.lastPartial || recognizer.getResult(stream).text;
    // 残句立即落盘并重置流；空文本也会推进句起点，保证断点后新句从断点起算
    const cue = tracker.endpointCue(text);
    online.lastPartial = '';
    recognizer.reset(stream);
    if (cue) post({ type: 'segment', cue });
    return;
  }
  if (offline) {
    // SenseVoice 定长窗口：把不足一窗的残余立即解码出句
    const rest = offline.segmenter.flush();
    if (rest) decodeOfflineWindow(rest);
  }
}

scope.onmessage = (e: MessageEvent<EngineRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') handleInit(msg);
    else if (msg.type === 'audio') {
      if (online) handleOnlineAudio(msg.samples);
      else handleOfflineAudio(msg.samples);
    } else if (msg.type === 'flush') handleFlush();
    else if (msg.type === 'cut') handleCut();
  } catch (err) {
    postError(err);
  }
};
