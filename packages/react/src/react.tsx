import {
  VFXSystem,
  type EmptyParameterSchema,
  type EffectDefinition,
  type EffectElements,
  type EffectInstance,
  type EffectSpawnOptions,
  type EffectTransformSource,
  type ParameterSchema,
  type VfxRuntimeRenderer,
  type VfxSystemOptions,
} from '@nachi/core';
import { useFrame, useThree } from '@react-three/fiber';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Quaternion, Vector3, type Object3D } from 'three';

type RuntimeSystem = VFXSystem<VfxRuntimeRenderer, Object3D>;

const VFXSystemContext = createContext<RuntimeSystem | null>(null);

export interface VFXSystemProviderProps {
  readonly children?: ReactNode;
  readonly options?: VfxSystemOptions;
  readonly renderer: VfxRuntimeRenderer;
  readonly scene?: Object3D;
}

/**
 * Owns one core VFXSystem inside an R3F Canvas and advances it from R3F's frame loop.
 * Keep `options` referentially stable; changing it intentionally creates a fresh system.
 */
export function VFXSystemProvider({
  children,
  options,
  renderer,
  scene: sceneOverride,
}: VFXSystemProviderProps): ReactNode {
  const r3fScene = useThree((state) => state.scene);
  const scene = sceneOverride ?? r3fScene;
  const system = useMemo(
    () => new VFXSystem(renderer, scene, options ?? {}),
    [options, renderer, scene],
  );
  const [updateError, setUpdateError] = useState<unknown>();

  useFrame((_state, delta) => {
    void system.update(delta).catch((error: unknown) => setUpdateError(error));
  });

  if (updateError !== undefined) throw updateError;
  return <VFXSystemContext.Provider value={system}>{children}</VFXSystemContext.Provider>;
}

export function useVFXSystem(): RuntimeSystem {
  const system = useContext(VFXSystemContext);
  if (!system) {
    throw new Error('useVFXSystem() must be used below <VFXSystemProvider> inside an R3F Canvas.');
  }
  return system;
}

export function createObject3DTransformSource(object: Object3D): EffectTransformSource {
  const position = new Vector3();
  const rotation = new Quaternion();
  return {
    getWorldTransform() {
      object.updateWorldMatrix(true, false);
      object.getWorldPosition(position);
      object.getWorldQuaternion(rotation);
      return {
        position: [position.x, position.y, position.z],
        rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
      };
    },
  };
}

function isTransformSource(
  value: Object3D | EffectTransformSource,
): value is EffectTransformSource {
  return 'getWorldTransform' in value && typeof value.getWorldTransform === 'function';
}

export type UseEffectInstanceOptions<
  Elements extends EffectElements = EffectElements,
  Parameters extends ParameterSchema = EmptyParameterSchema,
> = EffectSpawnOptions<EffectDefinition<Elements, Parameters>> & {
  readonly attachTo?: Object3D | EffectTransformSource;
};

function resolvedParameters<Elements extends EffectElements, Parameters extends ParameterSchema>(
  definition: EffectDefinition<Elements, Parameters>,
  overrides: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return {
    ...Object.fromEntries(
      Object.entries(definition.parameters ?? {}).map(([path, parameter]) => [
        path,
        parameter.default,
      ]),
    ),
    ...(overrides ?? {}),
  };
}

function changedEntries(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): readonly (readonly [string, unknown])[] {
  return Object.entries(next).filter(([path, value]) => !Object.is(previous[path], value));
}

export function useEffectInstance<
  const Elements extends EffectElements,
  const Parameters extends ParameterSchema = EmptyParameterSchema,
