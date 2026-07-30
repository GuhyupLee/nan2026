import {
  ATK_DAMAGE,
  ATK_INTERVAL,
  ATK_PIERCE,
  ATK_RANGE,
  FLASH_COOLDOWN,
  FLASH_RANGE,
  HEAL_AMOUNT,
  HEAL_BOOST_TIME,
  HEAL_COOLDOWN,
  HEAL_SPEED_BOOST,
  KILL_HEAL_CAP,
  KILL_HEAL_RATE,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  PLAYER_SPEED,
} from './constants.ts'
import type { PlayerClass, RunMetaSnapshot } from './types.ts'

/** Lumen's small baseline mobility buffer before account/meta multipliers. */
export const RANGED_BASE_SPEED_MULTIPLIER = 1.03

/**
 * 런타임 튜닝 상태 — 강화 카드가 건드리는 단일 진실 원천.
 *
 * constants.ts의 값들은 전부 `export const`라 강화가 수정할 대상이 없다.
 * 그래서 상수는 "초기값 테이블"로 격하하고, 실제 게임은 이 객체만 읽는다.
 *
 * 이걸 스킬을 다 짠 뒤에 도입하면 상수를 import한 모든 스킬 코드를 함께
 * 고쳐야 하는 전면 리팩터가 된다. 그래서 스킬보다 먼저 넣는다.
 *
 * 클래스 차이도 여기서 갈린다. 지금까지 playerClass는 필드로 저장만 되고
 * 실제 스탯에 아무 반영도 되지 않았다.
 */
export interface Stats {
  // --- 플레이어 기본 ---
  maxHp: number
  speed: number
  radius: number
  /** 받는 피해 배수. 근접 클래스가 낮다. */
  damageTakenMul: number

  // --- 자동 공격 ---
  atkDamage: number
  atkInterval: number
  atkRange: number
  atkPierce: number
  /** 평타에만 적용되는 피해 배수. QWER 피해와 분리한다. */
  basicAttackDamageMul: number
  /** XP 보석과 전장 아이템의 획득 반경 배수. */
  pickupRadiusMul: number
  /** 적과 보석에서 얻는 XP 배수. 영구 전승과 런 강화가 함께 곱해진다. */
  xpGainMul: number
  /** 회복 구슬의 회복량 배수. */
  battlefieldHealMul: number
  /** 처치 회복 토큰 버킷의 최대치와 초당 회복량. */
  killHealCap: number
  killHealRate: number
  /**
   * 점등된 적에게 평타가 주는 추가 피해.
   *
   * 원거리 패시브 「점등」의 전부다 — 스킬이 평타를 강화하는 순환이
   * 이 값 하나로 성립한다. 평타가 자동이라 순환이 저절로 돈다.
   * 근접은 순환 방향이 반대(평타가 스킬을 강화)라 값이 작다.
   */
  markBonus: number
  /**
   * 점등된 적을 처치할 때 회복하는 양.
   *
   * 실측이 구조적 비대칭을 드러내서 넣었다. 근접은 「월참」과 궁극기로
   * 회복하지만 원거리는 D(45초 쿨)뿐이라 보스 전에 전멸했다.
   * 원거리의 회복은 정체성에 붙인다 — 빛을 머금은 적이 죽으면 그 빛이 돌아온다.
   */
  markKillHeal: number

  // --- 전역 배수. 강화 카드가 곱해서 쌓는다 ---
  cooldownMul: number
  atkDamageMul: number
  atkIntervalMul: number

  // --- 소환사 주문 ---
  flashCooldown: number
  flashRange: number
  healAmount: number
  healCooldown: number
  healSpeedBoost: number
  healBoostTime: number
}

/**
 * 클래스별 초기 스탯.
 *
 * 원딜(루멘)의 수치는 헤드리스 실측으로 XP 곡선을 맞춰둔 값이라 건드리지 않는다.
 * 근딜(월아)은 그 대비로 잡았다 — 사거리를 3.2로 잘라 반드시 파고들게 만들고,
 * 대신 체력과 피해 감소로 버티게 한다. 위치 게임이 정반대여야 클래스 선택에
 * 의미가 생긴다.
 *
 * 근딜 실효 체력 = 130 / 0.80 ≈ 163, 원딜은 125 / 0.95 ≈ 132다.
 * 루멘은 광도약의 명시적인 방향 선택으로 피해를 피하고, 월아는 붙은 채
 * 받아내므로 기본 내구 차이도 클래스 선택에서 읽히게 둔다.
 * 근딜 단일 대상 DPS = 22 / 0.42 ≈ 52. 원딜 46보다 높지만 붙어야만 나온다.
 */
