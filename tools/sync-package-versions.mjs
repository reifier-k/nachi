import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const versionExports = [
  ['packages/core/package.json', 'packages/core/src/index.ts'],
  ['packages/format/package.json', 'packages/format/src/index.ts'],
  ['packages/trails/package.json', 'packages/trails/src/index.ts'],
];
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const versionExportPattern = /export const VERSION = '[^']+' as const;/g;

for (const [manifestPath, sourcePath] of versionExports) {
  const manifest = JSON.parse(await readFile(path.join(root, manifestPath), 'utf8'));
  if (typeof manifest.version !== 'string' || !semverPattern.test(manifest.version)) {
    throw new Error(`${manifestPath} has an invalid version: ${String(manifest.version)}`);
  }

  const absoluteSourcePath = path.join(root, sourcePath);
  const source = await readFile(absoluteSourcePath, 'utf8');
  const matches = source.match(versionExportPattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(`${sourcePath} must contain exactly one public VERSION export.`);
  }

  const nextSource = source.replace(
    versionExportPattern,
    `export const VERSION = '${manifest.version}' as const;`,
  );
  if (nextSource !== source) await writeFile(absoluteSourcePath, nextSource);
  console.log(`Synchronized ${sourcePath} to ${manifest.version}.`);
}
