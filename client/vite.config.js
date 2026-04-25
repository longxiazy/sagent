import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
      '/api': 'http://localhost:3001',
      '/v1': 'http://localhost:3001',
      '/screenshots': 'http://localhost:3001',
    },
  },
})
