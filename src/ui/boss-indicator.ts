export interface BossIndicatorPosition {
  x: number
  y: number
  angle: number
}

export interface BossIndicatorInsets {
  left: number
  right: number
  top: number
  bottom: number
}

export function bossIndicatorDirection(angle: number): string {
  const normalized = ((angle % 360) + 360) % 360
  const bucket = Math.round(normalized / 45) % 8
  return [
    '오른쪽',
    '오른쪽 아래',
    '아래',
    '왼쪽 아래',
    '왼쪽',
    '왼쪽 위',
    '위',
    '오른쪽 위',
  ][bucket]!
}

/**
 * 투영한 보스 위치를 HUD와 겹치지 않는 화면 가장자리로 옮긴다.
 * null이면 보스가 이미 화면 안이어서 방향 표식이 필요 없다.
 */
export function bossIndicatorPosition(
  screenX: number,
  screenY: number,
  width: number,
  height: number,
  projected = true,
  insets: Partial<BossIndicatorInsets> = {},
): BossIndicatorPosition | null {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  if (
    projected &&
    screenX >= 0 &&
    screenX <= safeWidth &&
    screenY >= 0 &&
    screenY <= safeHeight
  ) {
    return null
  }

  const centerX = safeWidth * 0.5
  const centerY = safeHeight * 0.5
  let dx = screenX - centerX
  let dy = screenY - centerY
  if (!projected) {
    dx = -dx
    dy = -dy
  }
  if (Math.abs(dx) + Math.abs(dy) < 1e-6) dx = 1

  const defaultMarginX = Math.min(76, safeWidth * 0.18)
  const defaultMarginY = Math.min(86, safeHeight * 0.2)
  const minX = Math.min(
    centerX,
    Math.max(0, insets.left ?? defaultMarginX),
  )
  const maxX = Math.max(
    centerX,
    Math.min(safeWidth, safeWidth - (insets.right ?? defaultMarginX)),
  )
  const minY = Math.min(
    centerY,
    Math.max(0, insets.top ?? defaultMarginY),
  )
  const maxY = Math.max(
    centerY,
    Math.min(safeHeight, safeHeight - (insets.bottom ?? defaultMarginY)),
  )
  const horizontalScale =
    dx > 1e-6
      ? (maxX - centerX) / dx
      : dx < -1e-6
        ? (minX - centerX) / dx
        : Number.POSITIVE_INFINITY
  const verticalScale =
    dy > 1e-6
      ? (maxY - centerY) / dy
      : dy < -1e-6
        ? (minY - centerY) / dy
        : Number.POSITIVE_INFINITY
  const scale = Math.min(horizontalScale, verticalScale)
  return {
    x: centerX + dx * scale,
    y: centerY + dy * scale,
    angle: Math.atan2(dy, dx) * (180 / Math.PI),
  }
}
