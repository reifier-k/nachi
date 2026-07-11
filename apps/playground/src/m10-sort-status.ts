interface DatasetTarget {
  readonly dataset: Record<string, string | undefined>;
}

interface TextTarget {
  textContent: string | null;
}

export function validateSpawnOrderInitReadback(
  spawnOrders: readonly number[],
  positionZ: readonly number[],
): boolean {
  if (spawnOrders.length === 0 || spawnOrders.length !== positionZ.length) return false;
  const consecutive = [...spawnOrders].sort((left, right) => left - right);
  if (consecutive.some((value, index) => value !== index)) return false;
  return positionZ.every((value, physicalIndex) => {
    const expected = ((spawnOrders[physicalIndex] ?? Number.NaN) / 2) * 1.2 - 0.6;
    return Math.abs(value - expected) < 1e-5;
  });
}

export function publishM10SortValidation(
  root: DatasetTarget,
  statusValue: TextTarget,
  validation: Readonly<Record<string, boolean>>,
  details: Readonly<Record<string, unknown>>,
): void {
  const passed = Object.values(validation).every(Boolean);
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeResult = JSON.stringify({ ...details, ok: passed, validation });
  root.dataset.spikeStatus = 'complete';
  statusValue.textContent = passed ? 'All checks passed' : 'Validation failed';
}

export function publishM10SortError(
  root: DatasetTarget,
  statusValue: TextTarget,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  root.dataset.spikeStatus = 'error';
  statusValue.textContent = 'Failed';
  return message;
}
