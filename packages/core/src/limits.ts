/** Defensive authoring limits applied before synchronous allocation or kernel expansion. */
export const MAX_EMITTER_CAPACITY = 2 ** 22;
/** Leaves one exact 2^-20 render-order fraction below the next integer bucket. */
export const MAX_TRANSPARENT_DRAW_ORDER_ENTRIES = 2 ** 20 - 1;
export const MAX_PBD_ITERATIONS = 64;
export const MAX_PREWARM_SECONDS = 300;
export const RENDER_ORDER_BUCKET_MAX = 2_147_483_647;
export const RENDER_ORDER_BUCKET_MIN = -2_147_483_648;
export const RENDER_ORDER_RANK_DENOMINATOR = 2 ** 20;
