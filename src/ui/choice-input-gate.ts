export interface ChoiceInputSnapshot {
  heldCodes: readonly string[]
  pointerDown: boolean
  pointerX?: number
  pointerY?: number
}

export const CHOICE_POINTER_GRACE_MS = 180
export const CHOICE_POINTER_MOVE_ARM_DISTANCE = 12

/**
 * Separates input that was already held when a choice overlay appeared from a
 * deliberate press that started on the overlay. A very short pointer-only
 * grace period catches the next click in a rapid combat-click sequence. Moving
 * the pointer toward a choice arms it immediately, while keyboard choices stay
 * available without a delay.
 */
export class ChoiceInputGate {
  private readonly blockedCodes: Set<string>
  private readonly openedAt: number
  private readonly originX: number | null
  private readonly originY: number | null
  private waitingForPointerRelease: boolean
  private pointerMovedTowardChoice = false
  private freshPointerPress = false

  constructor(
    snapshot?: ChoiceInputSnapshot,
    openedAt = globalThis.performance?.now() ?? Date.now(),
  ) {
    this.blockedCodes = new Set(snapshot?.heldCodes ?? [])
    this.waitingForPointerRelease = snapshot?.pointerDown ?? false
    this.openedAt = openedAt
    this.originX = snapshot?.pointerX ?? null
    this.originY = snapshot?.pointerY ?? null
  }

  allowsKeyDown(code: string): boolean {
    return !this.blockedCodes.has(code)
  }

  releaseKey(code: string): void {
    this.blockedCodes.delete(code)
  }

  notePointerMove(clientX: number, clientY: number): void {
    if (this.originX === null || this.originY === null) return
    const distance = Math.hypot(clientX - this.originX, clientY - this.originY)
    if (distance >= CHOICE_POINTER_MOVE_ARM_DISTANCE) {
      this.pointerMovedTowardChoice = true
    }
  }

  beginPointerPress(now = globalThis.performance?.now() ?? Date.now()): boolean {
    if (this.waitingForPointerRelease) return false
    if (
      !this.pointerMovedTowardChoice &&
      now - this.openedAt < CHOICE_POINTER_GRACE_MS
    ) {
      return false
    }
    this.freshPointerPress = true
    return true
  }

  releasePointer(): void {
    this.waitingForPointerRelease = false
  }

  allowsClick(detail: number): boolean {
    if (detail === 0) return true
    const allowed = this.freshPointerPress
    this.freshPointerPress = false
    return allowed
  }
}
