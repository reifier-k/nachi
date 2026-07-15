/** @internal Advances the per-emitter Update random ordinal modulo 2^32. */
export function nextUpdateRandomStep(current: number): number {
  return (current + 1) >>> 0;
}
