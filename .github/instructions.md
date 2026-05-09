# geniesh — Project Instructions

This file defines the conventions, preferences, and workflows for developing and maintaining this repository. The AI assistant should treat this as authoritative guidance.

## Testing

- Run `npm test` after every change. All 105+ Jest tests must pass.
- When adding new features, add corresponding tests.
- Test on both small and large codebases before merging structural changes.

## Code Style & Patterns

- **ESM only** — use `import`/`export`, never `require`.
- **No JSDoc comments** in source code. Let the code speak.
- **No trailing comments** on code lines. Explain intent in the commit message, not inline.
- Use `const` by default, `let` only when reassignment is required. Never use `var`.
- Use `Set` and `Map` over plain objects for key-value collections when keys are user-controlled strings.
- Guard map-entry initialization with `Object.hasOwn(obj, key)` instead of truthiness checks (`if (!obj[key])`) to avoid Object.prototype property collisions (`toString`, `constructor`, `hasOwnProperty`).
- Async/await over raw promises.
- Use the `readFile` wrapper from `fs-utils.js` instead of raw `fs/promises` when reading source files.

## Commit Style & Versioning

- All PRs and multi-commit branches **must be squash-merged** into `main`.
- Every push to `main` **must bump the version** in `package.json` following semver:
  - `feat:` → minor bump (`1.2.0 → 1.3.0`)
  - `fix:` → patch bump (`1.2.0 → 1.2.1`)
  - `BREAKING CHANGE` or major refactor → major bump (`1.2.0 → 2.0.0`)
- Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`
  - `feat:` — new capability
  - `fix:` — bug fix
  - `refactor:` — structural change with no behavior change
  - `docs:` — documentation only
  - `test:` — test additions/fixes
  - `chore:` — tooling, CI, dependencies
- The squash commit message becomes the single canonical entry for that change-set.
- Write commit messages that explain *why* (not just *what*).

## Documentation

- Update `README.md` after every significant change (new feature, refactor, changed behavior).
- Keep the architecture diagram and project structure in `README.md` in sync with the actual code.
- `.github/instructions.md` should be updated when development conventions change.
- The **Showcase** section in `README.md` has placeholders for screenshots and demo videos. Replace them with real captures when presenting the tool.

## Context Building (internal)

- The `PRIORITY_NAMES` set in `context-builder.js` controls which files load first in RAG tier. `.github/instructions.md` and `README.md` are always loaded before other chunks.
- BFS relation traversal (`.ai-relations.json`) replaces the old depth-capped transitive grep. No code changes should reintroduce depth-capped grep.
- Context budget is 10,000 characters per turn. New context sources must respect this cap.

## Indexing

- `.ai-index.json` and `.ai-relations.json` are generated artifacts — never commit them (they are in `.gitignore`).
- Re-run `ai index` when the codebase structure changes significantly.
- The indexer builds both the RAG index and the relation graph in a single pass.
- All hidden directories except `.github` are skipped during scanning. If a new dot-prefixed directory needs indexing, update `fs-utils.js`.

## Pull Requests

- When asked to create a PR, first review all commits that will be included (not just the latest).
- Push to remote with `-u` before creating the PR.
- Use `gh pr create` with a summary section describing the changes and their motivation.

## Security

- Never commit secrets, API keys, or credentials.
- Never log or expose environment variables that contain secrets.
- Use `process.env` for configuration that differs across environments.
- Always validate user-provided file paths and symbol names to prevent injection.
