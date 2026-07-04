import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = process.env.VITE_API_TARGET || `http://127.0.0.1:${process.env.PORT || 3001}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    target: ['safari15', 'chrome80', 'firefox80'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/v1': apiTarget,
      '/screenshots': apiTarget,
    },
  },
})
