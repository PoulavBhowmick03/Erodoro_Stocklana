@AGENTS.md

## Tests

- Do not add unit tests. Don't write new `tests/*.test.mjs` files or extend them for new features.
- Add an end-to-end check (`tour.spec.mjs`, `flows.spec.mjs`, `ux-audit.spec.mjs`) only when it is necessary, e.g. when a change moves or replaces a route those suites already cover.
