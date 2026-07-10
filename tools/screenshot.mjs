import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

const DEFAULT_URL = 'http://127.0.0.1:5173';
const DEFAULT_OUTPUT_PATH = 'artifacts/playground.png';
const VALID_BACKENDS = new Set(['webgl', 'webgpu']);

function parseArguments(arguments_) {
  const positional = [];
  let backendOption;
  let compareDepthFade = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === '--backend') {
      backendOption = arguments_[index + 1];
      index += 1;
    } else if (argument?.startsWith('--backend=')) {
      backendOption = argument.slice('--backend='.length);
    } else if (argument === '--compare-depth-fade') {
      compareDepthFade = true;
    } else if (argument?.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (argument !== undefined) {
      positional.push(argument);
    }
  }

  if (positional.length > 2) {
    throw new Error(
      'Usage: node tools/screenshot.mjs [url] [output-path] [--backend webgl|webgpu] [--compare-depth-fade]',
    );
  }

  const targetUrl = new URL(positional[0] ?? DEFAULT_URL);
  const urlBackend = targetUrl.searchParams.get('backend')?.toLowerCase();
  const backend = backendOption?.toLowerCase() ?? urlBackend ?? 'webgl';

  if (!VALID_BACKENDS.has(backend)) {
    throw new Error(`Invalid backend "${backend}". Expected webgl or webgpu.`);
  }

  targetUrl.searchParams.set('backend', backend);
  if (compareDepthFade) {
    targetUrl.searchParams.set('fade', '1');
    targetUrl.searchParams.set('static', '1');
  }

  return {
    backend,
    compareDepthFade,
    outputPath: path.resolve(positional[1] ?? DEFAULT_OUTPUT_PATH),
    url: targetUrl.toString(),
  };
}

const diagnostics = {
  console: [],
  pageErrors: [],
};
let browser;
let pixelCheck;
let depthFadeComparison;
let harnessState;
let target = {
  backend: 'webgl',
  compareDepthFade: false,
  outputPath: path.resolve(DEFAULT_OUTPUT_PATH),
  url: `${DEFAULT_URL}/?backend=webgl`,
};
let outcome;

