import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: { build: { externalizeDeps: true } },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    server: { host: '127.0.0.1' },
    build: { minify: true },
  },
})
