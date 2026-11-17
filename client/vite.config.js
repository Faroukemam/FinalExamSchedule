import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import serverConfig from '../server/config.js'

const apiTarget = `http://127.0.0.1:${serverConfig.PORT}`

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true
      },
      '/uploads': {
        target: apiTarget,
        changeOrigin: true
      }
    }
  }
})
