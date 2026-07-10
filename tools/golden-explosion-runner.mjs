import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

const baseUrl = new URL(process.argv[2] ?? 'http://127.0.0.1:5173/golden-explosion/');
baseUrl.searchParams.set('headless', '1');
const outputDirectory = path.resolve(process.argv[3] ?? 'artifacts');
const diagnostics = { console: [], pageErrors: [] };
let browser;
let result;

try {
  await mkdir(outputDirectory, { recursive: true });
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
  const page = await browser.newPage({ viewport: { height: 256, width: 1000 } });
  page.on('console', (message) => {
    diagnostics.console.push({ text: message.text(), type: message.type() });
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  await page.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () =>
      ['complete', 'error', 'device-lost'].includes(
        document.documentElement.dataset.spikeStatus ?? '',
      ),
    null,
    { timeout: 180_000 },
  );
  const state = await page.evaluate(() => ({
    error: document.documentElement.dataset.spikeError ?? null,
    performance: document.documentElement.dataset.perfResult ?? null,
    result: document.documentElement.dataset.spikeResult ?? null,
    status: document.documentElement.dataset.spikeStatus ?? null,
  }));
  if (!state.result) throw new Error(`Golden explosion ended without a result (${state.status}).`);
  if (state.status === 'complete' && !state.performance) {
    throw new Error('Golden explosion completed without data-perf-result.');
  }
  const parsed = JSON.parse(state.result);
  if (state.status !== 'complete' || parsed.ok !== true) {
    throw new Error(state.error ?? `Golden explosion validation failed: ${state.result}`);
  }
  const screenshots = {};
  for (const phase of ['early', 'peak', 'late']) {
    const outputPath = path.join(outputDirectory, `golden-explosion-${phase}.png`);
    await page.locator(`#golden-${phase}`).screenshot({ path: outputPath, type: 'png' });
    screenshots[phase] = outputPath;
  }
  result = {
    ...parsed,
    diagnostics,
    ok: diagnostics.pageErrors.length === 0 && parsed.ok === true,
    performance: JSON.parse(state.performance),
    screenshots,
    url: baseUrl.toString(),
  };
} catch (error) {
  result = {
    diagnostics,
    error: error instanceof Error ? error.message : String(error),
    ok: false,
    url: baseUrl.toString(),
  };
} finally {
  await browser?.close().catch((error) => diagnostics.pageErrors.push(String(error)));
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
