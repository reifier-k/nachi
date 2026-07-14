import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const docsRoot = path.join(root, 'docs');
const jsonPath = path.join(docsRoot, 'bundle-report.json');
const markdownPath = path.join(docsRoot, 'bundle-report.md');
const budgetBytes = {
  consumerGzip: 105 * 1024,
  coreGzip: 121 * 1024,
};

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

async function consumerBundleMeasurements() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'nachi-consumer-bundle-'));
  try {
    const coreEntry = path.join(root, 'packages/core/dist/index.js');
    const threeEntry = path.join(root, 'packages/three/dist/index.js');
    const coreProbeEntry = path.join(temporaryRoot, 'core-entry.mjs');
    const consumerEntry = path.join(temporaryRoot, 'consumer-entry.mjs');
    await writeFile(coreProbeEntry, `export * from ${JSON.stringify(coreEntry)};\n`, 'utf8');
    await writeFile(
      consumerEntry,
      `import {
  VFXSystem,
  billboard,
  burst,
  defineEffect,
  defineEmitter,
  lifetime,
  positionSphere,
} from ${JSON.stringify(coreEntry)};
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeSpriteDraw,
} from ${JSON.stringify(threeEntry)};

export function createMinimalVfxApp(renderer, scene) {
  const adapter = createThreeKernelAdapter({ backend: 'webgpu' });
  const runtime = createThreeRuntimeRenderer(renderer, adapter);
  const system = new VFXSystem(runtime, scene);
  const effect = defineEffect({
    elements: {
      particles: defineEmitter({
        capacity: 128,
        init: [positionSphere({ radius: 0.1 }), lifetime(1)],
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 32 }),
      }),
    },
  });
  const instance = system.spawn(effect, { seed: 1 });
  const emitter = instance.getEmitter('particles');
  if (!emitter) throw new Error('Consumer emitter was not created.');
  const draw = materializeThreeSpriteDraw(emitter.program, emitter.kernels);
  scene.add(draw);
  return { draw, instance, system };
}
`,
      'utf8',
    );
    const { rollup, VERSION } = await loadRollup();
    const buildProbe = async (input) => {
      const warnings = [];
      const build = await rollup({
        external: (identifier) => identifier === 'three' || identifier.startsWith('three/'),
        input,
        onwarn(warning) {
          warnings.push(warning.message);
        },
        plugins: [
          {
            name: 'nachi-workspace-resolution',
            resolveId(identifier) {
              if (identifier === '@nachi-vfx/core') return coreEntry;
              if (identifier === '@nachi-vfx/three') return threeEntry;
              return null;
            },
          },
        ],
        treeshake: { moduleSideEffects: false },
      });
      const generated = await build.generate({ compact: true, format: 'es' });
      await build.close();
      const code = generated.output
        .filter((output) => output.type === 'chunk')
        .map((output) => output.code)
        .join('\n');
      return {
        gzipBytes: gzipSync(code, { level: 9 }).byteLength,
        rawBytes: Buffer.byteLength(code),
        warnings,
      };
    };
    const core = await buildProbe(coreProbeEntry);
    const consumer = await buildProbe(consumerEntry);
    return {
      bundler: `rollup@${VERSION}`,
      consumer: {
        ...consumer,
        budgetGzipBytes: budgetBytes.consumerGzip,
        passed: consumer.gzipBytes <= budgetBytes.consumerGzip,
        threeExternal: true,
      },
      core: {
        ...core,
        budgetGzipBytes: budgetBytes.coreGzip,
        passed: core.gzipBytes <= budgetBytes.coreGzip,
      },
      passed:
        consumer.gzipBytes <= budgetBytes.consumerGzip && core.gzipBytes <= budgetBytes.coreGzip,
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
  const consumer = report.consumerBundles;
  return `# Bundle size report

Generated by \`node tools/bundle-size.mjs\` from the checked-in package manifests and current
\`dist/\` outputs. Package raw size is the sum of every published build artifact under \`dist\`
(JavaScript and declarations); gzip size is the sum of each artifact compressed independently at
level 9.

## Public package build artifacts

| Package | Files | Raw | Gzip |
|---|---:|---:|---:|
${rows}

**Total:** ${report.totals.files} files, ${report.totals.rawBytes} bytes
(${kibibytes(report.totals.rawBytes)}) raw, ${report.totals.gzipBytes} bytes
(${kibibytes(report.totals.gzipBytes)}) gzip.

## Enforced consumer budgets

| Probe | Raw | Gzip | Budget (gzip) | Result |
|---|---:|---:|---:|---:|
| Core public runtime | ${consumer.core.rawBytes} (${kibibytes(consumer.core.rawBytes)}) | ${consumer.core.gzipBytes} (${kibibytes(consumer.core.gzipBytes)}) | ${consumer.core.budgetGzipBytes} (${kibibytes(consumer.core.budgetGzipBytes)}) | **${consumer.core.passed ? 'PASS' : 'FAIL'}** |
| Minimal consumer app | ${consumer.consumer.rawBytes} (${kibibytes(consumer.consumer.rawBytes)}) | ${consumer.consumer.gzipBytes} (${kibibytes(consumer.consumer.gzipBytes)}) | ${consumer.consumer.budgetGzipBytes} (${kibibytes(consumer.consumer.budgetGzipBytes)}) | **${consumer.consumer.passed ? 'PASS' : 'FAIL'}** |

The consumer probe bundles \`@nachi-vfx/core\`, \`@nachi-vfx/three\`, \`VFXSystem\`, a billboard emitter, the
Three runtime adapter, and the sprite materializer as a minimal working application. Three.js and
its subpaths are external, matching the exact \`three@0.185.1\` peer contract. The core probe exports
the complete core runtime surface. Both budgets are enforced by this tool and an overage exits
non-zero. Bundler: \`${consumer.bundler}\`.

## Tree-shaking probe

- Bundler: \`${shaking.bundler}\`
- Entry imports: \`defineEffect\` and \`billboard\` only from \`@nachi-vfx/core\`
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

## Headless performance limitation

Golden/performance probes in CI use Chromium WebGPU through SwiftShader. Those timings validate
that instrumentation runs and catch gross regressions on the same software adapter, but they are
not a real-GPU performance budget and cannot be compared across adapters, drivers, machines, or
browser builds. Hardware GPU acceptance requires a separately controlled benchmark environment.
`;
}

const packages = await Promise.all((await publicPackages()).map(measurePackage));
const core = packages.find((entry) => entry.name === '@nachi-vfx/core');
if (!core) throw new Error('The @nachi-vfx/core public package was not found.');
const consumerBundles = await consumerBundleMeasurements();
const report = {
  consumerBundles,
  methodologyVersion: 2,
  packages,
  totals: {
    files: packages.reduce((total, entry) => total + entry.files, 0),
    gzipBytes: packages.reduce((total, entry) => total + entry.gzipBytes, 0),
    rawBytes: packages.reduce((total, entry) => total + entry.rawBytes, 0),
  },
  treeShaking: await treeShakingCheck(core),
};

await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(markdownPath, markdown(report), 'utf8');
console.log(`Wrote ${path.relative(root, jsonPath)} and ${path.relative(root, markdownPath)}.`);
if (!report.treeShaking.passed || !report.consumerBundles.passed) process.exitCode = 1;
