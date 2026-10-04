# Constraints

Last reviewed: 2026-10-04 — floor-only baseline.

## Floor (always enforced, no setup required)

- No new suppression comments: `@ts-ignore`, `@ts-nocheck`, `eslint-disable`,
  `biome-ignore`, `# noqa`, `# type: ignore`, `istanbul ignore`
- No unimplemented stubs: `throw new Error("Not implemented")`, empty `catch {}`
- No skipped or deleted tests without a reason in the commit message; an
  authorized test-diet deletion names its task and retained existing real
  journey coverage there, states its reason, and never weakens a retained
  security, crypto or data-loss check
- No secrets in source
- This file does not get weakened to make a change pass

Enforcement today reuses what already exists: the floor moves above are checked
by reading the change diff at review time (`git diff`; no new guard tooling),
and CI (`.github/workflows/ci.yml`, CodeQL in `.github/workflows/codeql.yml`)
remains the external opinion.
