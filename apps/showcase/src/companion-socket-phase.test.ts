import { describe, expect, it } from 'vitest';

import { createCompanionSocketPhase } from './companion-socket-phase';

describe('companion socket phase', () => {
  it('holds the last companion-consumed pose until parent local time resumes', () => {
    const phase = createCompanionSocketPhase();

    expect(phase.driveLocalTime(0.483333333333)).toBeCloseTo(0.483333333333, 12);
    phase.commitConsumedLocalTime(0.483333333333);
    phase.beginHitStop(0.5);

    expect(phase.driveLocalTime(0.5)).toBeCloseTo(0.483333333333, 12);
    phase.commitConsumedLocalTime(0.483333333333);
    phase.releaseAfterParentAdvance(0.5);
    expect(phase.driveLocalTime(0.5)).toBeCloseTo(0.483333333333, 12);

    phase.releaseAfterParentAdvance(0.513333333333);
    expect(phase.driveLocalTime(0.513333333333)).toBeCloseTo(0.513333333333, 12);
  });

  it('releases when a looping parent wraps its local time', () => {
    const phase = createCompanionSocketPhase(1.98);

    phase.beginHitStop(1.99);
    expect(phase.driveLocalTime(1.99)).toBeCloseTo(1.98, 12);

    phase.releaseAfterParentAdvance(0.01);
    expect(phase.driveLocalTime(0.01)).toBeCloseTo(0.01, 12);
  });
});
