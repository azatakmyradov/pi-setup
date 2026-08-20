import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    ignorePatterns: [
      "extensions/herdr-agent-state.ts",
      "extensions/pi-mcp-adapter/**",
      "extensions/pi-skill-toggle/**",
    ],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ["extensions/**/*.test.ts"],
        rules: { "typescript/no-floating-promises": "off" },
      },
    ],
  },
});
