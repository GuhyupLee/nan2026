#!/usr/bin/env node
/**
 * 직렬화된 Blender 실행기.
 *
 * Blender를 `--background`로 돌리면 프로세스는 여러 개 뜰 수 있지만, 이 저장소의
 * 에셋 스크립트는 Cycles 베이크를 쓴다. 베이크는 코어를 전부 먹고 GPU 큐를
 * 독점하므로 두 개가 겹치면 각자 느려지기만 한다. 게다가 하위 에이전트가
 * 병렬로 자기 에셋을 반복 수정하면 실행이 겹치는 게 기본값이 된다.
 *
 * 그래서 **스크립트 작성은 병렬, 실행은 직렬**로 나눈다. 이 러너가 그 경계다.
 * 락 디렉터리 하나로 뮤텍스를 만들고, 대기자는 FIFO 티켓 순서로 들어간다.
 *
 * 사용:
 *   node tools/blender/run.mjs art-src/blender/assets/gatehouse.py [-- extra args]
 *   node tools/blender/run.mjs --all            # assets/ 전체를 순서대로
 *   node tools/blender/run.mjs --status         # 큐 상태만 출력
 *
 * 환경 변수:
 *   BLENDER_EXE   Blender 실행 파일 경로 (미지정 시 알려진 경로를 탐색)
 *   BLENDER_LOCK_TIMEOUT_MS  락 대기 상한(기본 45분)
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const LOCK_DIR = join(ROOT, '.blender-lock')
const QUEUE_DIR = join(ROOT, '.blender-queue')
const LOG_DIR = join(ROOT, 'art-src', 'blender', 'logs')

/** 락 소유자가 죽었다고 판단하는 시간. 베이크가 오래 걸려 넉넉히 잡는다. */
const STALE_LOCK_MS = 40 * 60 * 1000
const LOCK_TIMEOUT_MS = Number(process.env.BLENDER_LOCK_TIMEOUT_MS ?? 45 * 60 * 1000)
const POLL_MS = 900

const CANDIDATE_EXES = [
  process.env.BLENDER_EXE,
  'E:/Steam/steamapps/common/Blender/blender.exe',
  'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
  'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe',
  '/usr/bin/blender',
  '/usr/local/bin/blender',
  '/Applications/Blender.app/Contents/MacOS/Blender',
].filter(Boolean)

function findBlender() {
  for (const candidate of CANDIDATE_EXES) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'Blender 실행 파일을 찾지 못했다. BLENDER_EXE 환경 변수로 경로를 지정하라.\n' +
      `탐색한 경로:\n  ${CANDIDATE_EXES.join('\n  ')}`,
  )
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM은 "다른 사용자 소유지만 살아 있다"는 뜻이다.
    return error?.code === 'EPERM'
  }
}

function readLockOwner() {
  try {
    return JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8'))
  } catch {
    return null
  }
}

