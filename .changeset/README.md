# Changesets

Run `pnpm changeset` for every user-visible package change. Nachi packages use independent
versioning: `fixed` and `linked` groups are intentionally empty. `pnpm version-packages` applies the
queued changes locally; publishing remains a separate release decision.
