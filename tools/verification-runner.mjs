import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suites = [
  {
    baseUrl: new URL(process.env.VERIFICATION_PLAYGROUND_BASE_URL ?? 'http://127.0.0.1:5173/'),
    name: 'playground',
    pages: [
      'm2-runtime',
      'm3-sprites',
      'm12-grid',
      'm10-sort',
      'm8-vat',
      'm7-ribbons',
      'm12-neighbors',
    ],
  },
  {
    baseUrl: new URL(process.env.VERIFICATION_SHOWCASE_BASE_URL ?? 'http://127.0.0.1:5174/'),
    name: 'showcase',
    pages: ['slash', 'heal', 'ice', 'beam', 'machina', 'barrier'],
  },
];
const runner = new URL('./spike-runner.mjs', import.meta.url);
const updateScreenshots = process.argv.slice(2).includes('--update-screenshots');
if (process.argv.length > (updateScreenshots ? 3 : 2)) {
  throw new Error('Usage: node tools/verification-runner.mjs [--update-screenshots]');
}

function run(page, baseUrl) {
  const url = new URL(`${page}/`, baseUrl);
  return new Promise((resolve) => {
    const arguments_ = [fileURLToPath(runner), url.toString(), '--adapter', 'swiftshader'];
    if (updateScreenshots) arguments_.push('--update-screenshots');
    const startedAt = performance.now();
    const child = spawn(process.execPath, arguments_, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      resolve({
        durationMs: Math.round(performance.now() - startedAt),
        error: error.message,
        ok: false,
      });
    });
    child.once('exit', (code, signal) => {
      let result;
      for (const line of stdout.trim().split('\n').reverse()) {
        try {
          result = JSON.parse(line);
          break;
        } catch {
          // Chromium may write diagnostics before spike-runner's final one-line JSON.
        }
      }
      resolve({
        ...(result ?? {
          error: `Runner produced invalid JSON (exit ${code ?? signal ?? 'unknown'}).`,
          stdout: stdout.trim(),
        }),
        durationMs: Math.round(performance.now() - startedAt),
        ok: code === 0 && result?.ok === true,
        ...(stderr.trim() === '' ? {} : { stderr: stderr.trim() }),
      });
    });
  });
}

const results = [];
for (const suite of suites) {
  for (const page of suite.pages) {
    process.stdout.write(`[verification:${suite.name}] ${page} ... `);
    const result = await run(page, suite.baseUrl);
    results.push({ ...result, page, suite: suite.name });
    console.log(
      result.ok
        ? `PASS (${(result.durationMs / 1000).toFixed(1)}s)`
        : `FAIL: ${result.error ?? 'validation failed'}`,
    );
  }
}

const failures = results.filter(({ ok }) => !ok);
console.log(
  JSON.stringify(
    {
      durations: Object.fromEntries(
        results.map(({ durationMs, page, suite }) => [`${suite}/${page}`, durationMs]),
      ),
      failed: failures.map(({ error, page, suite }) => ({
        error: error ?? 'validation failed',
        page,
        suite,
      })),
      passed: results.filter(({ ok }) => ok).map(({ page, suite }) => `${suite}/${page}`),
      total: results.length,
      totalDurationMs: results.reduce((sum, { durationMs }) => sum + durationMs, 0),
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
