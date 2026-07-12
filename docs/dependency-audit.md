# Dependency audit

## Coordinator production audit

The release coordinator measured the production dependency graph with the following reproducible
inputs:

- Executed at: `2026-07-12T08:47:34Z`
- Node.js: `v24.18.0`
- pnpm: `10.28.2`
- Audited lockfile SHA-256:
  `f4843cd86b9a4941cc1e9559c0c764243c7727ccb594f0a22e63e83f930878da`
- Command: `pnpm audit --prod`
- Result (exit 0): `No known vulnerabilities found`

This is the production release-gate result. It is tied to the exact lockfile digest above rather
than to a floating registry view.

## Development-tool remediation

This FA batch raises the vulnerable development toolchain floors to `vitest@4.1.0`, `vite@7.3.5`
in both applications, and `esbuild@0.28.1`. The root pnpm override also forces Vite/Vitest's
transitive esbuild to `0.28.1`, so an older vulnerable copy cannot remain in the resolved graph.

The FA sandbox could not resolve `registry.npmjs.org` (`EAI_AGAIN`) while regenerating the lockfile.
The lockfile was nevertheless regenerated from pnpm's cached official package metadata; its new
SHA-256 is `9288bcf8c97e27593360afc7fd4d8329300777114a4ff55a5c7de659ca94ba4d`. The coordinator must run
`pnpm install` and the full `pnpm audit` against that exact graph. The required acceptance result is
exit 0 and `No known vulnerabilities found`.

## Install-script supply-chain policy

The root manifest declares `pnpm.onlyBuiltDependencies` with the minimal allowlist `esbuild`.
Dependency install scripts are denied unless explicitly reviewed and added to that list. Esbuild is
allowed because its platform binary installation is required by the Vite build toolchain; no other
current dependency needs install-time code execution. The same manifest overrides every esbuild
edge to the reviewed `0.28.1` release.

## Re-audit procedure

From a clean, network-enabled checkout:

```sh
node --version
pnpm --version
sha256sum pnpm-lock.yaml
pnpm install --frozen-lockfile
pnpm audit --prod
pnpm audit
pnpm ignored-builds
node tools/license-report.mjs
```

Confirm the recorded Node/pnpm versions, retain both audit outputs, and verify that
`pnpm ignored-builds` reports no required package outside the reviewed allowlist. Do not use
`pnpm audit --fix` blindly: dependency, peer-range, and override changes require normal review and
a changeset when they alter a published contract.

License compatibility is independently reproducible offline with
`node tools/license-report.mjs`; see [license-report.md](./license-report.md).
