import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageDirectories = (await readdir(path.join(root, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, 'packages', entry.name))
  .sort();

function runNpmDryRun(packageRoot) {
  // npm leaves workspace:^ ranges untouched. Real releases must use the pnpm publish/Changesets
  // path so pnpm rewrites workspace protocols to the released semver ranges.
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npm',
      [
        'publish',
        '--dry-run',
        '--offline',
        '--ignore-scripts',
        '--access',
        'public',
        '--provenance=false',
      ],
      {
        cwd: packageRoot,
        env: { ...process.env, npm_config_cache: '/tmp/nachi-npm-cache' },
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(`npm publish --dry-run failed (${signal ?? `exit ${code}`}) in ${packageRoot}`),
        );
      }
    });
  });
}

for (const packageRoot of packageDirectories) {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.private) continue;
  console.log(`\nDry-running ${manifest.name}@${manifest.version}`);
  await runNpmDryRun(packageRoot);
}

console.log('\nAll public packages passed npm publish --dry-run. No package was published.');
