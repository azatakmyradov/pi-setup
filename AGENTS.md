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

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
