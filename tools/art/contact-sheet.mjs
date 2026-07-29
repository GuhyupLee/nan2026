import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

const [, , dir, outPath, ...sets] = process.argv
const S = 300
const maps = ['basecolor', 'normal', 'orm']
const rows = []
for (const s of sets) {
  const cells = []
  for (const m of maps) {
    cells.push(await sharp(`${dir}/${s}_${m}.png`).resize(S, S).toBuffer())
  }
  rows.push(
    await sharp({ create: { width: S * 3, height: S, channels: 3, background: '#101010' } })
      .composite(cells.map((b, i) => ({ input: b, left: i * S, top: 0 })))
      .png()
      .toBuffer(),
  )
}
await sharp({
  create: { width: S * 3, height: S * sets.length, channels: 3, background: '#101010' },
})
  .composite(rows.map((b, i) => ({ input: b, left: 0, top: i * S })))
  .jpeg({ quality: 90 })
  .toFile(outPath)
console.log('wrote', outPath, sets.join(', '))