try {
  target = parseArguments(process.argv.slice(2));
  await mkdir(path.dirname(target.outputPath), { recursive: true });

  browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-unsafe-webgpu',
      '--use-webgpu-adapter=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
    timeout: 60_000,
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (message) => {
    diagnostics.console.push({
      text: message.text(),
      type: message.type(),
    });
  });
  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(error.message);
  });

  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('canvas', { state: 'visible' });
  await page.waitForFunction(
    () => {
      const { rendererStatus, sceneReady } = document.documentElement.dataset;
      return sceneReady === 'true' || rendererStatus === 'device-lost';
    },
    null,
    { timeout: 60_000 },
  );

  const readHarnessState = () =>
    page.evaluate(() => ({
      backend: document.documentElement.dataset.backend ?? null,
      deviceLostMessage: document.documentElement.dataset.deviceLostMessage ?? null,
      deviceLostReason: document.documentElement.dataset.deviceLostReason ?? null,
      rendererStatus: document.documentElement.dataset.rendererStatus ?? null,
      sceneReady: document.documentElement.dataset.sceneReady ?? null,
    }));

  harnessState = await readHarnessState();
  if (harnessState.rendererStatus === 'device-lost') {
    throw new Error(
      `Renderer device lost: ${harnessState.deviceLostReason ?? 'unknown'} ${harnessState.deviceLostMessage ?? ''}`.trim(),
    );
  }

  const expectedBackend = target.backend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  if (harnessState.backend !== expectedBackend) {
    throw new Error(
      `Backend mismatch: requested ${expectedBackend}, active ${harnessState.backend ?? 'unknown'}.`,
    );
  }

  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  await page.waitForTimeout(750);

  harnessState = await readHarnessState();
  if (harnessState.rendererStatus === 'device-lost') {
    throw new Error(
      `Renderer device lost: ${harnessState.deviceLostReason ?? 'unknown'} ${harnessState.deviceLostMessage ?? ''}`.trim(),
    );
  }

  const png = await page.screenshot({ path: target.outputPath, type: 'png' });
  pixelCheck = await page.evaluate(
    async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();

      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Unable to create screenshot verification canvas.');
      context.drawImage(image, 0, 0);

      const region = {
        x: Math.floor(image.width * 0.25),
        y: Math.floor(image.height * 0.2),
        width: Math.floor(image.width * 0.5),
        height: Math.floor(image.height * 0.6),
      };
      const pixels = context.getImageData(region.x, region.y, region.width, region.height).data;
      let minLuminance = 255;
      let maxLuminance = 0;
      let foregroundPixels = 0;
      const sampledPixels = pixels.length / 4;

      for (let offset = 0; offset < pixels.length; offset += 4) {
        const luminance =
          (pixels[offset] ?? 0) * 0.2126 +
          (pixels[offset + 1] ?? 0) * 0.7152 +
          (pixels[offset + 2] ?? 0) * 0.0722;
        minLuminance = Math.min(minLuminance, luminance);
        maxLuminance = Math.max(maxLuminance, luminance);
        if (luminance > 28) foregroundPixels += 1;
      }

      const foregroundRatio = foregroundPixels / sampledPixels;
      return {
        ok: maxLuminance - minLuminance > 30 && foregroundRatio > 0.01,
        sampledPixels,
        minLuminance: Number(minLuminance.toFixed(2)),
        maxLuminance: Number(maxLuminance.toFixed(2)),
        foregroundRatio: Number(foregroundRatio.toFixed(4)),
      };
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );

  if (!pixelCheck.ok) {
    throw new Error(`Screenshot pixel verification failed: ${JSON.stringify(pixelCheck)}`);
  }

  if (target.compareDepthFade) {
    if (target.backend !== 'webgl') {
      throw new Error('Depth-fade screenshot comparison requires --backend webgl.');
    }

    await page.evaluate(() => {
      document.documentElement.dataset.depthFade = 'off';
    });
    await page.waitForFunction(
      () => document.documentElement.dataset.depthFadeApplied === 'false',
      null,
      { timeout: 10_000 },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );

    const extension = path.extname(target.outputPath);
    const outputBase = extension
      ? target.outputPath.slice(0, -extension.length)
      : target.outputPath;
    const comparisonPath = `${outputBase}-no-fade${extension || '.png'}`;
    const noFadePng = await page.screenshot({ path: comparisonPath, type: 'png' });
    depthFadeComparison = await page.evaluate(
      async ({ fadeSource, noFadeSource }) => {
        const decode = async (source) => {
          const image = new Image();
          image.src = source;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('Unable to create depth comparison canvas.');
          context.drawImage(image, 0, 0);
          return { context, width: image.width, height: image.height };
        };

        const fade = await decode(fadeSource);
        const noFade = await decode(noFadeSource);
        const region = {
          x: Math.floor(fade.width * 0.28),
          y: Math.floor(fade.height * 0.24),
          width: Math.floor(fade.width * 0.44),
          height: Math.floor(fade.height * 0.58),
        };
        const fadePixels = fade.context.getImageData(
          region.x,
          region.y,
          region.width,
          region.height,
        ).data;
        const noFadePixels = noFade.context.getImageData(
          region.x,
          region.y,
          region.width,
          region.height,
        ).data;
        let totalDifference = 0;
        let changedPixels = 0;
        const pixelCount = fadePixels.length / 4;

        for (let offset = 0; offset < fadePixels.length; offset += 4) {
          const difference =
            (Math.abs((fadePixels[offset] ?? 0) - (noFadePixels[offset] ?? 0)) +
              Math.abs((fadePixels[offset + 1] ?? 0) - (noFadePixels[offset + 1] ?? 0)) +
              Math.abs((fadePixels[offset + 2] ?? 0) - (noFadePixels[offset + 2] ?? 0))) /
            3;
          totalDifference += difference;
          if (difference > 8) changedPixels += 1;
        }

        const meanAbsoluteDifference = totalDifference / pixelCount;
        const changedPixelRatio = changedPixels / pixelCount;
        return {
          changedPixelRatio: Number(changedPixelRatio.toFixed(5)),
          comparisonPath: null,
          meanAbsoluteDifference: Number(meanAbsoluteDifference.toFixed(3)),
          ok: meanAbsoluteDifference > 1 && changedPixelRatio > 0.01,
          sampledPixels: pixelCount,
        };
      },
      {
        fadeSource: `data:image/png;base64,${png.toString('base64')}`,
        noFadeSource: `data:image/png;base64,${noFadePng.toString('base64')}`,
      },
    );
    depthFadeComparison.comparisonPath = comparisonPath;
    if (!depthFadeComparison.ok) {
      throw new Error(`Depth-fade pixel comparison failed: ${JSON.stringify(depthFadeComparison)}`);
    }
  }

  outcome = {
    ok: true,
    url: target.url,
    outputPath: target.outputPath,
    backend: harnessState.backend,
    pixelCheck,
    depthFadeComparison,
    diagnostics,
  };
} catch (error) {
  outcome = {
    ok: false,
    url: target.url,
    outputPath: target.outputPath,
    requestedBackend: target.backend,
    error: error instanceof Error ? error.message : String(error),
    harnessState,
    pixelCheck,
    depthFadeComparison,
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
