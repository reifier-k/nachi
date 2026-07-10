import { chromium } from 'playwright';

const DEFAULT_URL = 'http://127.0.0.1:5173/spike-compute/';
const ADAPTER_FLAGS = {
  default: [],
  swiftshader: ['--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader'],
  vulkan: ['--enable-features=Vulkan'],
};

function parseArguments(arguments_) {
  const positional = [];
  let adapter = 'swiftshader';

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--adapter') {
      adapter = arguments_[index + 1];
      index += 1;
    } else if (argument?.startsWith('--adapter=')) {
      adapter = argument.slice('--adapter='.length);
    } else if (argument?.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (argument !== undefined) {
      positional.push(argument);
    }
  }

  if (positional.length > 1 || !Object.hasOwn(ADAPTER_FLAGS, adapter)) {
    throw new Error(
      'Usage: node tools/spike-runner.mjs [url] [--adapter swiftshader|vulkan|default]',
    );
  }

  const url = new URL(positional[0] ?? DEFAULT_URL);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The spike runner requires a real HTTP(S) URL.');
  }
  url.searchParams.set('headless', '1');

  return { adapter, url: url.toString() };
}

const diagnostics = { console: [], pageErrors: [] };
let browser;
let target = { adapter: 'swiftshader', url: `${DEFAULT_URL}?headless=1` };
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
  page.on('console', (message) => {
    diagnostics.console.push({ type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(error.message);
  });

  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () =>
      ['complete', 'error', 'device-lost'].includes(
        document.documentElement.dataset.spikeStatus ?? '',
      ),
    null,
    { timeout: 180_000 },
  );

  const harnessState = await page.evaluate(() => ({
    backend: document.documentElement.dataset.backend ?? null,
    error: document.documentElement.dataset.spikeError ?? null,
    result: document.documentElement.dataset.spikeResult ?? null,
    status: document.documentElement.dataset.spikeStatus ?? null,
  }));
  if (!harnessState.result) {
    throw new Error(`Spike finished without data-spike-result (status=${harnessState.status}).`);
  }

  const result = JSON.parse(harnessState.result);
  outcome = {
    ...result,
    ok:
      harnessState.status === 'complete' &&
      result.ok === true &&
      result.computeOk === true &&
      result.atomicOk === true &&
      result.indirectOk === true,
    url: target.url,
    requestedAdapter: target.adapter,
    backend: harnessState.backend,
    diagnostics,
  };

  if (!outcome.ok && !outcome.error) {
    outcome.error = harnessState.error ?? `Spike ended with status ${harnessState.status}.`;
  }
} catch (error) {
  outcome = {
    ok: false,
    computeOk: false,
    atomicOk: false,
    indirectOk: false,
    url: target.url,
    requestedAdapter: target.adapter,
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
