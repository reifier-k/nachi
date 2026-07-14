import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const packageDirectories = (await readdir(path.join(root, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, 'packages', entry.name))
  .sort();
const versionExportPackages = new Set([
  '@nachi-vfx/core',
  '@nachi-vfx/format',
  '@nachi-vfx/trails',
]);

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

async function publicPackages() {
  const packages = [];
  for (const packageRoot of packageDirectories) {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (!manifest.private) packages.push({ manifest, packageRoot });
  }
  return packages;
}

async function verifyReleasePlan(packages) {
  const output = `.changeset-status-release-dry-${process.pid}.json`;
  try {
    await run('pnpm', ['changeset', 'status', '--output', output]);
    const status = JSON.parse(await readFile(path.join(root, output), 'utf8'));
    const expectedNames = packages.map(({ manifest }) => manifest.name).sort();
    const unknownReleases = status.releases.filter(({ name }) => !expectedNames.includes(name));
    if (unknownReleases.length > 0) {
      throw new Error(
        `Changeset release plan contains non-public packages: ${unknownReleases
          .map(({ name }) => name)
          .join(', ')}.`,
      );
    }
    const releases = status.releases.sort((left, right) => left.name.localeCompare(right.name));
    const initialPackages = packages.filter(({ manifest }) => manifest.version === '0.0.0');
    if (initialPackages.length > 0) {
      if (initialPackages.length !== packages.length) {
        throw new Error('Public packages cannot mix unreleased 0.0.0 and versioned manifests.');
      }
      const releaseNames = releases.map(({ name }) => name);
      if (JSON.stringify(releaseNames) !== JSON.stringify(expectedNames)) {
        throw new Error(
          `Initial release plan package set differs from public packages: expected ${expectedNames.join(', ')}; received ${releaseNames.join(', ')}.`,
        );
      }
      const invalid = releases.filter(
        ({ newVersion, oldVersion, type }) =>
          type !== 'minor' || oldVersion !== '0.0.0' || newVersion !== '0.1.0',
      );
      if (invalid.length > 0) {
        throw new Error(
          `Every public package must have a minor 0.0.0 -> 0.1.0 release plan: ${invalid
            .map(
              ({ name, newVersion, oldVersion, type }) =>
                `${name} (${type} ${oldVersion} -> ${newVersion})`,
            )
            .join(', ')}.`,
        );
      }
      console.log(
        `Initial Changeset release plan verified: ${releases.length} public packages, all minor 0.0.0 -> 0.1.0.`,
      );
      return;
    }

    const currentVersions = new Map(
      packages.map(({ manifest }) => [manifest.name, manifest.version]),
    );
    const staleReleases = releases.filter(
      ({ name, oldVersion }) => currentVersions.get(name) !== oldVersion,
    );
    if (staleReleases.length > 0) {
      throw new Error(
        `Changeset release plan does not start at current package versions: ${staleReleases
          .map(({ name, oldVersion }) => `${name} (${oldVersion})`)
          .join(', ')}.`,
      );
    }
    console.log(
      releases.length === 0
        ? `Prepared release state verified: ${packages.length} versioned public packages and no pending Changesets.`
        : `Changeset release plan verified: ${releases.length} pending public package releases.`,
    );
  } finally {
    await rm(path.join(root, output), { force: true });
  }
}

async function verifyVersionExports(packages) {
  for (const { manifest, packageRoot } of packages) {
    const entry = path.join(packageRoot, manifest.exports['.'].import);
    const module = await import(pathToFileURL(entry).href);
    if (versionExportPackages.has(manifest.name)) {
      if (typeof module.VERSION !== 'string') {
        throw new Error(`${manifest.name} must export its public VERSION constant.`);
      }
      if (module.VERSION !== manifest.version) {
        throw new Error(
          `${manifest.name} VERSION (${module.VERSION}) differs from package.json (${manifest.version}).`,
        );
      }
    } else if (module.VERSION !== undefined && module.VERSION !== manifest.version) {
      throw new Error(
        `${manifest.name} VERSION (${module.VERSION}) differs from package.json (${manifest.version}).`,
      );
    }
  }
  console.log(
    `Public VERSION exports verified against package.json: ${[...versionExportPackages].sort().join(', ')}.`,
  );
}

const packRoot = await mkdtemp(path.join(os.tmpdir(), 'nachi-release-dry-'));
try {
  const packages = await publicPackages();
  await verifyReleasePlan(packages);
  await verifyVersionExports(packages);
  for (const { manifest, packageRoot } of packages) {
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
