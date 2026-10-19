import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 后端以站点根路径提供静态资源，因此 base 固定为 '/'。
// 开发期把 /api 代理到后端，生产环境同源直连。
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
  },
});
