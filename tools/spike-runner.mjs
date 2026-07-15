import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateBrowserDiagnostics,
  validatePerformanceSnapshot,
  validateScreenshotUpdateEligibility,
  validateScreenshotRegions,
  screenshotRegionResultsOk,
} from './verification-contract.mjs';

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CURRENT_WORKING_DIRECTORY = path.resolve(process.cwd());
if (CURRENT_WORKING_DIRECTORY !== REPOSITORY_ROOT) {
  throw new Error(
    `spike-runner must be started from the repository root (${REPOSITORY_ROOT}); current cwd is ${CURRENT_WORKING_DIRECTORY}. Relative artifacts and --dist directory resolution depend on the root cwd.`,
  );
}

const { chromium } = await import('playwright');

const DEFAULT_URL = 'http://127.0.0.1:5173/spike-compute/';
const DEFAULT_BASELINE_DIRECTORY = path.join(REPOSITORY_ROOT, 'tools', 'baselines');
const ADAPTER_FLAGS = {
  default: [],
  swiftshader: ['--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader'],
  vulkan: ['--enable-features=Vulkan'],
};

function parseArguments(arguments_) {
  const positional = [];
  let adapter = 'swiftshader';
  let baselineDirectory = DEFAULT_BASELINE_DIRECTORY;
  let distDirectory;
  let updateScreenshots = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--adapter') {
      adapter = arguments_[index + 1];
      index += 1;
    } else if (argument?.startsWith('--adapter=')) {
      adapter = argument.slice('--adapter='.length);
    } else if (argument === '--update-screenshots') {
      updateScreenshots = true;
    } else if (argument === '--baseline-dir') {
      baselineDirectory = path.resolve(arguments_[index + 1]);
      index += 1;
    } else if (argument?.startsWith('--baseline-dir=')) {
      baselineDirectory = path.resolve(argument.slice('--baseline-dir='.length));
    } else if (argument === '--dist') {
      distDirectory = arguments_[index + 1];
      index += 1;
    } else if (argument?.startsWith('--dist=')) {
      distDirectory = argument.slice('--dist='.length);
    } else if (argument?.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (argument !== undefined) {
      positional.push(argument);
    }
  }

  if (positional.length > 1 || !Object.hasOwn(ADAPTER_FLAGS, adapter)) {
    throw new Error(
      'Usage: node tools/spike-runner.mjs [url] [--adapter swiftshader|vulkan|default] [--dist directory] [--baseline-dir directory] [--update-screenshots]',
    );
  }

  const url = new URL(positional[0] ?? DEFAULT_URL);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The spike runner requires a real HTTP(S) URL.');
  }
  url.searchParams.set('headless', '1');

  if (distDirectory !== undefined && distDirectory.length === 0) {
    throw new Error('--dist requires a directory.');
  }
  return {
    adapter,
    baselineDirectory,
    ...(distDirectory === undefined ? {} : { distDirectory: path.resolve(distDirectory) }),
    updateScreenshots,
    url: url.toString(),
  };
}

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

async function installDistRoute(page, origin, directory) {
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (url.pathname.endsWith('/')) relative = path.join(relative, 'index.html');
    const filename = path.resolve(directory, relative);
    if (!filename.startsWith(`${directory}${path.sep}`) && filename !== directory) {
      await route.fulfill({ body: 'Forbidden', status: 403 });
      return;
    }
    try {
      const body = await readFile(filename);
      await route.fulfill({
        body,
        contentType: CONTENT_TYPES[path.extname(filename)] ?? 'application/octet-stream',
        status: 200,
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await route.fulfill({ body: 'Not found', status: 404 });
    }
  });
}

