import {
  MAIN_MENU_STAGE_ORDER,
  STAGE_CAROUSEL_DRAG_THRESHOLD,
  closestStageIndex,
  isMainMenuStageUnlocked,
  stageIndexForNavigation,
  stageIndexForSwipe,
} from './stage-carousel.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(
  MAIN_MENU_STAGE_ORDER.join(',') === 'normal,hard,fullmoon',
  '스테이지 순서가 보통 → 월식 → 만월이 아님',
)
assert(STAGE_CAROUSEL_DRAG_THRESHOLD >= 6, '탭 오발 방지 임계값이 너무 작음')

assert(
  isMainMenuStageUnlocked('normal', { hard: false, fullmoon: false }),
  '보통 스테이지는 항상 열려 있어야 함',
)
assert(
  !isMainMenuStageUnlocked('hard', { hard: false, fullmoon: true }),
  '월식 잠금 상태가 무시됨',
)
assert(
  isMainMenuStageUnlocked('fullmoon', { hard: true, fullmoon: true }),
  '만월 해금 상태가 반영되지 않음',
)

assert(
  closestStageIndex([120, 360, 600], 385) === 1,
  '캐러셀 중앙에 가장 가까운 카드가 선택되지 않음',
)
assert(
  closestStageIndex([120, 360, 600], 590) === 2,
  '마지막 카드 중앙 판정이 잘못됨',
)
assert(closestStageIndex([], 0) === 0, '빈 캐러셀의 안전 인덱스가 잘못됨')

assert(
  stageIndexForNavigation('ArrowRight', 0, 3) === 1,
  '오른쪽 방향키 이동이 잘못됨',
)
assert(
  stageIndexForNavigation('ArrowRight', 2, 3) === 2,
  '마지막 스테이지에서 범위를 벗어남',
)
assert(
  stageIndexForNavigation('ArrowLeft', 0, 3) === 0,
  '첫 스테이지에서 범위를 벗어남',
)
assert(
  stageIndexForNavigation('Home', 2, 3) === 0,
  'Home 키 이동이 잘못됨',
)
assert(
  stageIndexForNavigation('End', 0, 3) === 2,
  'End 키 이동이 잘못됨',
)
assert(
  stageIndexForNavigation('Enter', 1, 3) === null,
  '실행 키가 탐색 키로 처리됨',
)
assert(
  stageIndexForSwipe(-64, 480, 0, 3) === 1,
  '왼쪽 스와이프가 다음 스테이지로 이동하지 않음',
)
assert(
  stageIndexForSwipe(64, 480, 2, 3) === 1,
  '오른쪽 스와이프가 이전 스테이지로 이동하지 않음',
)
assert(
  stageIndexForSwipe(-20, 480, 0, 3) === null,
  '짧은 드래그가 스와이프로 오인됨',
)
assert(
  stageIndexForSwipe(-80, 480, 2, 3) === 2,
  '마지막 스테이지를 넘어감',
)

console.log('stage carousel check passed')
