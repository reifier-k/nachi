# Production dependency audit handoff

## Sandbox attempt

Command:

```sh
pnpm audit --prod
```

The FA preparation sandbox cannot resolve the npm registry. The attempt on 2026-07-12 reached the
audit endpoint and returned:

```text
WARN post https://registry.npmjs.org/-/npm/v1/security/audits error (EAI_AGAIN).
```

It was stopped before pnpm's network retries; no vulnerability result can be inferred from this
failure.

## Coordinator run

Run the same command from a network-enabled checkout with the committed `pnpm-lock.yaml` unchanged.
The expected release-gate result is exit code 0 and no known production vulnerability. If the
command reports a vulnerability, retain the complete advisory, affected dependency path, severity,
and chosen remediation/acceptance rationale in this file before FA judgment. Do not run
`pnpm audit --fix` blindly because dependency or peer-range changes require normal review and a
changeset.

License compatibility is independently reproducible offline with
`node tools/license-report.mjs`; see [license-report.md](./license-report.md).
