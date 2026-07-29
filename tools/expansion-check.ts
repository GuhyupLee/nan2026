import assert from 'node:assert/strict'
import { applyUpgrade } from '../src/content/upgrades.ts'
import {
  TYPE_WALKER,
  spawnEnemy,
} from '../src/sim/enemies.ts'
import { upgradeTraitToken } from '../src/sim/progression.ts'
import { SKILL_D } from '../src/sim/skills.ts'
import type { World } from '../src/sim/types.ts'
import { createWorld, stepWorld } from '../src/sim/world.ts'
import { dropXpGem } from '../src/sim/xp-gems.ts'

function input(aimX = 10, aimY = 0, skillsPressed = 0) {
  return {
    move: { x: 0, y: 0 },
    aim: { x: aimX, y: aimY },
    skillsPressed,
  }
}

function addEnemy(
  world: World,
  x: number,
  y: number,
  hp = 100,
): number {
  spawnEnemy(world.enemies, world.rng, 0, 0, TYPE_WALKER, world.time)
  const index = world.enemies.count - 1
  world.enemies.x[index] = x
  world.enemies.y[index] = y
  world.enemies.prevX[index] = x
  world.enemies.prevY[index] = y
  world.enemies.hp[index] = hp
  world.enemies.maxHp[index] = hp
  return index
}

// 간섭 필라멘트 III는 관통 끝의 옆 표적까지 실제로 폭발시킨다.
{
  const world = createWorld(8101, 'ranged')
  world.spawnEnabled = false
  for (let rank = 0; rank < 3; rank += 1) {
    assert.ok(applyUpgrade(world, 'interference-filament'))
  }
  world.stats.atkPierce = 1
  addEnemy(world, 3, 0, 500)
  const side = addEnemy(world, 3, 1.3, 500)
  stepWorld(world, input())
  assert.ok(world.enemies.hp[side]! < 500, '종단 간섭 폭발이 주변 적을 놓침')
}

// 이중 초점은 주 광선 밖의 별도 표적에 보조 피해를 준다.
{
  const world = createWorld(8102, 'ranged')
  world.spawnEnabled = false
  assert.ok(applyUpgrade(world, 'dual-focus'))
  addEnemy(world, 3, 0, 500)
  const auxiliary = addEnemy(world, 3, 0.8, 500)
  stepWorld(world, input())
  assert.ok(world.enemies.hp[auxiliary]! < 500, '보조 광선이 별도 표적을 맞히지 못함')
}

// 참두 일섬 III는 정예가 아닌 빈사 적만 처형한다.
{
  const world = createWorld(8103, 'melee', {
    meta: {
      version: 1,
      maxHpBonus: 0,
      speedMultiplier: 1,
      unlockedUpgradeIds: ['decapitating-flash'],
    },
  })
  world.spawnEnabled = false
  for (let rank = 0; rank < 3; rank += 1) {
    assert.ok(applyUpgrade(world, 'decapitating-flash'))
  }
  const target = addEnemy(world, 2, 0, 100)
  world.enemies.hp[target] = 18
  stepWorld(world, input())
  assert.equal(world.enemies.hp[target], 0, '18% 일반 적 처형이 발동하지 않음')
}

// 수집 계열 각성은 실제 보석 개수를 읽어 가속·연격을 준비한다.
{
  const ranged = createWorld(8104, 'ranged')
  ranged.spawnEnabled = false
  ranged.upgradesTaken.add(upgradeTraitToken('gem-overclock'))
  dropXpGem(ranged.xpGems, 0, 0, 1)
  stepWorld(ranged, input())
  assert.ok(
    ranged.player.pickupHasteUntil > ranged.time,
    '보석 과충전 시간이 설정되지 않음',
  )

  const melee = createWorld(8105, 'melee')
  melee.spawnEnabled = false
  melee.upgradesTaken.add(upgradeTraitToken('gem-double-strike'))
  for (let i = 0; i < 10; i += 1) {
    dropXpGem(melee.xpGems, i * 0.01, 0, 1)
  }
  stepWorld(melee, input())
  assert.equal(melee.player.doubleAttackReady, 1, '보석 10개 연격이 준비되지 않음')
}

// 잔광 과출력과 귀환의 인장은 실전 상태를 바꾼다.
{
  const utility = createWorld(8106, 'ranged')
  utility.spawnEnabled = false
  utility.upgradesTaken.add(upgradeTraitToken('utility-overdrive'))
  stepWorld(utility, input(10, 0, SKILL_D))
  assert.ok(
    utility.player.utilityPowerUntil > utility.time,
    'D 사용 뒤 잔광 과출력이 켜지지 않음',
  )

  const revival = createWorld(8107, 'melee')
  revival.spawnEnabled = false
  revival.player.hp = 0.1
  revival.player.attackCooldown = Number.POSITIVE_INFINITY
  revival.upgradesTaken.add(upgradeTraitToken('revival'))
  addEnemy(revival, 0.1, 0, 500)
  for (
    let tick = 0;
    tick < 120 && !revival.upgradesTaken.has('state:revival:spent');
    tick += 1
  ) {
    stepWorld(revival, input())
  }
  assert.equal(revival.outcome, 'alive', '귀환의 인장이 치명상을 막지 못함')
  assert.ok(revival.player.hp >= revival.stats.maxHp * 0.49)
  assert.ok(revival.player.invulnUntil > revival.time)
  assert.ok(revival.upgradesTaken.has('state:revival:spent'))
  assert.equal(
    revival.battlefieldPickups.bombKills,
    revival.kills,
    '귀환 정화 폭발 처치가 bombKills에 기록되지 않음',
  )
}

console.log(
  'expansion-check: card unlocks, attack branches, pickups, utility overdrive, and revival ok',
)
