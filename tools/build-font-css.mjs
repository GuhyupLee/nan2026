/**
 * 게임에 실제로 등장하는 글자만 동적 서브셋 CSS에 남긴다.
 *
 * 두 폰트 패키지의 기본 CSS를 그대로 import하면 브라우저는 필요한 조각만
 * 내려받지만 Vite 산출물에는 200개가 넘는 WOFF2가 모두 복사된다. 소스의
 * 사용자 노출 문자열을 기준으로 필요한 unicode-range만 골라 같은 런타임
 * 동작을 유지하면서 배포 용량을 줄인다.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)))
const outputFile = join(projectDir, 'src', 'ui', 'fonts.generated.css')

const pretendardCss = join(
  projectDir,
  'node_modules',
  'pretendard',
  'dist',
  'web',
  'variable',
  'pretendardvariable-dynamic-subset.css',
)
const notoSerifCss = join(
  projectDir,
  'node_modules',
  '@fontsource-variable',
  'noto-serif-kr',
  'index.css',
)

async function walk(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else files.push(path)
  }
  return files
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

async function collectCodePoints(files) {
  const codePoints = new Set()
  for (const file of files) {
    const source = stripComments(await readFile(file, 'utf8'))
    for (const character of source) {
      if (!/\s/u.test(character)) codePoints.add(character.codePointAt(0))
    }
  }
  // UI에서 런타임으로 조합되는 숫자·시간·점수까지 항상 보장한다.
  for (let codePoint = 0x20; codePoint <= 0x7e; codePoint += 1) {
    codePoints.add(codePoint)
  }
  return codePoints
}

function rangeContains(range, codePoint) {
  const normalized = range.trim().replace(/^U\+/i, '')
  if (normalized.includes('?')) {
    const start = Number.parseInt(normalized.replace(/\?/g, '0'), 16)
    const end = Number.parseInt(normalized.replace(/\?/g, 'f'), 16)
    return codePoint >= start && codePoint <= end
  }
  const [startRaw, endRaw = startRaw] = normalized.split('-')
  const start = Number.parseInt(startRaw, 16)
  const end = Number.parseInt(endRaw, 16)
  return codePoint >= start && codePoint <= end
}

function blockMatches(block, codePoints) {
  const match = block.match(/unicode-range:\s*([^;]+);/i)
  if (!match) return true
  const ranges = match[1].split(',')
  for (const codePoint of codePoints) {
    if (ranges.some((range) => rangeContains(range, codePoint))) return true
  }
  return false
}

function selectFontFaces(source, codePoints, rewriteUrl) {
  const blocks = source.match(
    /(?:\/\*[\s\S]*?\*\/\s*)?@font-face\s*\{[\s\S]*?\n\}/g,
  ) ?? []
  return blocks
    .filter((block) => blockMatches(block, codePoints))
    .map((block) => rewriteUrl(block).trim())
}

const sourceFiles = [
  join(projectDir, 'index.html'),
  ...(await walk(join(projectDir, 'src'))).filter((file) => {
    const extension = extname(file)
    return (
      (extension === '.ts' || extension === '.css') &&
      file !== outputFile
    )
  }),
]
const serifSourceFiles = [
  join(projectDir, 'index.html'),
  join(projectDir, 'src', 'ui', 'mainmenu.ts'),
  join(projectDir, 'src', 'ui', 'charselect.ts'),
  join(projectDir, 'src', 'ui', 'ui.css'),
]

const sansCodePoints = await collectCodePoints(sourceFiles)
const serifCodePoints = await collectCodePoints(serifSourceFiles)

const pretendardFaces = selectFontFaces(
  await readFile(pretendardCss, 'utf8'),
  sansCodePoints,
  (block) => block.replaceAll(
    'url(./woff2-dynamic-subset/',
    'url(../../node_modules/pretendard/dist/web/variable/woff2-dynamic-subset/',
  ),
)
const notoSerifFaces = selectFontFaces(
  await readFile(notoSerifCss, 'utf8'),
  serifCodePoints,
  (block) => block.replaceAll(
    'url(./files/',
    'url(../../node_modules/@fontsource-variable/noto-serif-kr/files/',
  ),
)

const output = `/* 이 파일은 tools/build-font-css.mjs가 생성합니다. 직접 수정하지 마세요.
 * Pretendard © Kil Hyung-jin, Noto Serif KR © Google. 두 폰트 모두 OFL-1.1.
 */

${pretendardFaces.join('\n\n')}

${notoSerifFaces.join('\n\n')}
`

await mkdir(dirname(outputFile), { recursive: true })
await writeFile(outputFile, output, 'utf8')

console.log(
  `font subsets: Pretendard ${pretendardFaces.length}, ` +
  `Noto Serif KR ${notoSerifFaces.length} → ${relative(projectDir, outputFile)}`,
)
