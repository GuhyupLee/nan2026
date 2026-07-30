/**
 * Environment streaming is authored around the 16:9 combat view. Wider
 * displays keep that baseline and preload only the extra ground footprint
 * exposed at the left and right edges.
 */
export const CAMERA_REFERENCE_ASPECT = 16 / 9
export const BASE_SCATTER_GATHER_RADIUS = 24
export const MAX_SCATTER_GATHER_RADIUS = 48

export const CAMERA_FOV_DEGREES = 40
export const CAMERA_HEIGHT = 14
export const CAMERA_DEPTH = 10.8

function projectedGroundRadius(
  aspect: number,
  distanceScale: number,
): number {
  const safeAspect = Math.min(8, Math.max(0.5, aspect))
  const safeScale = Math.max(0.01, distanceScale)
  const cameraY = CAMERA_HEIGHT * safeScale
  const cameraZ = CAMERA_DEPTH * safeScale
  const cameraLength = Math.hypot(cameraY, cameraZ)
  const halfFovTangent = Math.tan(
    (CAMERA_FOV_DEGREES * Math.PI) / 360,
  )

  let radius = 0
  for (const screenX of [-1, 1]) {
    for (const screenY of [-1, 1]) {
      const directionX = screenX * halfFovTangent * safeAspect
      const directionY =
        -cameraY / cameraLength +
        screenY * halfFovTangent * (cameraZ / cameraLength)
      const directionZ =
        -cameraZ / cameraLength -
        screenY * halfFovTangent * (cameraY / cameraLength)
      if (directionY >= -1e-6) continue

      const travel = -cameraY / directionY
      const groundX = travel * directionX
      const groundZ = cameraZ + travel * directionZ
      radius = Math.max(radius, Math.hypot(groundX, groundZ))
    }
  }
  return radius
}

export function resolveScatterGatherRadius(
  aspect: number,
  cameraDistanceScale: number,
): number {
  if (
    !Number.isFinite(aspect) ||
    !Number.isFinite(cameraDistanceScale) ||
    aspect <= CAMERA_REFERENCE_ASPECT
  ) {
    return BASE_SCATTER_GATHER_RADIUS
  }

  const referenceCoverage = projectedGroundRadius(
    CAMERA_REFERENCE_ASPECT,
    cameraDistanceScale,
  )
  const actualCoverage = projectedGroundRadius(aspect, cameraDistanceScale)
  return Math.min(
    MAX_SCATTER_GATHER_RADIUS,
    BASE_SCATTER_GATHER_RADIUS +
      Math.max(0, actualCoverage - referenceCoverage),
  )
}
