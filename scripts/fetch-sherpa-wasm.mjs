#!/usr/bin/env node
/**
 * 拉取 sherpa-onnx WASM 运行时（在线 Paraformer / 离线 SenseVoice 两套），
 * 剥掉 Emscripten 的模型预载逻辑（--preload-file 生成的 .data 自启动加载），
 * 用 Node 冒烟验证后拷入 public/wasm/sherpa/。
 *
 * 用法：node scripts/fetch-sherpa-wasm.mjs
 * 捆绑包缓存在 .cache/sherpa-wasm/（已 gitignore），重复运行不重新下载。
 *
 * 背景：官方 release 的 wasm 资产把模型以 .data 形式硬绑定进启动流程，
 * 扩展要求「运行时随包分发、模型按需下载」，因此补丁移除该 IIFE；
 * 运行时初始化后由 worker 用 Module.FS.writeFile 写入自己下载的 int8 模型。
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CACHE_DIR = join(ROOT, '.cache', 'sherpa-wasm');
const OUT_DIR = join(ROOT, 'public', 'wasm', 'sherpa');

const RUNTIMES = [
  {
    slot: 'online',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-wasm-simd-v1.13.7-zh-en-asr-paraformer.tar.bz2',
    archive: 'asr-paraformer.tar.bz2',
    innerDir: 'sherpa-onnx-wasm-simd-v1.13.7-zh-en-asr-paraformer',
    mainJs: 'sherpa-onnx-wasm-main-asr.js',
    glueJs: 'sherpa-onnx-asr.js',
    keep: ['sherpa-onnx-wasm-main-asr.js', 'sherpa-onnx-wasm-main-asr.wasm', 'sherpa-onnx-asr.js'],
    exports: ['_SherpaOnnxCreateOnlineRecognizer', '_SherpaOnnxCreateOnlineStream', '_SherpaOnnxDecodeOnlineStream', '_SherpaOnnxGetOnlineStreamResultAsJson'],
  },
  {
    slot: 'offline',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-wasm-simd-1.13.2-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small.tar.bz2',
    archive: 'vad-asr-sensevoice.tar.bz2',
    innerDir: 'sherpa-onnx-wasm-simd-1.13.2-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small',
    mainJs: 'sherpa-onnx-wasm-main-vad-asr.js',
    glueJs: 'sherpa-onnx-asr.js',
    keep: ['sherpa-onnx-wasm-main-vad-asr.js', 'sherpa-onnx-wasm-main-vad-asr.wasm', 'sherpa-onnx-asr.js'],
    exports: ['_SherpaOnnxCreateOfflineRecognizer', '_SherpaOnnxCreateOfflineStream', '_SherpaOnnxDecodeOfflineStream', '_SherpaOnnxGetOfflineStreamResultAsJson'],
    // vad-asr 构建带 -pthread（PTHREAD_POOL_SIZE=4 + shared memory）。
    // Node 冒烟时 pthread 子 worker 会按 mainScriptUrlOrBlob 再起进程，
    // 而本仓库是 type:module，.js 会被当 ESM 加载失败 → 复制一份 .cjs 专供子 worker。
    pthread: true,
  },
];

function download(url, dest) {
  return new Promise((resolvePromise, rejectPromise) => {
    const file = createWriteStream(dest);
    const follow = (u, redirects) => {
      httpsGet(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects > 8) return rejectPromise(new Error(`重定向过多: ${url}`));
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return rejectPromise(new Error(`HTTP ${res.statusCode}: ${url}`));
        }
        const total = Number(res.headers['content-length'] ?? 0);
        let loaded = 0;
        let lastLog = 0;
        res.on('data', (chunk) => {
          loaded += chunk.length;
          const now = Date.now();
          if (now - lastLog > 3000 && total > 0) {
            lastLog = now;
            console.log(`  下载中 ${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
          }
        });
        res.pipe(file).on('finish', () => file.close(() => resolvePromise(undefined)));
      }).on('error', rejectPromise);
    };
    follow(url, 0);
  });
}

/**
 * 剥掉 Emscripten --preload-file 生成的启动期 .data 加载块：
 *   if(!Module["expectedDataFileDownloads"])Module["expectedDataFileDownloads"]=0;
 *   Module["expectedDataFileDownloads"]++;(()=>{ ...loadPackage... })();
 * 该块之后紧跟 `var arguments_=[]`，以此作为稳定右边界。
 */
function stripPreloadBlock(src) {
  const left = src.indexOf('if(!Module["expectedDataFileDownloads"])');
  if (left < 0) throw new Error('未找到 expectedDataFileDownloads 起始标记');
  const iife = src.indexOf('(()=>{', left);
  if (iife < 0) throw new Error('未找到预载 IIFE');
  const rightMarker = ';var arguments_=[];';
  const right = src.indexOf(rightMarker, iife);
  if (right < 0) throw new Error('未找到预载块右边界（emscripten 模板可能已变化）');
  const removed = src.slice(left, right + 1);
  if (!removed.includes('.data')) throw new Error('预载块内未见 .data 引用，拒绝打补丁');
  return src.slice(0, left) + src.slice(right + 1);
}