async function comparePngPixels(page, baseline, actual, regions) {
  return page.evaluate(
    async ({ actualBase64, baselineBase64, specifications }) => {
      const decode = async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Could not create screenshot comparison context.');
        context.drawImage(image, 0, 0);
        return {
          data: context.getImageData(0, 0, canvas.width, canvas.height).data,
          height: canvas.height,
          width: canvas.width,
        };
      };
      const left = await decode(baselineBase64);
      const right = await decode(actualBase64);
      if (left.width !== right.width || left.height !== right.height) {
        return {
          changedPixelRatio: 1,
          changedPixels: Math.max(left.data.length, right.data.length) / 4,
          dimensionsMatch: false,
          pixelCount: Math.max(left.data.length, right.data.length) / 4,
          regionChanges: specifications.map((specification) => ({
            changedPixelRatio: 1,
            changedPixels: null,
            maximumChangedPixelRatio: specification.maximumChangedPixelRatio ?? null,
            name: specification.name,
            ok: false,
            pixelCount: null,
          })),
        };
      }
      let changedPixels = 0;
      for (let offset = 0; offset < left.data.length; offset += 4) {
        if (
          left.data[offset] !== right.data[offset] ||
          left.data[offset + 1] !== right.data[offset + 1] ||
          left.data[offset + 2] !== right.data[offset + 2] ||
          left.data[offset + 3] !== right.data[offset + 3]
        ) {
          changedPixels += 1;
        }
      }
      const pixelCount = left.data.length / 4;
      const regionChanges = specifications.map((specification) => {
        const startX = Math.floor(specification.x * left.width);
        const startY = Math.floor(specification.y * left.height);
        const width = Math.max(1, Math.floor(specification.width * left.width));
        const height = Math.max(1, Math.floor(specification.height * left.height));
        let regionChangedPixels = 0;
        for (let y = startY; y < startY + height; y += 1) {
          for (let x = startX; x < startX + width; x += 1) {
            const offset = (y * left.width + x) * 4;
            if (
              left.data[offset] !== right.data[offset] ||
              left.data[offset + 1] !== right.data[offset + 1] ||
              left.data[offset + 2] !== right.data[offset + 2] ||
              left.data[offset + 3] !== right.data[offset + 3]
            ) {
              regionChangedPixels += 1;
            }
          }
        }
        const regionPixelCount = width * height;
        const changedPixelRatio = regionChangedPixels / regionPixelCount;
        const maximumChangedPixelRatio = specification.maximumChangedPixelRatio ?? null;
        return {
          changedPixelRatio,
          changedPixels: regionChangedPixels,
          maximumChangedPixelRatio,
          name: specification.name,
          ok: maximumChangedPixelRatio === null || changedPixelRatio < maximumChangedPixelRatio,
          pixelCount: regionPixelCount,
        };
      });
      return {
        changedPixelRatio: changedPixels / pixelCount,
        changedPixels,
        dimensionsMatch: true,
        pixelCount,
        regionChanges,
      };
    },
    {
      actualBase64: actual.toString('base64'),
      baselineBase64: baseline.toString('base64'),
      specifications: regions,
    },
  );
}

async function measurePngRegions(page, png, regions) {
  return page.evaluate(
    async ({ pngBase64, specifications }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${pngBase64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Could not create screenshot region context.');
      context.drawImage(image, 0, 0);
      return specifications.map((specification) => {
        const x = Math.floor(specification.x * canvas.width);
        const y = Math.floor(specification.y * canvas.height);
        const width = Math.max(1, Math.floor(specification.width * canvas.width));
        const height = Math.max(1, Math.floor(specification.height * canvas.height));
        const pixels = context.getImageData(x, y, width, height).data;
        let foregroundPixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const luminance =
            (pixels[offset] ?? 0) * 0.2126 +
            (pixels[offset + 1] ?? 0) * 0.7152 +
            (pixels[offset + 2] ?? 0) * 0.0722;
          if (luminance > specification.luminanceThreshold) foregroundPixels += 1;
        }
        return {
          ...specification,
          foregroundPixels,
          ok: foregroundPixels >= specification.minimumForegroundPixels,
          pixelCount: pixels.length / 4,
        };
      });
    },
    { pngBase64: png.toString('base64'), specifications: regions },
  );
}

