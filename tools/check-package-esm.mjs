import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const packageRoot = path.resolve(process.argv[2] ?? '.');
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const executeFile = promisify(execFile);

function collectPublicSpecifiers(packageName, exportsValue) {
  if (typeof exportsValue === 'string') return [packageName];
  if (!exportsValue || typeof exportsValue !== 'object') return [];
  const exportKeys = Object.keys(exportsValue).filter((key) => key.startsWith('.'));
  if (exportKeys.length === 0) return [packageName];
  return exportKeys.map((key) => (key === '.' ? packageName : `${packageName}${key.slice(1)}`));
}

const specifiers = [...new Set(collectPublicSpecifiers(manifest.name, manifest.exports))];
if (typeof manifest.name !== 'string' || specifiers.length === 0) {
  throw new Error(`${manifest.name ?? packageRoot} has no ESM import targets to verify.`);
}

for (const specifier of specifiers) {
  await executeFile(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(specifier)})`],
    { cwd: packageRoot },
  );
}

console.log(`Node ESM import verified: ${specifiers.join(', ')}`);
