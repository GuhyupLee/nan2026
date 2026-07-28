import type { PlayerClass } from '../sim/types.ts'
import { getLoadoutBriefingItems } from './loadout-briefing.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function verifyClass(playerClass: PlayerClass): void {
  const items = getLoadoutBriefingItems(playerClass)
  const keys = items.map((item) => item.key).join('')

  assert(items.length === 7, `${playerClass} 브리핑 슬롯이 7개가 아님`)
  assert(keys === 'QWERPDF', `${playerClass} 브리핑 순서가 QWERPDF가 아님: ${keys}`)
  assert(new Set(items.map((item) => item.id)).size === 7, `${playerClass} 브리핑 슬롯이 중복됨`)

  for (const item of items) {
    assert(item.name.trim().length > 0, `${playerClass} ${item.key} 이름이 비어 있음`)
    assert(item.tag.trim().length > 0, `${playerClass} ${item.key} 역할이 비어 있음`)
    assert(item.oneLiner.trim().length > 0, `${playerClass} ${item.key} 설명이 비어 있음`)
    assert(item.icon.trim().length > 0, `${playerClass} ${item.key} 아이콘이 비어 있음`)
  }

  for (const key of ['Q', 'W', 'E'] as const) {
    const item = items.find((entry) => entry.key === key)!
    assert(item.availability === 'level-up', `${playerClass} ${key} 해금 상태가 잘못됨`)
    assert(item.availabilityLabel === '레벨업', `${playerClass} ${key} 해금 문구가 잘못됨`)
  }

  const ultimate = items.find((item) => item.key === 'R')!
  assert(ultimate.availability === 'level-up', `${playerClass} R 해금 상태가 잘못됨`)
  assert(ultimate.availabilityLabel === 'Lv8', `${playerClass} R 해금 문구가 잘못됨`)

  const passive = items.find((item) => item.key === 'P')!
  assert(passive.availability === 'automatic', `${playerClass} P가 자동 패시브로 표시되지 않음`)
  assert(passive.availabilityLabel === '자동', `${playerClass} P 상태 문구가 잘못됨`)

  for (const key of ['D', 'F'] as const) {
    const item = items.find((entry) => entry.key === key)!
    assert(item.availability === 'ready', `${playerClass} ${key}가 즉시 사용으로 표시되지 않음`)
    assert(item.availabilityLabel === '사용 가능', `${playerClass} ${key} 상태 문구가 잘못됨`)
  }
}

verifyClass('ranged')
verifyClass('melee')

const ranged = getLoadoutBriefingItems('ranged')
const melee = getLoadoutBriefingItems('melee')

for (const key of ['Q', 'W', 'E', 'R', 'P'] as const) {
  const rangedItem = ranged.find((item) => item.key === key)!
  const meleeItem = melee.find((item) => item.key === key)!
  assert(rangedItem.name !== meleeItem.name, `${key} 클래스별 이름이 구분되지 않음`)
}

for (const key of ['D', 'F'] as const) {
  const rangedItem = ranged.find((item) => item.key === key)!
  const meleeItem = melee.find((item) => item.key === key)!
  assert(rangedItem.name === meleeItem.name, `${key} 공용 이름이 클래스마다 다름`)
  assert(rangedItem.oneLiner === meleeItem.oneLiner, `${key} 공용 설명이 클래스마다 다름`)
  assert(rangedItem.icon === meleeItem.icon, `${key} 공용 아이콘이 클래스마다 다름`)
}

console.log('start loadout briefing check passed')
