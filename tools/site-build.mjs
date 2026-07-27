import { copyFile, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)))
const distDir = join(projectDir, 'dist')
const clientDir = join(distDir, 'client')
const serverDir = join(distDir, 'server')

// Vite의 정적 산출물을 그대로 유지하면서 Sites가 기대하는 client 디렉터리에도 복제한다.
// GitHub Pages·itch.io용 dist 루트와 Sites용 산출물을 한 번의 빌드로 함께 만든다.
await rm(clientDir, { recursive: true, force: true })
await mkdir(clientDir, { recursive: true })

for (const entry of await readdir(distDir, { withFileTypes: true })) {
  if (entry.name === 'client' || entry.name === 'server' || entry.name === '.openai') continue
  await cp(join(distDir, entry.name), join(clientDir, entry.name), { recursive: true })
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
