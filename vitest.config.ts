import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // core/ 为纯 TypeScript，单测直接落在 tests/unit
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // 核心算法覆盖率门槛 ≥ 80%（规格 M1 验收线）
      include: ['core/**/*.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 80 },
    },
  },
});
