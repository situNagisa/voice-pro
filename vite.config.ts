import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  // onnxruntime-web 自带 wasm 加载器，交给 Vite 预打包会破坏 wasm 路径。
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  resolve: {
    // 使用外部 wasm 文件，避免把 29 MB 的 jsep wasm 内联进 JS。
    conditions: ['module', 'browser', 'development|production', 'onnxruntime-web-use-extern-wasm'],
  },
  // 多线程 WASM 需要跨源隔离；Capacitor 内没有该头，会自动退化为单线程。
  server: {
    host: '0.0.0.0',
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
})