function lockAgeMs() {
  try {
    return Date.now() - statSync(LOCK_DIR).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 죽은 소유자가 남긴 락만 제거한다.
 *
 * mtime만 보고 지우면 40분 넘게 도는 정상 베이크를 남이 끊어 먹는다. pid가
 * 살아 있으면 아무리 오래돼도 손대지 않는다.
 */
function clearStaleLock() {
  if (!existsSync(LOCK_DIR)) return false
  const owner = readLockOwner()
  const alive = owner ? isAlive(owner.pid) : false
  if (alive) return false
  if (owner && lockAgeMs() < STALE_LOCK_MS) return false
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true })
    process.stderr.write(
      `[blender-queue] 죽은 락을 정리했다 (owner=${owner?.pid ?? 'unknown'})\n`,
    )
    return true
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** FIFO 티켓. 먼저 줄을 선 요청이 먼저 Blender를 잡는다. */
function takeTicket(label) {
  mkdirSync(QUEUE_DIR, { recursive: true })
  const id = `${Date.now().toString(36)}-${process.pid}-${(
    process.hrtime.bigint() % 100000n
  ).toString(36)}`
  const path = join(QUEUE_DIR, `${id}.json`)
  writeFileSync(path, JSON.stringify({ id, pid: process.pid, label, at: Date.now() }))
  return { id, path }
}

function releaseTicket(ticket) {
  try {
    rmSync(ticket.path, { force: true })
  } catch {
    /* 티켓 정리 실패는 다음 청소에서 회수된다. */
  }
}

function queueAhead(ticket) {
  let entries
  try {
    entries = readdirSync(QUEUE_DIR).filter((n) => n.endsWith('.json'))
  } catch {
    return 0
  }
  const rows = []
  for (const name of entries) {
    try {
      const row = JSON.parse(readFileSync(join(QUEUE_DIR, name), 'utf8'))
      // 죽은 대기자의 티켓은 줄에서 빼야 뒤가 영원히 막히지 않는다.
      if (row.pid !== process.pid && !isAlive(row.pid)) {
        rmSync(join(QUEUE_DIR, name), { force: true })
        continue
      }
      rows.push(row)
    } catch {
      /* 쓰는 도중 읽었을 수 있다. 다음 폴에서 다시 본다. */
    }
  }
  rows.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  const index = rows.findIndex((row) => row.id === ticket.id)
  return index < 0 ? 0 : index
}

async function acquireLock(label) {
  const ticket = takeTicket(label)
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let announced = -1
  try {
    while (Date.now() < deadline) {
      clearStaleLock()
      const ahead = queueAhead(ticket)
      if (ahead === 0) {
        try {
          mkdirSync(LOCK_DIR, { recursive: false })
          writeFileSync(
            join(LOCK_DIR, 'owner.json'),
            JSON.stringify({ pid: process.pid, label, at: Date.now() }),
          )
          return () => {
            releaseTicket(ticket)
            try {
              rmSync(LOCK_DIR, { recursive: true, force: true })
            } catch {
              /* 이미 정리됐다. */
            }
          }
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
      }
      if (ahead !== announced) {
        announced = ahead
        const owner = readLockOwner()
        process.stderr.write(
          `[blender-queue] 대기 중: ${label} — 앞 ${ahead}건` +
            (owner ? `, 현재 실행 ${owner.label ?? owner.pid}` : '') +
            '\n',
        )
      }
      await sleep(POLL_MS)
    }
    throw new Error(
      `[blender-queue] 락 대기 시간 초과(${Math.round(LOCK_TIMEOUT_MS / 1000)}초): ${label}`,
    )
  } catch (error) {
    releaseTicket(ticket)
    throw error
  }
}

function runBlender(exe, scriptPath, scriptArgs) {
  return new Promise((resolvePromise) => {
    const args = [
      '--background',
      // factory-startup으로 사용자 설정·애드온 상태와 무관하게 재현 가능하게 만든다.
      '--factory-startup',
      '--enable-autoexec',
      '--python-exit-code',
      '73',
      '--python',
      scriptPath,
    ]
    if (scriptArgs.length > 0) args.push('--', ...scriptArgs)

    const child = spawn(exe, args, {
      cwd: ROOT,
      env: { ...process.env, MW_PROJECT_ROOT: ROOT, PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      out += text
      process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      out += text
      process.stderr.write(text)
    })
    child.on('error', (error) => resolvePromise({ code: 1, out: `${out}\n${error.message}` }))
    child.on('close', (code) => resolvePromise({ code: code ?? 1, out }))
  })
}

function listAssetScripts() {
  const dir = join(ROOT, 'art-src', 'blender', 'assets')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.py') && !name.startsWith('_'))
    .sort()
    .map((name) => join(dir, name))
}

function writeLog(scriptPath, out, code) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const stem = relative(ROOT, scriptPath).replace(/[\\/]/g, '__').replace(/\.py$/, '')
    writeFileSync(join(LOG_DIR, `${stem}.log`), `exit=${code}\n\n${out}`)
  } catch {
    /* 로그 실패로 빌드를 막지 않는다. */
  }
}

async function main() {
  const argv = process.argv.slice(2)

  if (argv.includes('--status')) {
    const owner = readLockOwner()
    const waiting = existsSync(QUEUE_DIR)
      ? readdirSync(QUEUE_DIR).filter((n) => n.endsWith('.json')).length
      : 0
    process.stdout.write(
      `blender: ${findBlender()}\n` +
        `lock: ${owner ? `${owner.label} (pid ${owner.pid}, ${Math.round(lockAgeMs() / 1000)}s)` : 'free'}\n` +
        `queued: ${waiting}\n`,
    )
    return 0
  }

  const separator = argv.indexOf('--')
  const scriptArgs = separator >= 0 ? argv.slice(separator + 1) : []
  const head = separator >= 0 ? argv.slice(0, separator) : argv

  const scripts = head.includes('--all')
    ? listAssetScripts()
    : head.filter((a) => !a.startsWith('--')).map((a) => resolve(ROOT, a))

  if (scripts.length === 0) {
    process.stderr.write('실행할 스크립트가 없다. 경로 또는 --all을 지정하라.\n')
    return 2
  }

  const exe = findBlender()
  let failures = 0

  for (const scriptPath of scripts) {
    if (!existsSync(scriptPath)) {
      process.stderr.write(`[blender-queue] 없음: ${scriptPath}\n`)
      failures++
      continue
    }
    const label = relative(ROOT, scriptPath)
    const release = await acquireLock(label)
    const startedAt = Date.now()
    process.stderr.write(`[blender-queue] 실행: ${label}\n`)
    try {
      const { code, out } = await runBlender(exe, scriptPath, scriptArgs)
      writeLog(scriptPath, out, code)
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      if (code !== 0) {
        failures++
        process.stderr.write(`[blender-queue] 실패(${code}) ${label} — ${seconds}s\n`)
      } else {
        process.stderr.write(`[blender-queue] 완료 ${label} — ${seconds}s\n`)
      }
    } finally {
      release()
    }
  }

  return failures === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exit(1)
  },
)
