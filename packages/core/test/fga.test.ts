import { describe, expect, it } from 'vitest';

import { parseFga } from '../src/index.js';

const header = '2, 1, 1, -1, -2, -3, 1, 2, 3,';

describe('FGA parser', () => {
  it('parses comma-separated resolution, bounds, and vectors', () => {
    const field = parseFga(`${header} 1, 2, 3, -1, -2, -3`);
    expect(field.resolution).toEqual([2, 1, 1]);
    expect(field.boundsMin).toEqual([-1, -2, -3]);
    expect(field.boundsMax).toEqual([1, 2, 3]);
    expect([...field.vectors]).toEqual([1, 2, 3, -1, -2, -3]);
  });

  it('accepts arbitrary ASCII whitespace between values', () => {
    expect(parseFga('1 1 1\n0 0 0\n1 1 1\n0.25 -0.5 1').vectors).toEqual(
      new Float32Array([0.25, -0.5, 1]),
    );
  });

  it('preserves X-major vector sample ordering', () => {
    const field = parseFga('2 1 1 0 0 0 2 1 1 1 0 0 0 1 0');
    expect([...field.vectors.slice(0, 3)]).toEqual([1, 0, 0]);
    expect([...field.vectors.slice(3, 6)]).toEqual([0, 1, 0]);
  });

  it('rejects incomplete headers', () => {
    expect(() => parseFga('1 1 1')).toThrow('resolution and min/max bounds');
  });

  it('rejects non-positive and fractional resolutions', () => {
    expect(() => parseFga('0 1 1 0 0 0 1 1 1')).toThrow('positive safe integers');
    expect(() => parseFga('1.5 1 1 0 0 0 1 1 1')).toThrow('positive safe integers');
  });

  it('rejects inverted or degenerate bounds', () => {
    expect(() => parseFga('1 1 1 0 0 0 0 1 1 0 0 0')).toThrow('maximum bounds must be greater');
  });

  it('rejects a vector count that disagrees with the resolution', () => {
    expect(() => parseFga(`${header} 1 2 3`)).toThrow('expected 6 vector components');
  });

  it('rejects non-finite vector components', () => {
    expect(() => parseFga('1 1 1 0 0 0 1 1 1 0 Infinity 0')).toThrow('non-finite');
  });

  it('returns fresh vector storage for independent parses', () => {
    const source = '1 1 1 0 0 0 1 1 1 1 2 3';
    const first = parseFga(source);
    const second = parseFga(source);
    first.vectors[0] = 99;
    expect(second.vectors[0]).toBe(1);
  });
});
