# Repository guidance

## TypeScript

- Keep each loadable extension in `extensions/<name>/index.ts` unless an external installer requires a fixed path.
- Put reusable modules that must not load independently in `extensions/shared/`.
- Use type-only imports where required by `verbatimModuleSyntax`.
- Avoid `any`; prefer narrowing unknown values and existing Pi types.
- Add dependencies with `npm install` instead of editing dependency ranges by hand.
- Preserve standalone package manifests for vendored or independently testable extensions.

## Generated and vendored code

- Do not edit `extensions/herdr-agent-state.ts`; Herdr owns it.
- Keep changes to `extensions/pi-mcp-adapter` and `extensions/pi-skill-toggle` focused so they remain easy to sync with upstream.
- Never commit `node_modules`, credentials, runtime state, test coverage, or generated `dist` directories.

## Validation

After changing code, run:

```sh
npm run check
npm test
npm run format:check
```

Run the narrow extension test first while iterating, then run the complete root commands before finishing.
