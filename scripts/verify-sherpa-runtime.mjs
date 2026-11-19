#!/usr/bin/env node
/**
 * 用真实模型对打包后的 sherpa-onnx WASM 运行时做全链路验证（Node 环境）：
 *   加载补丁后的运行时 → FS_createDataFile 写入真实 int8 模型 → 创建识别器
 *   → 喂 3 秒静音 + 3 秒合成正弦波 → 解码 → getResult 正常返回（不崩溃即通过）。
 *
 * 前置：先运行 fetch-sherpa-wasm.mjs（生成 public/wasm/sherpa/），并下载真实模型：
 *   mkdir -p .cache/sherpa-wasm/models
 *   curl -L -o .cache/sherpa-wasm/models/paraformer-encoder.int8.onnx \
 *     https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/encoder.int8.onnx
 *   curl -L -o .cache/sherpa-wasm/models/paraformer-decoder.int8.onnx \
 *     https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/decoder.int8.onnx
 *   curl -L -o .cache/sherpa-wasm/models/paraformer-tokens.txt \
 *     https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/tokens.txt
 *   curl -L -o .cache/sherpa-wasm/models/sensevoice-model.int8.onnx \
 *     https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx
 *   curl -L -o .cache/sherpa-wasm/models/sensevoice-tokens.txt \
 *     https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt
 *
 * 用法：node scripts/verify-sherpa-runtime.mjs [online|offline|all]
 */
import { copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const WASM_DIR = join(ROOT, 'public', 'wasm', 'sherpa');
const MODELS_DIR = join(ROOT, '.cache', 'sherpa-wasm', 'models');

const which = process.argv[2] ?? 'all';

/** 生成测试音频：3 秒静音 + 3 秒 440Hz 正弦波（16kHz） */
function syntheticAudio() {
  const rate = 16000;
  const out = new Float32Array(rate * 6);
  for (let i = rate * 3; i < out.length; i++) {
    out[i] = 0.3 * Math.sin((2 * Math.PI * 440 * (i - rate * 3)) / rate);
  }
  return out;
}

async function verifyOnline() {
  console.log('== online 运行时 + Paraformer 真实模型');
  const harness = `
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const vm = require('node:vm');
const wasmDir = ${JSON.stringify(join(WASM_DIR, 'online'))};
const modelsDir = ${JSON.stringify(MODELS_DIR)};
const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 300000);
globalThis.require = require;
globalThis.module = { exports: {} };
globalThis.__dirname = wasmDir;
globalThis.Module = {
  locateFile: (p) => nodePath.join(wasmDir, p),
  onRuntimeInitialized: () => {
    try {
      for (const [memfs, disk] of [['encoder.int8.onnx','paraformer-encoder.int8.onnx'],['decoder.int8.onnx','paraformer-decoder.int8.onnx'],['tokens.txt','paraformer-tokens.txt']]) {
        Module.FS_createDataFile('/', memfs, new Uint8Array(nodeFs.readFileSync(nodePath.join(modelsDir, disk))), true, true);
      }
      // 与 entrypoints/sidepanel/asr/engine.worker.ts 完全一致的识别器配置
      const config = {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: '', decoder: '', joiner: '' },
          paraformer: { encoder: './encoder.int8.onnx', decoder: './decoder.int8.onnx' },
          zipformer2Ctc: { model: '' },
          nemoCtc: { model: '' },
          toneCtc: { model: '' },
          tokens: './tokens.txt',
          numThreads: 1, provider: 'cpu', debug: 0,
          modelType: '', modelingUnit: 'cjkchar', bpeVocab: '',
        },
        decodingMethod: 'greedy_search', maxActivePaths: 4,
        enableEndpoint: 1, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20, hotwordsFile: '', hotwordsScore: 1.5,
        ctcFstDecoderConfig: { graph: '', maxActive: 3000 }, ruleFsts: '', ruleFars: '',
      };
      const recognizer = createOnlineRecognizer(Module, config);
      const stream = recognizer.createStream();
      const samples = JSON.parse(nodeFs.readFileSync(nodePath.join(modelsDir, 'synthetic.json'), 'utf8'));
      stream.acceptWaveform(16000, Float32Array.from(samples));
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      console.log('ONLINE-OK text=' + JSON.stringify(result.text));
      clearTimeout(timeout);
      process.exit(0);
    } catch (e) {
      console.error('ONLINE-FAIL', e && e.message ? e.message : String(e));
      process.exit(1);
    }
  },
  onAbort: (why) => { console.error('ONLINE-ABORT', String(why)); process.exit(1); },
};
vm.runInThisContext(nodeFs.readFileSync(nodePath.join(wasmDir, 'sherpa-onnx-wasm-main-asr.js'), 'utf8'), { filename: 'main.js' });
vm.runInThisContext(nodeFs.readFileSync(nodePath.join(wasmDir, 'sherpa-onnx-asr.js'), 'utf8'), { filename: 'glue.js' });
`;
  await runHarness('online', harness);
}

async function verifyOffline() {
  console.log('== offline 运行时 + SenseVoice 真实模型');
  const harness = `
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const vm = require('node:vm');
const wasmDir = ${JSON.stringify(join(WASM_DIR, 'offline'))};
const modelsDir = ${JSON.stringify(MODELS_DIR)};
const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 300000);
globalThis.require = require;
globalThis.module = { exports: {} };
globalThis.__dirname = wasmDir;
globalThis.Module = {
  locateFile: (p) => nodePath.join(wasmDir, p),
  onRuntimeInitialized: () => {
    try {
      for (const [memfs, disk] of [['model.int8.onnx','sensevoice-model.int8.onnx'],['tokens.txt','sensevoice-tokens.txt']]) {
        Module.FS_createDataFile('/', memfs, new Uint8Array(nodeFs.readFileSync(nodePath.join(modelsDir, disk))), true, true);
      }
      // 与 engine.worker.ts 完全一致的识别器配置
      const config = {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: './model.int8.onnx', useInverseTextNormalization: 1 },
          tokens: './tokens.txt',
          numThreads: 2, provider: 'cpu', debug: 0,
        },
      };
      const recognizer = new OfflineRecognizer(config, Module);
      const stream = recognizer.createStream();
      const samples = JSON.parse(nodeFs.readFileSync(nodePath.join(modelsDir, 'synthetic.json'), 'utf8'));
      stream.acceptWaveform(16000, Float32Array.from(samples));
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      console.log('OFFLINE-OK text=' + JSON.stringify(result.text));
      clearTimeout(timeout);
      process.exit(0);
    } catch (e) {
      console.error('OFFLINE-FAIL', e && e.message ? e.message : String(e));
      process.exit(1);
    }
  },
  onAbort: (why) => { console.error('OFFLINE-ABORT', String(why)); process.exit(1); },
};
// pthread 构建：Node 子 worker 需要 .cjs 入口（仓库 type:module 会让 .js 走 ESM）
Module.mainScriptUrlOrBlob = nodePath.join(wasmDir, '__pthread_main__.cjs');
vm.runInThisContext(nodeFs.readFileSync(nodePath.join(wasmDir, 'sherpa-onnx-wasm-main-vad-asr.js'), 'utf8'), { filename: 'main.js' });
vm.runInThisContext(nodeFs.readFileSync(nodePath.join(wasmDir, 'sherpa-onnx-asr.js'), 'utf8'), { filename: 'glue.js' });
`;
  // pthread 副本：子 worker 用
  await copyFile(
    join(WASM_DIR, 'offline', 'sherpa-onnx-wasm-main-vad-asr.js'),
    join(WASM_DIR, 'offline', '__pthread_main__.cjs'),
  );
  try {
    await runHarness('offline', harness);
  } finally {
    await rm(join(WASM_DIR, 'offline', '__pthread_main__.cjs'), { force: true });
  }
}

async function runHarness(name, code) {
  // 合成音频以 JSON 形式传给子进程（避免在 harness 字符串里内嵌大数组）
  const synthPath = join(MODELS_DIR, 'synthetic.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(synthPath, JSON.stringify([...syntheticAudio()]));

  const harnessPath = join(MODELS_DIR, `__verify-${name}.cjs`);
  writeFileSync(harnessPath, code);
  try {
    execFileSync(process.execPath, [harnessPath], { stdio: 'inherit', timeout: 320000 });
  } finally {
    await rm(harnessPath, { force: true });
    await rm(synthPath, { force: true });
  }
}

if (which === 'online' || which === 'all') await verifyOnline();
if (which === 'offline' || which === 'all') await verifyOffline();
console.log('全部验证通过');