/** Node 冒烟验证：运行时初始化成功、预期的导出函数存在、且全程不触碰 .data。 */
async function smokeTest(dir, mainJs, expectedExports, { pthread = false } = {}) {
  // 注意：本仓库 package.json 是 "type":"module"，直接 require .js 会被当作 ESM，
  // 导致官方胶水顶层的 `var Module` 变成模块局部变量而忽略预置的 globalThis.Module。
  // 这里用 vm.runInThisContext 还原浏览器 importScripts 的经典脚本语义
  // （顶层 var 挂到全局），并补上 Node 分支需要的全局 require/__dirname。
  let mainScriptUrlOrBlobSetup = '';
  if (pthread) {
    // pthread 构建会让 emscripten 以 mainScriptUrlOrBlob 再起 4 个子 worker；
    // Node worker_threads 加载 .js 会撞上仓库的 ESM 语义，故复制 .cjs 副本专供子 worker。
    await copyFile(join(dir, mainJs), join(dir, '__pthread_main__.cjs'));
    mainScriptUrlOrBlobSetup = `Module.mainScriptUrlOrBlob = nodePath.join(dir, '__pthread_main__.cjs');`;
  }
  const harness = `
const nodePath = require('node:path');
const nodeFs = require('node:fs');
const vm = require('node:vm');
const dir = ${JSON.stringify(dir)};
const opened = [];
const origRead = nodeFs.readFileSync.bind(nodeFs);
nodeFs.readFileSync = (p, ...a) => { opened.push(String(p)); return origRead(p, ...a); };
const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
globalThis.require = require;
globalThis.__dirname = dir;
globalThis.Module = {
  locateFile: (p) => nodePath.join(dir, p),
  onRuntimeInitialized: () => {
    const missing = ${JSON.stringify(expectedExports)}.filter((k) => typeof Module[k] !== 'function');
    const touchedData = opened.some((p) => p.endsWith('.data'));
    if (missing.length) { console.error('MISSING:' + missing.join(',')); process.exit(3); }
    if (touchedData) { console.error('DATA-TOUCHED'); process.exit(4); }
    console.log('SMOKE-OK');
    clearTimeout(timeout);
    process.exit(0);
  },
  onAbort: (why) => { console.error('ABORT:' + why); process.exit(5); },
};
${mainScriptUrlOrBlobSetup}
const mainPath = nodePath.join(dir, ${JSON.stringify(mainJs)});
vm.runInThisContext(nodeFs.readFileSync(mainPath, 'utf8'), { filename: mainPath });
`;
  const harnessPath = join(dir, '__smoke__.cjs');
  writeFileSync(harnessPath, harness);
  try {
    execFileSync(process.execPath, [harnessPath], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 150000 });
  } finally {
    await rm(harnessPath, { force: true });
    if (pthread) await rm(join(dir, '__pthread_main__.cjs'), { force: true });
  }
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const rt of RUNTIMES) {
    const archivePath = join(CACHE_DIR, rt.archive);
    if (!existsSync(archivePath)) {
      console.log(`下载 ${rt.slot} 运行时捆绑包：${rt.url}`);
      await download(rt.url, archivePath);
    } else {
      console.log(`缓存命中：${rt.archive}`);
    }
    console.log(`解包 ${rt.archive} …`);
    // --force-local：Windows 下 GNU tar 会把 "E:\..." 误解析为远程主机路径
    execFileSync('tar', ['-x', '--force-local', '-f', archivePath, '-C', CACHE_DIR]);
    const inner = join(CACHE_DIR, rt.innerDir);
    for (const f of rt.keep) {
      if (!existsSync(join(inner, f))) throw new Error(`捆绑包内缺少 ${f}`);
    }

    const jsPath = join(inner, rt.mainJs);
    const src = readFileSync(jsPath, 'utf8');
    const patched = stripPreloadBlock(src);
    writeFileSync(jsPath, patched);
    console.log(`已剥离预载块：${rt.mainJs}（移除 ${src.length - patched.length} 字节）`);

    console.log(`Node 冒烟验证 ${rt.slot} 运行时 …`);
    await smokeTest(inner, rt.mainJs, rt.exports, { pthread: rt.pthread === true });
    console.log(`  ✔ ${rt.slot} 运行时初始化正常，导出函数齐备，未触碰 .data`);

    const outSlot = join(OUT_DIR, rt.slot);
    mkdirSync(outSlot, { recursive: true });
    for (const f of rt.keep) {
      await copyFile(join(inner, f), join(outSlot, f));
    }
    console.log(`  ✔ 已拷入 public/wasm/sherpa/${rt.slot}/`);
  }
  console.log('\n完成。产物：');
  for (const slot of ['online', 'offline']) {
    for (const f of readdirSync(join(OUT_DIR, slot))) {
      console.log(`  public/wasm/sherpa/${slot}/${f}  ${(statSync(join(OUT_DIR, slot, f)).size / 1048576).toFixed(2)} MB`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
