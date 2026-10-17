import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(dirname),
  base: '/chat/',
  plugins: [vue()],
  define: {
    'globalThis.__EDGECHAT_DEMO__': 'false'
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true
      },
      '/files': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: resolve(dirname, '../../public/chat'),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // 共用摇树后的图标集合，避免每个小图标都产生独立请求。
            { name: 'icons', test: /node_modules[\\/]@lucide[\\/]vue[\\/]/ }
          ]
        }
      }
    }
  }
});