>(
  definition: EffectDefinition<Elements, Parameters>,
  options: UseEffectInstanceOptions<Elements, Parameters> = {},
): EffectInstance<EffectDefinition<Elements, Parameters>> | null {
  type Definition = EffectDefinition<Elements, Parameters>;
  const system = useVFXSystem();
  const [instance, setInstance] = useState<EffectInstance<Definition> | null>(null);
  const instanceRef = useRef<EffectInstance<Definition> | null>(null);
  const committedParameters = useRef<Readonly<Record<string, unknown>>>({});
  const attachment = useMemo(() => {
    if (!options.attachTo) return undefined;
    return isTransformSource(options.attachTo)
      ? options.attachTo
      : createObject3DTransformSource(options.attachTo);
  }, [options.attachTo]);

  useEffect(() => {
    const spawnOptions = {
      ...(options.parameters === undefined ? {} : { parameters: options.parameters }),
      ...(options.position === undefined ? {} : { position: options.position }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.timeScale === undefined ? {} : { timeScale: options.timeScale }),
    } as EffectSpawnOptions<Definition>;
    const next = system.spawn(definition, spawnOptions);
    if (attachment) next.attachTo(attachment);
    instanceRef.current = next;
    committedParameters.current =
      next.state === 'error'
        ? {}
        : resolvedParameters(
            definition,
            options.parameters as Readonly<Record<string, unknown>> | undefined,
          );
    setInstance(next);
    return () => {
      if (next.state !== 'released') next.detach();
      next.release();
      if (instanceRef.current === next) instanceRef.current = null;
    };
    // Seed and priority are spawn-only. Other values have live update effects below.
  }, [definition, options.priority, options.seed, system]);

  useEffect(() => {
    const current = instanceRef.current;
    if (!current || current.state === 'error') return;
    const nextParameters = resolvedParameters(
      definition,
      options.parameters as Readonly<Record<string, unknown>> | undefined,
    );
    const committed = { ...committedParameters.current };
    for (const [path, value] of changedEntries(committed, nextParameters)) {
      // Core validation must succeed before the React binding records the forwarded value.
      current.setParameter(path as never, value as never);
      committed[path] = value;
      committedParameters.current = { ...committed };
    }
  }, [definition, options.parameters, options.priority, options.seed, system]);

  useEffect(() => {
    const current = instanceRef.current;
    if (current && options.timeScale !== undefined) current.setTimeScale(options.timeScale);
  }, [definition, options.priority, options.seed, options.timeScale, system]);

  useEffect(() => {
    const current = instanceRef.current;
    if (current && (options.position !== undefined || options.rotation !== undefined)) {
      current.setTransform(options.position ?? [0, 0, 0], options.rotation);
    }
  }, [definition, options.position, options.priority, options.rotation, options.seed, system]);

  useEffect(() => {
    const current = instanceRef.current;
    if (!current) return;
    if (attachment) current.attachTo(attachment);
    else current.detach();
    return () => {
      if (current.state !== 'released') current.detach();
    };
  }, [attachment, definition, options.priority, options.seed, system]);

  return instance;
}

export type VFXEffectProps<
  Elements extends EffectElements = EffectElements,
  Parameters extends ParameterSchema = EmptyParameterSchema,
> = UseEffectInstanceOptions<Elements, Parameters> & {
  readonly definition: EffectDefinition<Elements, Parameters>;
  readonly onInstance?: (
    instance: EffectInstance<EffectDefinition<Elements, Parameters>> | null,
  ) => void;
};

export function VFXEffect<
  const Elements extends EffectElements,
  const Parameters extends ParameterSchema = EmptyParameterSchema,
>({ definition, onInstance, ...options }: VFXEffectProps<Elements, Parameters>): null {
  const instance = useEffectInstance(definition, options);
  const onInstanceRef = useRef(onInstance);
  const notifiedInstanceRef = useRef<EffectInstance<EffectDefinition<Elements, Parameters>> | null>(
    null,
  );

  useEffect(() => {
    onInstanceRef.current = onInstance;
  }, [onInstance]);

  useEffect(() => {
    if (notifiedInstanceRef.current === instance) return;
    notifiedInstanceRef.current = instance;
    onInstanceRef.current?.(instance);
  }, [instance]);

  useEffect(
    () => () => {
      if (notifiedInstanceRef.current === null) return;
      notifiedInstanceRef.current = null;
      onInstanceRef.current?.(null);
    },
    [],
  );
  return null;
}
