# Releasing `@nachi-vfx/*`

This repository publishes nine public packages under the `nachi-vfx` npm organization. Releases
use Changesets and are intentionally split into versioning and publishing so that publishing always
requires an explicit maintainer action.

## Release sequence

1. Merge package changes and their Changesets into `main`.
2. The `Version Packages` workflow creates or updates a release pull request.
3. Review the generated versions, changelogs, package contents, and green checks, then merge it.
4. Run the `Publish Packages` workflow from the `main` branch. The workflow validates the workspace,
   publishes versions that are not yet on npm, creates provenance attestations, and creates the
   corresponding GitHub releases.

Never run `pnpm release` merely as a check: unlike `pnpm release:dry`, it performs a real publish
when valid npm credentials are available.

## One-time first publish

Trusted publishing can only be configured after a package exists on npm. The initial publish
therefore needs a short-lived granular npm access token:

1. Enable 2FA on the npm account that owns the `nachi-vfx` organization.
2. Create a granular access token with package/scope read-write access limited to `@nachi-vfx`,
   enable **Bypass 2FA**, and choose the shortest practical expiration.
3. Add it as an `NPM_TOKEN` secret in the GitHub `npm` environment. Never put the value in a file,
   commit, issue, workflow input, or log.
4. Merge the initial version PR and manually run `Publish Packages` on `main`.

The public package names are:

- `@nachi-vfx/core`
- `@nachi-vfx/format`
- `@nachi-vfx/mesh-fx`
- `@nachi-vfx/post`
- `@nachi-vfx/react`
- `@nachi-vfx/three`
- `@nachi-vfx/timeline`
- `@nachi-vfx/trails`
- `@nachi-vfx/tsl-kit`

## Move to token-free trusted publishing

After the initial publish, configure the Trusted Publisher in the settings of every package:

- Provider: GitHub Actions
- GitHub organization or user: `reifier-k`
- Repository: `nachi`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

Then run `Publish Packages` for a later release to verify OIDC publishing. Once verified, delete the
GitHub `NPM_TOKEN` environment secret, revoke the npm token, and set every package's publishing
access to require 2FA while disallowing tokens. The workflow's `id-token: write` permission and npm
11.5.1-or-newer requirement are already satisfied by the pinned Node.js 24 runner setup.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/), and
[granular access tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens/).
