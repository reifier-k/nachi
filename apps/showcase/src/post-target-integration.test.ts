import { readFileSync } from 'node:fs';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PAGES = ['beam', 'slash', 'barrier', 'machina', 'heal', 'ice'] as const;
const HELPER = 'updateWorldShockwaves(camera, post.controls, shockwaves);';

function validateFinalCameraProjection(source: string, page: string): string[] {
  const file = ts.createSourceFile(`${page}.ts`, source, ts.ScriptTarget.Latest, true);
  let step: ts.ArrowFunction | ts.FunctionExpression | undefined;
  const findStep = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'step' &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      step = node.initializer;
    }
    ts.forEachChild(node, findStep);
  };
  findStep(file);
  if (!step || !ts.isBlock(step.body)) return [`${page}: step function is missing`];

  const errors: string[] = [];
  const helpers: ts.CallExpression[] = [];
  const finalCameraWrites: ts.Node[] = [];
  const renderOrReturn: ts.Node[] = [];
  const visitStep = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(file);
      if (expression === 'updateWorldShockwaves') helpers.push(node);
      if (
        /^camera\.(?:position|rotation|quaternion)(?:\.|$)/.test(expression) ||
        /^camera\.(?:lookAt|updateMatrixWorld|updateProjectionMatrix)$/.test(expression) ||
        /(?:^|\.)setCamera$/.test(expression)
      ) {
        finalCameraWrites.push(node);
      }
      if (expression === 'post.render') renderOrReturn.push(node);
    } else if (ts.isBinaryExpression(node)) {
      const target = node.left.getText(file);
      if (/^camera\.(?:position|rotation|quaternion|fov|aspect)(?:\.|$)/.test(target)) {
        finalCameraWrites.push(node);
      }
    } else if (ts.isReturnStatement(node)) {
      renderOrReturn.push(node);
    }
    ts.forEachChild(node, visitStep);
  };
  visitStep(step.body);

  if (helpers.length !== 1) {
    errors.push(`${page}: step must contain exactly one world-shockwave refresh`);
    return errors;
  }
  const helper = helpers[0]!;
  for (const write of finalCameraWrites) {
    if (write.getStart(file) > helper.getStart(file)) {
      errors.push(`${page}: camera mutation/publication occurs after world-shockwave refresh`);
      break;
    }
  }
  for (const boundary of renderOrReturn) {
    if (boundary.getStart(file) < helper.getStart(file)) {
      errors.push(`${page}: render/return occurs before world-shockwave refresh`);
      break;
    }
  }
  return errors;
}

function removeHelper(source: string): string {
  return source.replace(
    new RegExp(`^\\s*${HELPER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'),
    '',
  );
}

describe('showcase post target integration', () => {
  for (const page of PAGES) {
    it(`${page} refreshes world shockwaves after its final frame camera mutation`, () => {
      const source = readFileSync(new URL(`./${page}.ts`, import.meta.url), 'utf8');
      expect(validateFinalCameraProjection(source, page)).toEqual([]);
      expect(source).not.toMatch(/\.project\(camera\)/);

      const beforeShake = removeHelper(source).replace(
        '    if (latestShake) {',
        `    ${HELPER}\n    if (latestShake) {`,
      );
      expect(validateFinalCameraProjection(beforeShake, page)).not.toEqual([]);

      const outsideStep = removeHelper(source);
      expect(validateFinalCameraProjection(outsideStep, page)).not.toEqual([]);

      const afterRender = removeHelper(source).replace(
        '        post.render();',
        `        post.render();\n        ${HELPER}`,
      );
      expect(validateFinalCameraProjection(afterRender, page)).not.toEqual([]);
    });
  }

  it('keeps the ice world-jitter implementation behind an isolated fault selector', () => {
    const source = readFileSync(new URL('./ice.ts', import.meta.url), 'utf8');
    expect(source).toContain("get('forceFailure') === 'ice-world-jitter'");
    expect(source).toContain(': iceSparkleInitModules)');
    expect(source).toContain('registerIceSparklePlacement(registry);');
    expect(source).not.toContain('localJitterNormalized: !legacyIceJitter');
  });
});
