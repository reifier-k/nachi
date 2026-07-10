import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/index.js';

describe('core package version contract', () => {
  it('exports the same valid semantic version declared by the package', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(VERSION);

    expect(match, `${VERSION} must be a semantic version`).not.toBeNull();
    expect(VERSION).toBe(manifest.version);
    expect(match?.slice(1, 4).map(Number)).toEqual([0, 0, 0]);
  });
});
