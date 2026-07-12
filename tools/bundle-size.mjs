import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import prettier from 'prettier';

const root = path.resolve(import.meta.dirname, '..');
const docsRoot = path.join(root, 'docs');
const jsonPath = path.join(docsRoot, 'bundle-report.json');
const markdownPath = path.join(docsRoot, 'bundle-report.md');

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function publicPackages() {
  const packageEntries = await readdir(path.join(root, 'packages'), { withFileTypes: true });
  const packages = [];
  for (const entry of packageEntries) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(root, 'packages', entry.name);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.private === true) continue;
    packages.push({ manifest, packageRoot });
  }
  return packages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

async function measurePackage({ manifest, packageRoot }) {
  const dist = path.join(packageRoot, 'dist');
  try {
    if (!(await stat(dist)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`${manifest.name} has no dist directory. Run pnpm build first.`);
  }
  const files = await filesUnder(dist);
  if (files.length === 0) throw new Error(`${manifest.name} has an empty dist directory.`);
  let rawBytes = 0;
  let gzipBytes = 0;
  let jsRawBytes = 0;
  for (const file of files) {
    const contents = await readFile(file);
    rawBytes += contents.byteLength;
    gzipBytes += gzipSync(contents, { level: 9 }).byteLength;
    if (file.endsWith('.js')) jsRawBytes += contents.byteLength;
  }
  return {
    files: files.length,
    gzipBytes,
    name: manifest.name,
    rawBytes,
    runtimeJsRawBytes: jsRawBytes,
    version: manifest.version,
  };
}

async function loadRollup() {
  // Rollup is Vite's pinned build dependency in this workspace. Resolve through Vite so this audit
  // does not add a second bundler version or require network installation in the FA sandbox.
  const workspaceRequire = createRequire(path.join(root, 'apps/playground/package.json'));
  const viteRequire = createRequire(workspaceRequire.resolve('vite/package.json'));
  const rollupPath = viteRequire.resolve('rollup');
  return import(pathToFileURL(rollupPath).href);
}

async function treeShakingCheck(coreMeasurement) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'nachi-bundle-size-'));
  try {
    const entry = path.join(temporaryRoot, 'entry.mjs');
    const coreEntry = path.join(root, 'packages/core/dist/index.js');
    await writeFile(
      entry,
      `export { billboard, defineEffect } from ${JSON.stringify(coreEntry)};\n`,
      'utf8',
    );
    const { rollup, VERSION } = await loadRollup();
    const warnings = [];
    const build = await rollup({
      input: entry,
      onwarn(warning) {
        warnings.push(warning.message);
      },
      treeshake: { moduleSideEffects: false },
    });
    const generated = await build.generate({ compact: true, format: 'es' });
    await build.close();
    const chunk = generated.output.find((output) => output.type === 'chunk');
    if (!chunk) throw new Error('Rollup did not produce a JavaScript chunk.');
    const code = chunk.code;
    const forbiddenPatterns = [
      'defineGrid2D',
      'defineGrid3D',
      'defineNeighborGrid',
      'grid3d',
      'neighbor-grid',
      'neighborGrid',
      'pbdDistanceConstraint',
    ];
    const normalizedCode = code.toLowerCase();
    const symbolMatches = forbiddenPatterns.filter((symbol) =>
      normalizedCode.includes(symbol.toLowerCase()),
    );
    const rawBytes = Buffer.byteLength(code);
    const gzipBytes = gzipSync(code, { level: 9 }).byteLength;
    const reductionPercent = Number(
      ((1 - rawBytes / coreMeasurement.runtimeJsRawBytes) * 100).toFixed(1),
    );
    return {
      bundler: `rollup@${VERSION}`,
      entryImports: ['defineEffect', 'billboard'],
      gzipBytes,
      passed: symbolMatches.length === 0 && rawBytes < coreMeasurement.runtimeJsRawBytes,
      rawBytes,
      referenceCoreRuntimeJsRawBytes: coreMeasurement.runtimeJsRawBytes,
      reductionPercent,
      symbolMatches,
      warnings,
    };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function kibibytes(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function markdown(report) {
  const rows = report.packages
    .map(
      (entry) =>
        `| \`${entry.name}\` | ${entry.files} | ${entry.rawBytes} (${kibibytes(entry.rawBytes)}) | ${entry.gzipBytes} (${kibibytes(entry.gzipBytes)}) |`,
    )
    .join('\n');
  const shaking = report.treeShaking;
  return `# Bundle size report

Generated by \`node tools/bundle-size.mjs\` from the checked-in package manifests and current
\`dist/\` outputs. Package raw size is the sum of every published build artifact under \`dist\`
(JavaScript and declarations); gzip size is the sum of each artifact compressed independently at
level 9. Numbers are evidence only—the FA coordinator owns budget judgment.

## Public package build artifacts

| Package | Files | Raw | Gzip |
|---|---:|---:|---:|
${rows}

**Total:** ${report.totals.files} files, ${report.totals.rawBytes} bytes
(${kibibytes(report.totals.rawBytes)}) raw, ${report.totals.gzipBytes} bytes
(${kibibytes(report.totals.gzipBytes)}) gzip.

## Tree-shaking probe

- Bundler: \`${shaking.bundler}\`
- Entry imports: \`defineEffect\` and \`billboard\` only from \`@nachi/core\`
- Minimal bundle: ${shaking.rawBytes} bytes (${kibibytes(shaking.rawBytes)}) raw;
  ${shaking.gzipBytes} bytes (${kibibytes(shaking.gzipBytes)}) gzip
- Core runtime-JS reference: ${shaking.referenceCoreRuntimeJsRawBytes} bytes
  (${kibibytes(shaking.referenceCoreRuntimeJsRawBytes)}); reduction ${shaking.reductionPercent}%
- Forbidden Grid2D/Grid3D/neighbor/PBD symbol matches: ${
    shaking.symbolMatches.length === 0
      ? 'none'
      : shaking.symbolMatches.map((symbol) => `\`${symbol}\``).join(', ')
  }
- Result: **${shaking.passed ? 'PASS' : 'FAIL'}**

The probe combines a size reduction against all core runtime JavaScript with symbol searching; it
does not infer tree-shaking from \`sideEffects: false\` alone. Machine-readable evidence is in
[bundle-report.json](./bundle-report.json).
`;
}

const packages = await Promise.all((await publicPackages()).map(measurePackage));
const core = packages.find((entry) => entry.name === '@nachi/core');
if (!core) throw new Error('The @nachi/core public package was not found.');
const report = {
  methodologyVersion: 1,
  packages,
  totals: {
    files: packages.reduce((total, entry) => total + entry.files, 0),
    gzipBytes: packages.reduce((total, entry) => total + entry.gzipBytes, 0),
    rawBytes: packages.reduce((total, entry) => total + entry.rawBytes, 0),
  },
  treeShaking: await treeShakingCheck(core),
};

await writeFile(
  jsonPath,
  await prettier.format(JSON.stringify(report, null, 2), { parser: 'json' }),
  'utf8',
);
await writeFile(
  markdownPath,
  await prettier.format(markdown(report), { parser: 'markdown' }),
  'utf8',
);
console.log(`Wrote ${path.relative(root, jsonPath)} and ${path.relative(root, markdownPath)}.`);
if (!report.treeShaking.passed) process.exitCode = 1;
