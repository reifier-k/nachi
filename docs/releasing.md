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

## Trusted publishing

All nine current packages trust this GitHub Actions publisher:

- Provider: GitHub Actions
- GitHub organization or user: `reifier-k`
- Repository: `nachi`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

The workflow publishes with OIDC using its `id-token: write` permission. It intentionally does not
reference `NPM_TOKEN` or `NODE_AUTH_TOKEN`; npm exchanges the job's short-lived OIDC identity only
when `npm publish` runs. Trusted publishing also creates provenance attestations automatically.

## Bootstrapping a new package

Trusted publishing can only be configured after a package exists on npm. The initial publish
therefore needs a short-lived granular npm access token:

1. Enable 2FA on the npm account that owns the `nachi-vfx` organization.
2. Create a granular access token with package/scope read-write access limited to `@nachi-vfx`,
   enable **Bypass 2FA**, and choose the shortest practical expiration.
3. Add it as an `NPM_TOKEN` secret in the GitHub `npm` environment. Never put the value in a file,
   commit, issue, workflow input, or log.
4. Temporarily pass the secret to the publish command as both `NPM_TOKEN` and `NODE_AUTH_TOKEN`,
   merge the initial version PR, and manually run `Publish Packages` on `main`.
5. Configure the package's Trusted Publisher with the settings above, remove the token references
   from the workflow, delete the GitHub secret, and revoke the npm token.

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

The workflow's `id-token: write` permission and npm 11.5.1-or-newer requirement are satisfied by the
pinned Node.js 24 runner setup. OIDC authentication is exercised only when a previously unpublished
version is published; `npm whoami` does not test Trusted Publisher authentication.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/), and
[granular access tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens/).
