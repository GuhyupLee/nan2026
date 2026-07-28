export const ADAPTIVE_QUALITY_DEFAULTS = Object.freeze({
  initialFrameSeconds: 1 / 60,
  emaHalfLifeSeconds: 0.75,
  warmupSeconds: 3,
  slowFrameSeconds: 1 / 42,
  recoveryFrameSeconds: 1 / 50,
  sustainSeconds: 4,
  stallFrameSeconds: 0.25,
})

type AdaptiveQualityOptions = Readonly<typeof ADAPTIVE_QUALITY_DEFAULTS>

/**
 * Render-only performance policy. It deliberately has no simulation inputs and
 * makes a single high -> low transition for the lifetime of a Renderer.
 */
export class AdaptiveQualityPolicy {
  private emaSeconds: number
  private observedSeconds = 0
  private slowSeconds = 0
  private lowQuality = false

  constructor(
    private readonly options: AdaptiveQualityOptions = ADAPTIVE_QUALITY_DEFAULTS,
  ) {
    this.emaSeconds = options.initialFrameSeconds
  }

  /**
   * Adds one requestAnimationFrame interval.
   *
   * Returns true exactly once, when the renderer should apply its constrained
   * tier. Long gaps reset the observation window so returning to a foreground
   * tab cannot be mistaken for sustained GPU pressure.
   */
  observe(frameSeconds: number): boolean {
    if (this.lowQuality || !Number.isFinite(frameSeconds) || frameSeconds <= 0) {
      return false
    }

    if (frameSeconds >= this.options.stallFrameSeconds) {
      this.resetObservation()
      return false
    }

    const blend =
      1 -
      Math.exp(
        (-Math.LN2 * frameSeconds) / this.options.emaHalfLifeSeconds,
      )
    this.emaSeconds += (frameSeconds - this.emaSeconds) * blend
    this.observedSeconds += frameSeconds

    if (this.observedSeconds < this.options.warmupSeconds) {
      this.slowSeconds = 0
      return false
    }

    if (this.emaSeconds >= this.options.slowFrameSeconds) {
      this.slowSeconds += frameSeconds
    } else if (this.emaSeconds <= this.options.recoveryFrameSeconds) {
      this.slowSeconds = 0
    }

    if (this.slowSeconds < this.options.sustainSeconds) return false

    this.lowQuality = true
    return true
  }

  get downgraded(): boolean {
    return this.lowQuality
  }

  get emaFrameSeconds(): number {
    return this.emaSeconds
  }

  /** Clears only pre-downgrade evidence; the one-way tier decision is retained. */
  resetObservation(): void {
    this.emaSeconds = this.options.initialFrameSeconds
    this.observedSeconds = 0
    this.slowSeconds = 0
  }
}
