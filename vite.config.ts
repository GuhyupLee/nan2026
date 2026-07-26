import { defineConfig } from 'vite'

// base: './' — 상대 경로로 빌드해야 GitHub Pages 프로젝트 사이트(/repo/)와
// itch.io zip 업로드 양쪽에서 동일한 산출물이 그대로 동작한다.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 4096,
  },
})
