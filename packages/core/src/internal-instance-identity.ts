export type InternalEffectInstanceIdentity = {
  readonly id: string;
  readonly sequence: number;
};

/** Allocates the next exact numeric sequence and compatible public ID for VFXSystem internals. */
export function nextEffectInstanceIdentity(
  currentSequence: number,
): InternalEffectInstanceIdentity {
  if (
    !Number.isSafeInteger(currentSequence) ||
    currentSequence < 0 ||
    currentSequence >= Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError('VFXSystem instance creation sequence exhausted Number.MAX_SAFE_INTEGER.');
  }
  const sequence = currentSequence + 1;
  return { id: `nachi-effect-${sequence}`, sequence };
}
