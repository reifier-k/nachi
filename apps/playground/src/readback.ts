const WEBGPU_BYTES_PER_ROW_ALIGNMENT = 256;

/**
 * Removes the row padding returned by Three r185's WebGPU render-target readback.
 * WebGL2 already returns a dense array. The final WebGPU row is not padded because Three sizes
 * its staging buffer as `(height - 1) * alignedBytesPerRow + denseBytesPerRow`.
 */
export function compactRgba8Readback(
  source: Uint8Array,
  width: number,
  height: number,
  webgpu: boolean,
  bytesPerPixel = 4,
): Uint8Array {
  const denseBytesPerRow = width * bytesPerPixel;
  const denseByteLength = denseBytesPerRow * height;
  if (source.byteLength === denseByteLength) return source;

  if (!webgpu) {
    throw new Error(
      `Unexpected WebGL2 readback length: got ${source.byteLength}, expected ${denseByteLength}.`,
    );
  }

  const paddedBytesPerRow =
    Math.ceil(denseBytesPerRow / WEBGPU_BYTES_PER_ROW_ALIGNMENT) * WEBGPU_BYTES_PER_ROW_ALIGNMENT;
  const paddedByteLength = (height - 1) * paddedBytesPerRow + denseBytesPerRow;
  if (source.byteLength !== paddedByteLength) {
    throw new Error(
      `Unexpected WebGPU readback length: got ${source.byteLength}, expected ${paddedByteLength}.`,
    );
  }

  const dense = new Uint8Array(denseByteLength);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * paddedBytesPerRow;
    dense.set(
      source.subarray(sourceOffset, sourceOffset + denseBytesPerRow),
      row * denseBytesPerRow,
    );
  }
  return dense;
}

/** Compacts WebGPU padding and normalizes both backends to top-down rows for DOM presentation. */
export function normalizeRgba8Readback(
  source: Uint8Array,
  width: number,
  height: number,
  webgpu: boolean,
): Uint8Array {
  const dense = compactRgba8Readback(source, width, height, webgpu);
  if (webgpu) return dense;
  const bytesPerRow = width * 4;
  const topDown = new Uint8Array(dense.byteLength);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = (height - 1 - row) * bytesPerRow;
    topDown.set(dense.subarray(sourceOffset, sourceOffset + bytesPerRow), row * bytesPerRow);
  }
  return topDown;
}
