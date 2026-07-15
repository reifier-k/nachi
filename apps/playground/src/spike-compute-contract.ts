export type DrawControlProbe = {
  foreground: boolean;
  indirectArgs: readonly number[] | null;
  instanceCount: number;
};

export function evaluateDrawControl(
  backend: 'WebGL2' | 'WebGPU',
  indexCount: number,
  zero: DrawControlProbe,
  nonzero: DrawControlProbe,
): { controlPassed: boolean; indirectCausal: boolean } {
  const zeroArgumentsValid =
    backend === 'WebGPU'
      ? zero.indirectArgs?.[0] === indexCount &&
        zero.indirectArgs[1] === 0 &&
        zero.indirectArgs.slice(2).every((value) => value === 0)
      : zero.indirectArgs === null && zero.instanceCount === 0;
  const nonzeroArgumentsValid =
    backend === 'WebGPU'
      ? nonzero.indirectArgs?.[0] === indexCount &&
        (nonzero.indirectArgs[1] ?? 0) > 0 &&
        nonzero.indirectArgs.slice(2).every((value) => value === 0)
      : nonzero.indirectArgs === null && nonzero.instanceCount > 0;
  const controlPassed =
    zeroArgumentsValid && nonzeroArgumentsValid && !zero.foreground && nonzero.foreground;
  return { controlPassed, indirectCausal: backend === 'WebGPU' && controlPassed };
}
