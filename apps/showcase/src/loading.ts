import type { VfxPrepareProgress } from '@nachi-vfx/core';

type PreparationProgress = Pick<VfxPrepareProgress, 'completed' | 'total'> & {
  readonly resource?: VfxPrepareProgress['resource'];
};

export interface ShowcaseLoading {
  readonly signal: AbortSignal;
  complete(): void;
  fail(error: unknown): void;
  run(
    label: string,
    operation: (
      signal: AbortSignal,
      onProgress: (progress: PreparationProgress) => void,
    ) => Promise<void>,
  ): Promise<void>;
}

export function createShowcaseLoading(stage: HTMLElement, status: HTMLElement): ShowcaseLoading {
  const controller = new AbortController();
  const overlay = document.createElement('div');
  overlay.className = 'showcase-loading';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  const title = document.createElement('strong');
  title.textContent = 'Preparing effect';
  const detail = document.createElement('span');
  detail.textContent = 'initializing resources';
  const track = document.createElement('span');
  track.className = 'showcase-loading__track';
  const fill = document.createElement('span');
  fill.className = 'showcase-loading__fill';
  track.appendChild(fill);
  overlay.append(title, detail, track);
  stage.appendChild(overlay);
  status.textContent = 'loading · preparing GPU resources';
  document.documentElement.dataset.prepareStatus = 'loading';

  const abort = () => controller.abort();
  window.addEventListener('pagehide', abort, { once: true });
  const setProgress = (label: string, progress?: PreparationProgress) => {
    const suffix = progress?.resource?.key ? ` · ${progress.resource.key}` : '';
    detail.textContent = `${label}${suffix}`;
    const ratio = progress && progress.total > 0 ? progress.completed / progress.total : 0;
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
  };
  const cleanup = () => window.removeEventListener('pagehide', abort);

  return {
    signal: controller.signal,
    complete(): void {
      cleanup();
      fill.style.transform = 'scaleX(1)';
      overlay.remove();
      document.documentElement.dataset.prepareStatus = 'complete';
    },
    fail(error: unknown): void {
      cleanup();
      const message = error instanceof Error ? error.message : String(error);
      overlay.classList.add('showcase-loading--error');
      title.textContent = 'Preparation failed';
      detail.textContent = message;
      track.hidden = true;
      status.textContent = `error · ${message}`;
      document.documentElement.dataset.prepareStatus = 'error';
    },
    async run(label, operation): Promise<void> {
      controller.signal.throwIfAborted();
      setProgress(label);
      await operation(controller.signal, (progress) => setProgress(label, progress));
      controller.signal.throwIfAborted();
    },
  };
}
