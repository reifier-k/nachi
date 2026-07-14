import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as THREE from 'three/webgpu';

export interface ShowcaseViewControlsOptions {
  readonly camera: THREE.PerspectiveCamera;
  /** Base transform the scene reapplies before adding camera shake. */
  readonly cameraBasePosition: THREE.Vector3;
  readonly cameraBaseRotation: THREE.Euler;
  readonly cameraTarget: THREE.Vector3;
  readonly renderer: THREE.WebGPURenderer;
}

export interface ShowcaseViewControls {
  reset(): void;
  setFov(fov: number): void;
}

const VIEW_HINT = 'Drag to orbit · Right-drag or two fingers to pan · Scroll or pinch to zoom';

/**
 * Adds conventional direct manipulation to a live showcase viewport.
 *
 * The controls own a separate camera because the render camera receives
 * timeline camera shake every frame. Changes are copied to the unshaken base
 * transform, which keeps interaction stable even during an impact.
 */
export function attachShowcaseViewControls(
  options: ShowcaseViewControlsOptions,
): ShowcaseViewControls {
  const { camera, cameraBasePosition, cameraBaseRotation, cameraTarget, renderer } = options;
  const canvas = renderer.domElement;
  const stage = canvas.parentElement;

  const controlCamera = camera.clone();
  controlCamera.position.copy(cameraBasePosition);
  controlCamera.rotation.copy(cameraBaseRotation);
  controlCamera.updateMatrixWorld(true);

  const controls = new OrbitControls(controlCamera, canvas);
  const homeDistance = cameraBasePosition.distanceTo(cameraTarget);
  controls.target.copy(cameraTarget);
  controls.cursor.copy(cameraTarget);
  controls.minDistance = homeDistance * 0.35;
  controls.maxDistance = homeDistance * 3;
  controls.maxTargetRadius = homeDistance;
  controls.minPolarAngle = THREE.MathUtils.degToRad(3);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(177);
  controls.cursorStyle = 'grab';
  controls.update();
  controls.saveState();

  const syncBaseTransform = () => {
    cameraBasePosition.copy(controlCamera.position);
    cameraBaseRotation.copy(controlCamera.rotation);
    cameraTarget.copy(controls.target);
  };
  controls.addEventListener('change', syncBaseTransform);

  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', `Interactive 3D effect. ${VIEW_HINT}.`);
  canvas.title = VIEW_HINT;
  controls.listenToKeyEvents(canvas);
  canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }));

  let resetButton: HTMLButtonElement | undefined;
  if (stage) {
    const hint = document.createElement('p');
    hint.className = 'view-controls-hint';
    hint.textContent = VIEW_HINT;

    resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'view-reset';
    resetButton.setAttribute('aria-label', 'Reset camera view');
    resetButton.title = 'Reset camera view';
    resetButton.innerHTML = '<span aria-hidden="true">↺</span><span>Reset view</span>';

    stage.append(hint, resetButton);
    controls.addEventListener('start', () => stage.classList.add('has-used-view-controls'));
  }

  const reset = () => {
    controls.reset();
    syncBaseTransform();
  };
  resetButton?.addEventListener('click', reset);

  return {
    reset,
    setFov(fov: number) {
      controlCamera.fov = fov;
      controlCamera.updateProjectionMatrix();
    },
  };
}
