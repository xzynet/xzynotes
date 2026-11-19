# sherpa-onnx WASM 运行时（随扩展打包）

来源：Apache-2.0，<https://github.com/k2-fsa/sherpa-onnx>。

- `online/`：`sherpa-onnx-wasm-simd-v1.13.7-zh-en-asr-paraformer.tar.bz2` 提取，导出**流式**识别 API（OnlineRecognizer），供 Paraformer 中英双语流式模型使用。单线程构建。
- `offline/`：`sherpa-onnx-wasm-simd-1.13.2-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small.tar.bz2` 提取，导出**离线**识别 API（OfflineRecognizer）+ VAD，供 SenseVoice 模型使用。pthread 构建（4 线程池，需 SharedArrayBuffer / crossOriginIsolated）。

两个目录里的 `sherpa-onnx-wasm-main-*.js` 均由 `scripts/fetch-sherpa-wasm.mjs` 打过补丁：
剥掉了 Emscripten `--preload-file` 生成的启动期 `.data` 加载块（官方捆绑包把 fp32 模型编进 .data，
扩展改为运行时按需下载 int8 模型、经 `Module.FS.writeFile` 写入 MEMFS）。

模型文件本身**不在**本目录，首次使用时从 HuggingFace（镜像 hf-mirror.com）下载并缓存于 IndexedDB。

更新运行时：修改 `scripts/fetch-sherpa-wasm.mjs` 里的版本常量后重跑 `node scripts/fetch-sherpa-wasm.mjs`。
