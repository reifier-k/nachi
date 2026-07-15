const spawnOrderRequestTotals = new WeakMap<object, number>();

export function simulationCacheSpawnOrderRequestTotal(owner: object): number {
  return spawnOrderRequestTotals.get(owner) ?? 0;
}

export function setSimulationCacheSpawnOrderRequestTotal(owner: object, value: number): void {
  spawnOrderRequestTotals.set(owner, value);
}