export function createStats(
  cls: PlayerClass,
  meta?: RunMetaSnapshot,
): Stats {
  const melee = cls === 'melee'
  const maxHpBonus = Math.max(0, Math.min(30, meta?.maxHpBonus ?? 0))
  const speedMultiplier = Math.max(
    1,
    Math.min(1.12, meta?.speedMultiplier ?? 1),
  )
  const damageMultiplier = Math.max(
    1,
    Math.min(1.2, meta?.damageMultiplier ?? 1),
  )
  const cooldownMultiplier = Math.max(
    0.9,
    Math.min(1, meta?.cooldownMultiplier ?? 1),
  )
  const damageTakenMultiplier = Math.max(
    0.88,
    Math.min(1, meta?.damageTakenMultiplier ?? 1),
  )
  const pickupRadiusMultiplier = Math.max(
    1,
    Math.min(1.5, meta?.pickupRadiusMultiplier ?? 1),
  )
  const healingMultiplier = Math.max(
    1,
    Math.min(1.5, meta?.healingMultiplier ?? 1),
  )
  const xpMultiplier = Math.max(1, Math.min(1.25, meta?.xpMultiplier ?? 1))
  return {
    // 체력·피해 감소와 요구 포지션을 묶어 클래스 정체성을 만든다.
    //
    // 러셔가 플레이어보다 빨라 "안 맞으면 된다"가 공짜는 아니지만,
    // 원거리도 군중을 상대할 생존 여유가 필요해 기본 체력 격차는 작게 둔다.
    // 근접은 더 높은 피해 감소와 회복으로 붙어서 버티고, 원거리는 거리와
    // 점등 처치 회복으로 위험을 관리한다.
    maxHp: (melee ? 130 : PLAYER_MAX_HP) + maxHpBonus,
    speed:
      (melee ? 10.5 : PLAYER_SPEED * RANGED_BASE_SPEED_MULTIPLIER) *
      speedMultiplier,
    radius: melee ? 0.62 : PLAYER_RADIUS,
    // 근접은 붙어 있는 것이 일이라 실제로 맞는 시간이 원거리보다 길다.
    // 원거리는 광도약 방향을 직접 골라 회피하므로, 내구는 월아보다 분명히
    // 낮춰 이동기를 잘못 썼을 때의 위험도 남긴다.
    damageTakenMul: (melee ? 0.8 : 0.95) * damageTakenMultiplier,

    atkDamage: melee ? 22 : ATK_DAMAGE,
    atkInterval: melee ? 0.42 : ATK_INTERVAL,
    atkRange: melee ? 3.2 : ATK_RANGE,
    atkPierce: melee ? 2 : ATK_PIERCE,
    basicAttackDamageMul: 1,
    pickupRadiusMul: pickupRadiusMultiplier,
    xpGainMul: xpMultiplier,
    battlefieldHealMul: healingMultiplier,
    killHealCap: KILL_HEAL_CAP * healingMultiplier,
    killHealRate: KILL_HEAL_RATE * healingMultiplier,
    // 원거리는 점등 시 13 → 30 (약 2.3배). 스킬 하나만 맞춰두면 평타가 배 이상 아프다.
    markBonus: melee ? 5 : 17,
    markKillHeal: melee ? 0 : 4,

    cooldownMul: cooldownMultiplier,
    // 확장된 카드 풀에서도 원거리의 생존은 사거리와 선제 제거에서 나온다.
    // 방어력을 올려 위험 구간을 지우지 않고 작은 화력 보정만 준다.
    atkDamageMul: (melee ? 1 : 1.03) * damageMultiplier,
    atkIntervalMul: 1,

    flashCooldown: FLASH_COOLDOWN * cooldownMultiplier,
    flashRange: FLASH_RANGE,
    healAmount: HEAL_AMOUNT * healingMultiplier,
    healCooldown: HEAL_COOLDOWN * cooldownMultiplier,
    healSpeedBoost: HEAL_SPEED_BOOST,
    healBoostTime: HEAL_BOOST_TIME,
  }
}

/** 배수까지 적용한 실효 공격력. */
export function effectiveAtkDamage(s: Stats): number {
  return s.atkDamage * s.atkDamageMul
}

/** 평타 전용 증폭까지 반영한 실효 공격력. */
export function effectiveBasicAttackDamage(s: Stats): number {
  return effectiveAtkDamage(s) * s.basicAttackDamageMul
}

/**
 * 배수까지 적용한 실효 공격 간격.
 * 하한을 두지 않으면 강화를 겹쳤을 때 매 틱 발사가 되어 프레임이 죽는다.
 */
export function effectiveAtkInterval(s: Stats): number {
  return Math.max(0.06, s.atkInterval * s.atkIntervalMul)
}
