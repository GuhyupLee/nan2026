export interface ChoiceInputSnapshot {
  heldCodes: readonly string[]
  pointerDown: boolean
}

/**
 * Separates input that was already held when a choice overlay appeared from a
 * deliberate press that started on the overlay. No fixed delay is needed, so
 * a fresh click immediately after releasing movement is still accepted.
 */
export class ChoiceInputGate {
  private readonly blockedCodes: Set<string>
  private waitingForPointerRelease: boolean
  private freshPointerPress = false

  constructor(snapshot?: ChoiceInputSnapshot) {
    this.blockedCodes = new Set(snapshot?.heldCodes ?? [])
    this.waitingForPointerRelease = snapshot?.pointerDown ?? false
  }

  allowsKeyDown(code: string): boolean {
    return !this.blockedCodes.has(code)
  }

  releaseKey(code: string): void {
    this.blockedCodes.delete(code)
  }

  beginPointerPress(): boolean {
    if (this.waitingForPointerRelease) return false
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
