import { defineConfig } from 'vite'

// base: './' — 상대 경로로 빌드해야 GitHub Pages 프로젝트 사이트(/repo/)와
// itch.io zip 업로드 양쪽에서 동일한 산출물이 그대로 동작한다.
export default defineConfig({
  base: './',
  // @pixiv/three-vrm이 three를 peer로 잡는데, dev 사전 번들링에서 앱과 다른
  // 사본으로 갈라져 "Multiple instances of Three.js" 경고가 났다. 사본이 둘이면
  // instanceof 검사가 어긋나 로더 플러그인이 조용히 실패할 수 있다.
  resolve: { dedupe: ['three'] },
  optimizeDeps: { include: ['three', '@pixiv/three-vrm'] },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 4096,
  },
})
