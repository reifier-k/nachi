import { Pane } from 'tweakpane';
import * as THREE from 'three/webgpu';

/** Structural view of a TimelineEffectInstance so pages stay decoupled from generics. */
interface TuneableInstance {
  readonly cycle: number;
  readonly definition: { readonly elements: Readonly<Record<string, unknown>> };
  readonly localTime: number;
  readonly state: string;
  readonly timeScale: number;
  applyHitStop(durationMs: number, timeScale?: number): void;
  getEmitter(key: string): { readonly aliveCount: number | undefined } | undefined;
  setTimeScale(timeScale: number): void;
}

export interface ShowcaseTuningOptions {
  readonly camera: THREE.PerspectiveCamera;
  /** Base transform the page's step() re-applies each frame before camera shake. */
  readonly cameraBasePosition: THREE.Vector3;
  readonly cameraBaseRotation: THREE.Euler;
  /** The point the page's fixed camera looks at; orbit/dolly pivot around it. */
  readonly cameraTarget: THREE.Vector3;
  readonly instance: TuneableInstance;
  readonly renderer: THREE.WebGPURenderer;
}

const PANEL_MESSAGE = 'nachi-showcase:set-panel';
const HIT_STOP_MS = 140;

/**
 * Live-mode debug tuning panel. Attached only on the interactive path — the
 * headless keyframe capture returns before this runs, so spike results and
 * screenshot baselines are unaffected. The shell toggles visibility through
 * postMessage; standalone visitors get the panel collapsed but visible.
 */
export function attachShowcaseTuning(options: ShowcaseTuningOptions): void {
  const { camera, cameraBasePosition, cameraBaseRotation, cameraTarget, instance, renderer } =
    options;
  const search = new URLSearchParams(location.search);
  const embedded = search.get('embed') === '1';

  const homePosition = cameraBasePosition.clone();
  const defaults = {
    exposure: renderer.toneMappingExposure,
    fov: camera.fov,
  };
  const settings = {
    distance: 1,
    exposure: defaults.exposure,
    fov: defaults.fov,
    height: 0,
    orbit: 0,
    paused: false,
    speed: 1,
  };

  const scratch = new THREE.PerspectiveCamera();
  const up = new THREE.Vector3(0, 1, 0);
  const applyCamera = () => {
    const offset = homePosition.clone().sub(cameraTarget);
    offset.applyAxisAngle(up, THREE.MathUtils.degToRad(settings.orbit));
    offset.multiplyScalar(settings.distance);
    cameraBasePosition.copy(cameraTarget).add(offset);
    cameraBasePosition.y += settings.height;
    scratch.position.copy(cameraBasePosition);
    scratch.lookAt(cameraTarget);
    cameraBaseRotation.copy(scratch.rotation);
    camera.fov = settings.fov;
    camera.updateProjectionMatrix();
  };
  const applyPlayback = () => {
    instance.setTimeScale(settings.paused ? 0 : settings.speed);
  };

  const pane = new Pane({ expanded: true, title: 'Debug tuning' });
  pane.hidden = embedded && search.get('panel') !== '1';

  const playback = pane.addFolder({ expanded: true, title: 'Playback' });
  playback
    .addBinding(settings, 'speed', { label: 'time scale', max: 2, min: 0, step: 0.05 })
    .on('change', applyPlayback);
  playback.addBinding(settings, 'paused').on('change', applyPlayback);
  playback.addButton({ title: `hit stop ${HIT_STOP_MS}ms` }).on('click', () => {
    if (!settings.paused) instance.applyHitStop(HIT_STOP_MS);
  });

  const view = pane.addFolder({ expanded: true, title: 'Camera / render' });
  view
    .addBinding(settings, 'orbit', { label: 'orbit °', max: 180, min: -180, step: 1 })
    .on('change', applyCamera);
  view
    .addBinding(settings, 'height', { max: 1.5, min: -1.5, step: 0.01 })
    .on('change', applyCamera);
  view
    .addBinding(settings, 'distance', { max: 2, min: 0.45, step: 0.01 })
    .on('change', applyCamera);
  view.addBinding(settings, 'fov', { max: 70, min: 24, step: 0.5 }).on('change', applyCamera);
  view.addBinding(settings, 'exposure', { max: 2.5, min: 0.2, step: 0.01 }).on('change', () => {
    renderer.toneMappingExposure = settings.exposure;
  });
  view.addButton({ title: 'reset' }).on('click', () => {
    settings.distance = 1;
    settings.exposure = defaults.exposure;
    settings.fov = defaults.fov;
    settings.height = 0;
    settings.orbit = 0;
    settings.paused = false;
    settings.speed = 1;
    renderer.toneMappingExposure = defaults.exposure;
    applyCamera();
    applyPlayback();
    pane.refresh();
  });

  const emitterKeys = Object.keys(instance.definition.elements);
  const stats = {
    get alive() {
      let total = 0;
      for (const key of emitterKeys) total += instance.getEmitter(key)?.aliveCount ?? 0;
      return total;
    },
    get cycle() {
      return instance.cycle;
    },
    get localTime() {
      return instance.localTime;
    },
    get state() {
      return instance.state;
    },
  };
  const debug = pane.addFolder({ expanded: true, title: 'Debug' });
  debug.addBinding(stats, 'localTime', {
    format: (value: number) => value.toFixed(2),
    interval: 120,
    readonly: true,
  });
  debug.addBinding(stats, 'cycle', {
    format: (value: number) => value.toFixed(0),
    interval: 250,
    readonly: true,
  });
  debug.addBinding(stats, 'alive', {
    format: (value: number) => value.toFixed(0),
    interval: 250,
    readonly: true,
  });
  debug.addBinding(stats, 'state', { interval: 500, readonly: true });

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== location.origin) return;
    const data = event.data as { type?: string; visible?: boolean } | null;
    if (!data || data.type !== PANEL_MESSAGE) return;
    pane.hidden = data.visible === undefined ? !pane.hidden : !data.visible;
  });
}
