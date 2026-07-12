import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageDirectories = (await readdir(path.join(root, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, 'packages', entry.name))
  .sort();

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(stdout);
      else {
        reject(
          new Error(`${command} failed (${signal ?? `exit ${code}`}) in ${options.cwd ?? root}`),
        );
      }
    });
  });
}

const packRoot = await mkdtemp(path.join(os.tmpdir(), 'nachi-release-dry-'));
try {
  for (const packageRoot of packageDirectories) {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.private) continue;
    const destination = path.join(packRoot, path.basename(packageRoot));
    console.log(`\nPacking ${manifest.name}@${manifest.version} with pnpm`);
    await run('pnpm', ['pack', '--pack-destination', destination], { cwd: packageRoot });
    const tarballs = (await readdir(destination)).filter((entry) => entry.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      throw new Error(`Expected one tarball for ${manifest.name}; found ${tarballs.length}.`);
    }
    const tarball = path.join(destination, tarballs[0]);
    const packedManifestText = await run('tar', ['-xOf', tarball, 'package/package.json'], {
      capture: true,
    });
    const packedManifest = JSON.parse(packedManifestText);
    if (packedManifestText.includes('workspace:')) {
      throw new Error(`${manifest.name} packed manifest still contains a workspace: protocol.`);
    }
    if (packedManifest.name !== manifest.name || packedManifest.version !== manifest.version) {
      throw new Error(
        `${manifest.name} packed manifest identity differs from the source manifest.`,
      );
    }
  }
} finally {
  await rm(packRoot, { force: true, recursive: true });
}

console.log('\nAll public pnpm tarballs are publish-shaped and contain no workspace: protocols.');
