import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Two entries. navplan_tester is a standalone page with its own root, deliberately not
  // reachable from the dashboard's footer — it exercises the navplan backend without
  // touching App.jsx or the C2 page. Served at /navplan_tester by ui_backend's
  // express.static `extensions` option.
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        navplan_tester: 'navplan_tester.html',
      },
    },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: ['roslib'],
  },
})
