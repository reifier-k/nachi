import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const reportPath = path.join(root, 'docs/license-report.md');
const storeRoot = path.join(root, 'node_modules/.pnpm');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function dependencyManifests() {
  const manifests = [await readJson(path.join(root, 'package.json'))];
  for (const workspace of ['apps', 'packages']) {
    const entries = await readdir(path.join(root, workspace), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        manifests.push(await readJson(path.join(root, workspace, entry.name, 'package.json')));
      }
    }
  }
  return manifests;
}

async function installedPackages() {
  const records = new Map();
  const storeEntries = await readdir(storeRoot, { withFileTypes: true });
  for (const storeEntry of storeEntries) {
    if (!storeEntry.isDirectory() || storeEntry.name === 'node_modules') continue;
    const modulesRoot = path.join(storeRoot, storeEntry.name, 'node_modules');
    let entries;
    try {
      entries = await readdir(modulesRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        const scoped = await readdir(path.join(modulesRoot, entry.name), { withFileTypes: true });
        for (const packageEntry of scoped) {
          if (!packageEntry.isDirectory()) continue;
          await addPackage(path.join(modulesRoot, entry.name, packageEntry.name), records);
        }
      } else if (entry.isDirectory()) {
        await addPackage(path.join(modulesRoot, entry.name), records);
      }
    }
  }
  return [...records.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

async function addPackage(packageRoot, records) {
  let manifest;
  try {
    manifest = await readJson(path.join(packageRoot, 'package.json'));
  } catch {
    return;
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return;
  const key = `${manifest.name}@${manifest.version}`;
  const declaredLicense = normalizeLicense(manifest.license ?? manifest.licenses);
  const license = await resolveLicense(packageRoot, declaredLicense);
  records.set(key, {
    dependencies: Object.keys(manifest.dependencies ?? {}),
    declaredLicense,
    license,
    name: manifest.name,
    version: manifest.version,
  });
}

async function resolveLicense(packageRoot, declaredLicense) {
  if (!/SEE LICENSE/i.test(declaredLicense)) return declaredLicense;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    try {
      const text = await readFile(path.join(packageRoot, filename), 'utf8');
      if (/Permission is hereby granted, free of charge/.test(text)) return 'MIT';
    } catch {
      // Try the next conventional license filename.
    }
  }
  return declaredLicense;
}

function normalizeLicense(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter((entry) => typeof entry === 'string');
    if (values.length > 0) return values.join(' OR ');
  }
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type;
  return 'UNKNOWN';
}

function directDependencyKinds(manifests) {
  const kinds = new Map();
  const add = (name, kind) => {
    const values = kinds.get(name) ?? new Set();
    values.add(kind);
    kinds.set(name, values);
  };
  for (const manifest of manifests) {
    for (const name of Object.keys(manifest.dependencies ?? {})) add(name, 'production');
    for (const name of Object.keys(manifest.peerDependencies ?? {})) add(name, 'peer');
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) add(name, 'production');
    for (const name of Object.keys(manifest.devDependencies ?? {})) add(name, 'development');
  }
  return kinds;
}

function classify(packages, directKinds) {
  const packagesByName = new Map();
  for (const entry of packages) {
    const versions = packagesByName.get(entry.name) ?? [];
    versions.push(entry);
    packagesByName.set(entry.name, versions);
  }
  const reachable = (initialNames) => {
    const seen = new Set();
    const queue = [...initialNames];
    while (queue.length > 0) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      for (const entry of packagesByName.get(name) ?? []) queue.push(...entry.dependencies);
    }
    return seen;
  };
  const production = reachable(
    [...directKinds].filter(([, kinds]) => kinds.has('production')).map(([name]) => name),
  );
  const peers = reachable(
    [...directKinds].filter(([, kinds]) => kinds.has('peer')).map(([name]) => name),
  );
  return packages.map((entry) => ({
    ...entry,
    direct: [...(directKinds.get(entry.name) ?? [])].sort(),
    scope: production.has(entry.name)
      ? 'production'
      : peers.has(entry.name)
        ? 'peer'
        : 'development',
  }));
}

