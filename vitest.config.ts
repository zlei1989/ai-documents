import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig 里是 Next 需要的 jsx: preserve；测试要渲染 .tsx 组件，交给 oxc 转换。
  oxc: { jsx: 'react-jsx' },
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    // git 相关的用例在 Windows 上要起多次 git.exe、写临时仓库，5s 默认值不够
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
