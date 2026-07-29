import {
  VRM_ACTION_MOTIONS,
  VRM_CLASS_STANCE,
  VRMA_CLIP_ORDER,
} from '../src/render/animation-data.ts'

const contract = {
  clipOrder: VRMA_CLIP_ORDER,
  stances: VRM_CLASS_STANCE,
  actions: Object.fromEntries(
    (['ranged', 'melee'] as const).map((cls) => [
      cls,
      Object.fromEntries(
        Object.entries(VRM_ACTION_MOTIONS[cls]).map(([action, motion]) => [
          action,
          {
            duration: motion.duration,
            phases: motion.keyframes.map(({ stage, time }) => ({ stage, time })),
            keys: motion.keyframes.map(({ stage, time, hipsY, rotations }) => ({
              stage,
              time,
              hipsY,
              rotations,
            })),
          },
        ]),
      ),
    ]),
  ),
}

process.stdout.write(JSON.stringify(contract))
