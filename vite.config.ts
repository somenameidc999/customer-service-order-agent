import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Disable SPA fallback. Only / is a frontend page.
  appType: 'mpa',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.PORT ?? 8787}`,
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
})
