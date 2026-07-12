import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const packagesRoot = path.join(root, 'packages');
const directories = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const directory of directories) {
  const packageRoot = path.join(packagesRoot, directory);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.private) continue;
  await executeFile(
    process.execPath,
    [path.join(root, 'tools/check-package-esm.mjs'), packageRoot],
    {
      cwd: root,
    },
  );
  console.log(`ESM gate passed: ${manifest.name}`);
}