function concern(license) {
  if (license === 'UNKNOWN' || /SEE LICENSE|Custom|UNLICENSED/i.test(license)) return 'unknown';
  if (/\b(?:AGPL|GPL|LGPL|SSPL|EUPL)-?/i.test(license)) return 'copyleft';
  return null;
}

function table(entries) {
  return entries
    .map(
      (entry) =>
        `| \`${entry.name}\` | \`${entry.version}\` | ${entry.license.replaceAll('|', '\\|')} | ${entry.scope} | ${entry.direct.length === 0 ? 'transitive' : entry.direct.join(', ')} |`,
    )
    .join('\n');
}

const manifests = await dependencyManifests();
const packages = classify(await installedPackages(), directDependencyKinds(manifests));
const concerns = packages.filter((entry) => concern(entry.license) !== null);
const productionConcerns = concerns.filter((entry) => entry.scope !== 'development');
const licenseCounts = [...Map.groupBy(packages, (entry) => entry.license)]
  .map(([license, entries]) => ({ count: entries.length, license }))
  .sort((left, right) => right.count - left.count || left.license.localeCompare(right.license));
const threePackages = packages.filter((entry) => entry.name === 'three');
const resolvedDeclarations = packages.filter((entry) => entry.license !== entry.declaredLicense);
const threePinned = manifests.every((manifest) => {
  const ranges = [
    manifest.dependencies?.three,
    manifest.peerDependencies?.three,
    manifest.devDependencies?.three,
  ].filter(Boolean);
  return ranges.every((range) => range === '0.185.1');
});

const markdown = `# Dependency license report

Generated by \`node tools/license-report.mjs\` from package metadata physically installed under
\`node_modules/.pnpm\`. Duplicate package versions are listed separately. Scope is derived by
walking installed dependency metadata from workspace production dependencies and peers; remaining
tooling is marked development. This is release-audit evidence, not legal advice.

## Summary

- Installed external package versions: **${packages.length}**
- License identifiers/expressions: **${licenseCounts.length}**
- Production/peer unknown or copyleft concerns: **${productionConcerns.length}**
- Development-only unknown or copyleft concerns: **${concerns.length - productionConcerns.length}**
- Non-SPDX package declarations resolved from bundled license text: **${resolvedDeclarations.length}**
- Three.js: ${
  threePackages.length === 0
    ? '**not found (FAIL)**'
    : threePackages.map((entry) => `\`${entry.version}\` / \`${entry.license}\``).join(', ')
}; workspace runtime ranges ${threePinned ? 'are exactly pinned to `0.185.1`' : 'are not all pinned (FAIL)'}.

The installed production and development dependency set has **${
  concerns.length === 0 ? 'no license concern detected' : 'items requiring review listed below'
}** under the conservative check for missing/custom terms and GPL-family copyleft. Permissive,
notice-bearing licenses remain subject to preserving their notices in redistributed artifacts.

## License counts

| License | Package versions |
|---|---:|
${licenseCounts.map((entry) => `| ${entry.license.replaceAll('|', '\\|')} | ${entry.count} |`).join('\n')}

## Review items

${
  concerns.length === 0
    ? 'None.'
    : concerns
        .map(
          (entry) =>
            `- \`${entry.name}@${entry.version}\`: \`${entry.license}\` (${entry.scope}, ${concern(entry.license)})`,
        )
        .join('\n')
}

## Resolved license declarations

${
  resolvedDeclarations.length === 0
    ? 'None.'
    : resolvedDeclarations
        .map(
          (entry) =>
            `- \`${entry.name}@${entry.version}\`: package.json says \`${entry.declaredLicense}\`; bundled license text matches \`${entry.license}\`.`,
        )
        .join('\n')
}

## Complete installed dependency inventory

| Package | Version | License | Scope | Direct use |
|---|---|---|---|---|
${table(packages)}
`;

await writeFile(reportPath, markdown, 'utf8');
console.log(`Wrote ${path.relative(root, reportPath)} (${packages.length} package versions).`);
if (productionConcerns.length > 0 || !threePinned || threePackages.length === 0)
  process.exitCode = 1;
