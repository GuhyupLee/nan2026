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
    // Sites와 GitHub Pages가 함께 쓰는 단일 정적 산출물이다. 과거에는
    // dist 루트를 만든 뒤 dist/client로 다시 복제해 VRM까지 두 벌 배포했다.
    outDir: 'dist/client',
    emptyOutDir: true,
    assetsInlineLimit: 4096,
  },
})