async function commitScreenshotBaselineTransaction(updates) {
  if (updates.length === 0) return;
  const transactionId = `${process.pid}-${Date.now()}`;
  const entries = updates.map((update, index) => ({
    ...update,
    backedUp: false,
    backupPath: `${update.baselinePath}.${transactionId}-${index}.bak`,
    installed: false,
    stagedPath: `${update.baselinePath}.${transactionId}-${index}.tmp`,
  }));
  try {
    for (const entry of entries) {
      await mkdir(path.dirname(entry.baselinePath), { recursive: true });
      await writeFile(entry.stagedPath, entry.actual);
    }
    for (const entry of entries) {
      if (entry.baseline !== undefined) {
        await rename(entry.baselinePath, entry.backupPath);
        entry.backedUp = true;
      }
      await rename(entry.stagedPath, entry.baselinePath);
      entry.installed = true;
    }
  } catch (error) {
    for (const entry of [...entries].reverse()) {
      if (entry.installed) await rm(entry.baselinePath, { force: true }).catch(() => undefined);
      if (entry.backedUp) {
        await rename(entry.backupPath, entry.baselinePath).catch(() => undefined);
      }
      await rm(entry.stagedPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
  await Promise.all(
    entries
      .filter(({ backedUp }) => backedUp)
      .map(({ backupPath }) => rm(backupPath, { force: true }).catch(() => undefined)),
  );
}

const diagnostics = { console: [], pageErrors: [] };
let browser;
let webgpuAdapterInfo;
let target = {
  adapter: 'swiftshader',
  baselineDirectory: DEFAULT_BASELINE_DIRECTORY,
  updateScreenshots: false,
  url: `${DEFAULT_URL}?headless=1`,
};
let outcome;

try {
  target = parseArguments(process.argv.slice(2));
  browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-webgpu', ...ADAPTER_FLAGS[target.adapter]],
    timeout: 60_000,
  });

  const page = await browser.newPage();
  if (target.distDirectory) {
    const targetUrl = new URL(target.url);
    await installDistRoute(page, targetUrl.origin, target.distDirectory);
  }
  page.on('console', (message) => {
    diagnostics.console.push({ type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(error.message);
  });

  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  webgpuAdapterInfo = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const { architecture, description, device, vendor } = adapter.info;
    return { architecture, description, device, vendor };
  });
  await page.waitForFunction(
    () =>
      ['complete', 'error', 'device-lost'].includes(
        document.documentElement.dataset.spikeStatus ?? '',
      ),
    null,
    { timeout: 180_000 },
  );

  const harnessState = await page.evaluate(() => ({
    artifactScreenshots: document.documentElement.dataset.artifactScreenshots ?? null,
    backend: document.documentElement.dataset.backend ?? null,
    error: document.documentElement.dataset.spikeError ?? null,
    expectedDiagnostics: document.documentElement.dataset.expectedDiagnostics ?? null,
    result: document.documentElement.dataset.spikeResult ?? null,
    performance: document.documentElement.dataset.perfResult ?? null,
    status: document.documentElement.dataset.spikeStatus ?? null,
  }));
  if (!harnessState.result) {
    throw new Error(`Spike finished without data-spike-result (status=${harnessState.status}).`);
  }

  const result = JSON.parse(harnessState.result);
  const artifactScreenshots = {};
  const screenshotBaselines = {};
  const screenshotComparisons = {};
  const screenshotUpdates = [];
  let screenshotsOk = true;
  if (harnessState.artifactScreenshots) {
    const specifications = JSON.parse(harnessState.artifactScreenshots);
    if (!Array.isArray(specifications)) {
      throw new Error('data-artifact-screenshots must contain a JSON array.');
    }
    const artifactDirectory = path.resolve('artifacts');
    await mkdir(artifactDirectory, { recursive: true });
    const screenshotFilenames = new Set();
    for (const specification of specifications) {
      const filename = specification?.filename;
      const selector = specification?.selector;
      if (
        typeof filename !== 'string' ||
        path.basename(filename) !== filename ||
        !/^[-A-Za-z0-9_.]+\.png$/.test(filename) ||
        typeof selector !== 'string' ||
        !selector.startsWith('#')
      ) {
        throw new Error(
          `Invalid artifact screenshot specification: ${JSON.stringify(specification)}`,
        );
      }
      if (screenshotFilenames.has(filename)) {
        throw new Error(`Duplicate artifact screenshot filename: ${filename}.`);
      }
      screenshotFilenames.add(filename);
      const outputPath = path.join(artifactDirectory, filename);
      const baselinePath = path.join(target.baselineDirectory, filename);
      const actual = await page.locator(selector).screenshot({ type: 'png' });
      const regions = validateScreenshotRegions(specification?.regions);
      const actualRegions = await measurePngRegions(page, actual, regions);
      const actualRegionsOk = actualRegions.every(({ ok }) => ok);
      let baseline;
      try {
        baseline = await readFile(baselinePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (baseline === undefined && !target.updateScreenshots) {
        throw new Error(
          `Screenshot baseline is missing: ${path.relative(REPOSITORY_ROOT, baselinePath)}. Recreate it explicitly with --update-screenshots.`,
        );
      }
      await writeFile(outputPath, actual);
      if (target.updateScreenshots) {
        screenshotComparisons[filename] = {
          baseline: 'unchanged',
          committed: false,
          ok: actualRegionsOk,
          regions: actualRegions,
          threshold: specification.threshold ?? 0.005,
        };
        screenshotsOk &&= actualRegionsOk;
        screenshotUpdates.push({ actual, baseline, baselinePath, filename });
      } else {
        const comparison = await comparePngPixels(page, baseline, actual, regions);
        const baselineRegions = await measurePngRegions(page, baseline, regions);
        const threshold = specification.threshold ?? 0.005;
        const ok =
          comparison.dimensionsMatch &&
          comparison.changedPixelRatio < threshold &&
          screenshotRegionResultsOk(actualRegions, baselineRegions, comparison.regionChanges);
        screenshotComparisons[filename] = {
          ...comparison,
          actualRegions,
          baselineRegions,
          ok,
          threshold,
        };
        screenshotsOk &&= ok;
        if (!ok) {
          const actualPath = path.join(
            artifactDirectory,
            `${filename.slice(0, -'.png'.length)}-actual.png`,
          );
          await writeFile(actualPath, actual);
          screenshotComparisons[filename].actual = actualPath;
        }
      }
      artifactScreenshots[filename] = outputPath;
      screenshotBaselines[filename] = baselinePath;
    }
  }
  if (harnessState.status === 'complete' && !harnessState.performance) {
    throw new Error('Spike finished without data-perf-result.');
  }
  const performanceResult = harnessState.performance ? JSON.parse(harnessState.performance) : null;
  const performanceValidation = validatePerformanceSnapshot(performanceResult);
  const expectedDiagnostics = harnessState.expectedDiagnostics
    ? JSON.parse(harnessState.expectedDiagnostics)
    : [];
  const diagnosticValidation = validateBrowserDiagnostics(diagnostics, expectedDiagnostics);
  const runnerContractsOk = validateScreenshotUpdateEligibility({
    diagnosticOk: diagnosticValidation.ok,
    performanceOk: performanceValidation.ok,
    resultOk: result.ok,
    screenshotsOk,
    status: harnessState.status,
  });
  if (target.updateScreenshots && runnerContractsOk) {
    await commitScreenshotBaselineTransaction(screenshotUpdates);
    for (const { baseline, filename } of screenshotUpdates) {
      screenshotComparisons[filename].baseline = baseline === undefined ? 'created' : 'updated';
      screenshotComparisons[filename].committed = true;
    }
  }
  outcome = {
    ...result,
    ok: runnerContractsOk,
    url: target.url,
    requestedAdapter: target.adapter,
    webgpuAdapterInfo,
    backend: harnessState.backend,
    artifactScreenshots,
    screenshotBaselines,
    screenshotComparisons,
    performance: performanceResult,
    performanceValidation,
    diagnostics,
    diagnosticValidation,
  };

  if (!outcome.ok && !outcome.error) {
    const failedScreenshot = Object.entries(screenshotComparisons).find(
      ([, comparison]) => comparison.ok !== true,
    );
    outcome.error =
      harnessState.error ??
      (target.updateScreenshots && failedScreenshot
        ? `Refusing to update ${failedScreenshot[0]}: screenshot region validation failed (${JSON.stringify(failedScreenshot[1].regions)}).`
        : `Spike ended with status ${harnessState.status}.`);
  }
} catch (error) {
  outcome = {
    ok: false,
    computeOk: false,
    atomicOk: false,
    indirectOk: false,
    url: target.url,
    requestedAdapter: target.adapter,
    webgpuAdapterInfo,
    error: error instanceof Error ? error.message : String(error),
    diagnostics,
  };
} finally {
  try {
    await browser?.close();
  } catch (error) {
    diagnostics.pageErrors.push(
      `Browser close failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

process.stdout.write(`${JSON.stringify(outcome)}\n`);
process.exitCode = outcome.ok ? 0 : 1;
