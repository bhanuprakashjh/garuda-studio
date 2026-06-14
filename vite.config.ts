import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // GitHub Pages project site: served at https://<user>.github.io/garuda-studio/
  base: '/garuda-studio/',
})
