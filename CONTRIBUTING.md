# Contributing to nachi

> Language: English (this page) / [日本語](./CONTRIBUTING.ja.md)

Thank you for helping improve nachi. This project welcomes bug reports, feature requests, use-case
descriptions, and other issue-based feedback. It does not accept external code contributions or
pull requests.

## Contribution model

External pull requests are restricted at the repository level. Please do not prepare a patch or
open a pull request from a fork: it will not be reviewed or merged. Forking and modifying the
project for your own use remains permitted by the MIT license.

Instead, open an issue and explain the problem or desired outcome. If the change fits the project,
the maintainers will design, implement, test, and merge it through the project's trusted internal
workflow. This keeps review and supply-chain responsibility with the maintainers while recognizing
that a clear problem report is itself a valuable contribution. The rationale follows the model
described in [The Community Pull Request Is Dead](https://stack72.dev/the-community-pull-request-is-dead/).

## Reporting a bug

Use the bug report template when possible. A useful report includes:

- the affected package and nachi version or commit;
- operating system, Node.js, browser, GPU, Three.js, and other relevant versions;
- a minimal reproduction or precise steps to reproduce;
- expected and actual behavior, including complete error output;
- any workaround or investigation already attempted.

Do not include credentials, private data, or untrusted instructions. Report suspected security
vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

## Requesting a feature

Describe the problem or use case before proposing an API. Include the desired outcome, relevant
constraints, alternatives considered, and the packages likely to be affected. Opening an issue does
not guarantee that the request will be accepted or scheduled.

## Credit and co-authorship

Each issue template lets you opt in to co-author credit. When an issue directly leads to a shipped
change and contains a substantive original diagnosis, reproduction, design constraint, or use-case
analysis, the maintainer will add the reporter's GitHub no-reply identity as a `Co-authored-by`
trailer. Duplicate reports, support questions, and incidental suggestions do not normally qualify.
You may decline credit or change your preference in the issue at any time before the change merges.

## Internal collaborators

Only repository collaborators may create pull requests. Internal pull requests must link the issue
they address, include appropriate tests and a Changeset when release behavior changes, pass all
required checks, and receive the required review before merge.

Run the relevant checks before opening an internal pull request:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
pnpm build
```
