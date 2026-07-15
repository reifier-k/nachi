import fs from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';

const roots = [
  'apps/playground/src',
  'apps/showcase/src',
  'packages/core/src',
  'packages/format/src',
  'packages/post/src',
  'packages/trails/src',
  'packages/mesh-fx/src',
  'packages/timeline/src',
];
const extensions = new Set(['.ts', '.tsx']);
const testFilePattern = /\.(?:test|spec)\.tsx?$/;
const factoryNames = new Set([
  'applyVat',
  'bloomPreset',
  'collideBox',
  'collidePlane',
  'collideSceneDepth',
  'collideSdf',
  'collideSphere',
  'curlNoise',
  'drag',
  'gravity',
  'intensityOverLife',
  'killVolume',
  'lifetime',
  'lightIntensity',
  'linearForce',
  'pointAttractor',
  'positionSphere',
  'radialBlur',
  'ribbon',
  'ribbonId',
  'rotationOverLife',
  'screenDistortion',
  'sizeOverLife',
  'turbulence',
  'vectorField',
  'velocityCone',
  'velocityMeshNormal',
  'velocityOverLife',
  'vortex',
]);
const mutationNames = new Set(['attachTo', 'setTransform', 'spawn']);
const categories = new Map(
  ['factory', 'compile', 'load', 'directConstructor', 'runtimeMutation', 'diagnosticOptOut'].map(
    (name) => [name, { expressions: 0, files: new Set() }],
  ),
);
const optOuts = new Map(
  ['onBuildDiagnostic', 'onRuntimeDiagnostic'].map((name) => [
    name,
    { expressions: 0, files: new Set() },
  ]),
);

function record(category, file) {
  const result = categories.get(category);
  result.expressions += 1;
  result.files.add(file);
}

function recordOptOut(name, file) {
  record('diagnosticOptOut', file);
  const result = optOuts.get(name);
  result.expressions += 1;
  result.files.add(file);
}

async function sourceFiles(directory) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'generated') continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await sourceFiles(candidate)));
    else if (
      extensions.has(path.extname(entry.name)) &&
      !testFilePattern.test(entry.name) &&
      !entry.name.endsWith('.generated.ts') &&
      !entry.name.endsWith('.generated.tsx')
    ) {
      output.push(candidate);
    }
  }
  return output;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

for (const file of (await Promise.all(roots.map(sourceFiles))).flat().sort()) {
  const source = ts.createSourceFile(
    file,
    await fs.readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        if (factoryNames.has(node.expression.text)) record('factory', file);
        else if (node.expression.text === 'compileEmitter') record('compile', file);
        else if (node.expression.text === 'loadEffect') record('load', file);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        mutationNames.has(node.expression.name.text)
      ) {
        record('runtimeMutation', file);
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (
        name.endsWith('VFXSystem') ||
        name === 'PostPipeline' ||
        name === 'TimelineEffectInstance'
      ) {
        record('directConstructor', file);
      }
    } else if (
      ts.isPropertyAssignment(node) &&
      node.initializer.kind === ts.SyntaxKind.NullKeyword
    ) {
      const name = propertyName(node.name);
      if (name === 'onBuildDiagnostic' || name === 'onRuntimeDiagnostic') recordOptOut(name, file);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function serialize(entries) {
  return Object.fromEntries(
    [...entries].map(([name, result]) => [
      name,
      { expressions: result.expressions, files: result.files.size },
    ]),
  );
}

console.log(
  JSON.stringify(
    {
      categories: serialize(categories),
      exclusions: [
        '*.test.ts(x) and *.spec.ts(x)',
        'docs',
        'dist',
        'node_modules',
        'generated directories/files',
      ],
      extensions: [...extensions],
      optOuts: serialize(optOuts),
      roots,
    },
    null,
    2,
  ),
);
