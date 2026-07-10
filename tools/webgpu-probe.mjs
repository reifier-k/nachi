import http from 'node:http';

import { chromium } from 'playwright';

const ADAPTER_FLAGS = {
  default: [],
  swiftshader: ['--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader'],
  vulkan: ['--enable-features=Vulkan'],
};

function parseAdapter(arguments_) {
  let adapter = 'swiftshader';

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === '--adapter') {
      adapter = arguments_[index + 1];
      index += 1;
    } else if (argument?.startsWith('--adapter=')) {
      adapter = argument.slice('--adapter='.length);
    } else {
      throw new Error('Usage: node tools/webgpu-probe.mjs [--adapter swiftshader|vulkan|default]');
    }
  }

  if (!(adapter in ADAPTER_FLAGS)) {
    throw new Error(`Invalid adapter "${adapter}". Expected swiftshader, vulkan, or default.`);
  }

  return adapter;
}

let browser;
let server;
let requestedAdapter = 'swiftshader';
let outcome = {
  ok: false,
  computeOk: false,
};

try {
  requestedAdapter = parseAdapter(process.argv.slice(2));
  const launchOptions = {
    channel: 'chromium',
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-webgpu', ...ADAPTER_FLAGS[requestedAdapter]],
    timeout: 60_000,
  };

  server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><title>WebGPU probe</title><body>probe</body></html>');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve probe server address.');
  }

  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });

  outcome = await page.evaluate(async () => {
    if (!navigator.gpu) {
      return {
        ok: false,
        computeOk: false,
        secureContext: window.isSecureContext,
        error: 'navigator.gpu is unavailable',
      };
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return {
        ok: false,
        computeOk: false,
        secureContext: window.isSecureContext,
        error: 'requestAdapter returned null',
      };
    }

    const device = await adapter.requestDevice();
    const valueCount = 256;
    const byteLength = valueCount * Float32Array.BYTES_PER_ELEMENT;
    const shaderModule = device.createShaderModule({
      code: `
        @group(0) @binding(0) var<storage, read_write> values: array<f32>;

        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3u) {
          if (id.x < arrayLength(&values)) {
            values[id.x] = f32(id.x) * 3.0 + 7.0;
          }
        }
      `,
    });
    const storageBuffer = device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readbackBuffer = device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: shaderModule, entryPoint: 'main' },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: storageBuffer } }],
    });
    const encoder = device.createCommandEncoder();
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(pipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(Math.ceil(valueCount / 64));
    computePass.end();
    encoder.copyBufferToBuffer(storageBuffer, 0, readbackBuffer, 0, byteLength);
    device.queue.submit([encoder.finish()]);

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readbackBuffer.getMappedRange()).slice();
    readbackBuffer.unmap();

    const computeOk = values.every((value, index) => value === index * 3 + 7);
    const adapterInfo = adapter.info;
    storageBuffer.destroy();
    readbackBuffer.destroy();
    device.destroy();

    return {
      ok: computeOk,
      computeOk,
      secureContext: window.isSecureContext,
      adapter: {
        vendor: adapterInfo.vendor,
        architecture: adapterInfo.architecture,
        device: adapterInfo.device,
        description: adapterInfo.description,
      },
      sample: [values[0], values[10], values[255]],
      expectedSample: [7, 37, 772],
    };
  });
  outcome.requestedAdapter = requestedAdapter;
} catch (error) {
  outcome = {
    ok: false,
    computeOk: false,
    requestedAdapter,
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  await browser?.close();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
}

process.stdout.write(`${JSON.stringify(outcome)}\n`);
process.exitCode = outcome.ok ? 0 : 1;
