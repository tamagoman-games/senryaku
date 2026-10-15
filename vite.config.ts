import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// PORT: フロントエンドのポート / API_PORT: server.ts(APIサーバー)のポート
const port = Number(process.env.PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 8080);

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
    // 協力プレイ用: /api をAPIサーバーへ転送
    proxy: { '/api': `http://localhost:${apiPort}` },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: { '/api': `http://localhost:${apiPort}` },
  },
});
