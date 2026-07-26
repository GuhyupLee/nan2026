/**
 * 개발용 캡처 수신 서버.
 *
 * 브라우저에서 canvas.toDataURL() 결과를 POST하면 파일로 떨군다.
 * 렌더 결과를 눈으로 확인해야 하는데 스크린샷 경로가 막혀 있을 때 쓴다.
 *
 *   node tools/capture-server.mjs [outDir] [port]
 *
 * 브라우저 쪽:
 *   fetch('http://localhost:5199/shot.jpg', { method:'POST', body: canvas.toDataURL('image/jpeg') })
 *
 * 개발 도구다. 게임 빌드에는 포함되지 않는다.
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const outDir = resolve(process.argv[2] ?? '.')
const port = Number(process.argv[3] ?? 5199)

mkdirSync(outDir, { recursive: true })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, CORS)
    res.end('POST only')
    return
  }

  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    // data:image/jpeg;base64,.... 또는 순수 base64 둘 다 받는다
    const b64 = body.includes(',') ? body.slice(body.indexOf(',') + 1) : body
    // 경로 조작 방지 — 파일명만 취한다
    const name = basename(decodeURIComponent(req.url ?? '/shot.jpg')) || 'shot.jpg'
    const dest = join(outDir, name)
    try {
      const buf = Buffer.from(b64, 'base64')
      writeFileSync(dest, buf)
      console.log(`${new Date().toISOString()}  ${name}  ${buf.length} bytes`)
      res.writeHead(200, CORS)
      res.end(String(buf.length))
    } catch (err) {
      console.error(err)
      res.writeHead(500, CORS)
      res.end('write failed')
    }
  })
}).listen(port, '127.0.0.1', () => {
  console.log(`capture server → ${outDir}  (http://127.0.0.1:${port})`)
})
