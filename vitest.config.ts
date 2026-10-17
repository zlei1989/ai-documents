import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig 里是 Next 需要的 jsx: preserve；测试要渲染 .tsx 组件，交给 oxc 转换。
  oxc: { jsx: 'react-jsx' },
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
  },
});
