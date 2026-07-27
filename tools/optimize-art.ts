/**
 * 아트 최적화 파이프라인.
 *
 * art-src/ 의 생성 원본(PNG, 장당 2MB+)을 public/ 의 웹 산출물(WebP)로 굽는다.
 * 원본은 리포에 넣지 않고(art-src/.gitignore) 산출물만 커밋한다.
 *
 * 재현 가능해야 한다는 점이 중요하다 — AI 활용 문서에서
 * "에셋 생성부터 최적화까지 스크립트 한 줄로 재현된다"고 주장하려면
 * 손으로 만진 흔적이 없어야 한다.
 *
 *   npm run art
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import sharp from 'sharp'

const OUT = 'public/art'

/**
 * 출력 규격.
 *
 * 예산: 첫 로드 10MB / 전체 에셋 50MB.
 * GitHub Pages는 사이트 1GB, 대역폭 100GB/월(소프트)이다. 크기 자체보다
 * 대역폭이 먼저 걸린다 — 50MB면 월 2,000회 로드까지 여유가 있다.
 * 더 직접적인 제약은 심사자의 첫 경험이다. 링크를 누르고 흰 화면을
 * 오래 보면 다음 제출물로 넘어간다.
 *
 * 이 예산 안에서는 화질을 아낄 이유가 없다. hero는 원본 해상도를 유지한다.
 * card = 레벨업/결과 화면용 작은 초상, hero = 캐릭터 선택 화면용.
 */
interface Group {
  src: string
  variants: readonly { suffix: string; height: number; quality: number }[]
}

/**
 * 원본 디렉터리별 출력 규격. 산출물 이름은 `<원본이름>-<suffix>.webp`다.
 *
 * 메인 메뉴 키아트는 원래 이 파이프라인 밖에서 만들어져 `public/art/`에 바로
 * 커밋돼 있었다. 그러면 "생성 원본부터 산출물까지 리포 안에서 재현된다"는
 * AI 활용 문서의 주장에 구멍이 난다. 원본을 `art-src/keyart/`로 들여왔다.
 */
const GROUPS: readonly Group[] = [
  {
    src: 'art-src/portraits',
    variants: [
      { suffix: 'card', height: 640, quality: 86 },
      { suffix: 'hero', height: 1536, quality: 92 },
    ],
  },
  {
    // main-menu.png → main-menu-keyart.webp (src/ui/mainmenu.ts가 참조하는 이름)
    src: 'art-src/keyart',
    variants: [{ suffix: 'keyart', height: 1080, quality: 88 }],
  },
]

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })

  let totalIn = 0
  let totalOut = 0
  let count = 0

  console.log('\n아트 최적화\n')

  for (const g of GROUPS) {
    let files: string[]
    try {
      files = (await readdir(g.src)).filter((f) => extname(f).toLowerCase() === '.png')
    } catch {
      console.error(`원본 디렉터리가 없습니다: ${g.src}`)
      process.exit(1)
    }

    if (files.length === 0) {
      console.error(`${g.src} 에 PNG가 없습니다.`)
      process.exit(1)
    }

    console.log(`  ${g.src}`)
    for (const file of files) {
      const src = join(g.src, file)
      const name = basename(file, extname(file))
      const inSize = (await stat(src)).size
      totalIn += inSize
      count++

      const meta = await sharp(src).metadata()
      console.log(`    ${file}  ${meta.width}x${meta.height}  ${kb(inSize)}`)

      for (const v of g.variants) {
        const dest = join(OUT, `${name}-${v.suffix}.webp`)
        const info = await sharp(src)
          .resize({ height: v.height, withoutEnlargement: true })
          .webp({ quality: v.quality, effort: 6 })
          .toFile(dest)

        totalOut += info.size
        console.log(`      → ${basename(dest)}  ${info.width}x${info.height}  ${kb(info.size)}`)
      }
    }
  }

  console.log(`\n원본 ${count}장`)

  const saved = ((1 - totalOut / totalIn) * 100).toFixed(1)
  console.log(`\n원본 ${kb(totalIn)} → 산출 ${kb(totalOut)}  (${saved}% 감소)\n`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
