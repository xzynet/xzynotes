import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.wxt/**',
      '.output/**',
      'web-ext-artifacts/**',
      // public/ 是原样进扩展包的静态资源（含第三方 sherpa-onnx WASM 胶水），不参与 lint
      'public/**',
      // 下载缓存与工具产物
      '.cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // scripts/ 是 Node 构建工具脚本（非扩展运行时代码）
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
);
