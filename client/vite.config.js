import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')

  return {
    plugins: [react()],
    build: {
      target: ['safari15', 'chrome80', 'firefox80'],
    },
    server: {
      host: env.VITE_HOST || '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': { target: 'http://localhost:3001', changeOrigin: false },
        '/v1': { target: 'http://localhost:3001', changeOrigin: false },
        '/screenshots': { target: 'http://localhost:3001', changeOrigin: false },
      },
    },
  }
})
