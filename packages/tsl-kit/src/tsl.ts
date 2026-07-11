// Three's TSL surface is intentionally centralized here. Public modules import only
// this package-private adapter so an r185 API change has one migration boundary.
export {
  abs,
  clamp,
  color,
  cos,
  dot,
  float,
  fract,
  length,
  mix,
  normalView,
  positionViewDirection,
  pow,
  sin,
  step,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
