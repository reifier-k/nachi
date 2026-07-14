const PHASE_EPSILON = 1e-10;

/**
 * Keeps a page-driven socket at the last pose consumed by a separately updated companion while a
 * parent hit stop is active. The first positive parent-local advance releases the latch so the
 * companion consumes the complete catch-up transform on a non-stopped step.
 */
export function createCompanionSocketPhase(initialLocalTime = 0) {
  let consumedLocalTime = initialLocalTime;
  let freeze: { readonly boundaryLocalTime: number; readonly socketLocalTime: number } | undefined;

  return {
    beginHitStop(boundaryLocalTime: number): void {
      freeze = { boundaryLocalTime, socketLocalTime: consumedLocalTime };
    },
    commitConsumedLocalTime(localTime: number): void {
      consumedLocalTime = localTime;
    },
    driveLocalTime(parentLocalTime: number): number {
      return freeze?.socketLocalTime ?? parentLocalTime;
    },
    releaseAfterParentAdvance(parentLocalTime: number): void {
      if (
        freeze &&
        (parentLocalTime > freeze.boundaryLocalTime + PHASE_EPSILON ||
          parentLocalTime < freeze.boundaryLocalTime - PHASE_EPSILON)
      ) {
        freeze = undefined;
      }
    },
  };
}
