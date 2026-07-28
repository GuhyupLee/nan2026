import { access, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)))
const distDir = join(projectDir, 'dist')
const clientDir = join(distDir, 'client')
const serverDir = join(distDir, 'server')

// Vite가 처음부터 dist/client에 쓴다. 이전 빌드가 루트에 남긴 대형 에셋만
// 제거하고 정적 산출물은 복제하지 않는다.
await access(join(clientDir, 'index.html'))
for (const entry of await readdir(distDir, { withFileTypes: true })) {
  if (entry.name === 'client') continue
  await rm(join(distDir, entry.name), { recursive: true, force: true })
}

await mkdir(serverDir, { recursive: true })
await writeFile(
  join(serverDir, 'index.js'),
  `const worker = {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request)
    if (response.status !== 404 || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return response
    }

    const fallbackUrl = new URL('/index.html', request.url)
    return env.ASSETS.fetch(new Request(fallbackUrl, request))
  },
}

export default worker
`,
  'utf8',
)

// 로컬 산출물도 독립 검증할 수 있게 호스팅 메타데이터를 포함한다.
const hostingSource = join(projectDir, '.openai', 'hosting.json')
const hostingOutput = join(distDir, '.openai', 'hosting.json')
await mkdir(dirname(hostingOutput), { recursive: true })
await copyFile(hostingSource, hostingOutput)
