import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

function runtimeImportSpecifiers(sourcePath: string): string[] {
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const hasRuntimeName = clause.name !== undefined
          || clause.namedBindings.elements.some((element) => !element.isTypeOnly);
        if (!hasRuntimeName) continue;
      }
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
      continue;
    }
    if (
      ts.isExportDeclaration(statement)
      && !statement.isTypeOnly
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }

  return specifiers;
}

interface StartupGraph {
  files: string[];
  packages: string[];
}

function startupGraph(entryPath: string): StartupGraph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entryPath];

  while (pending.length > 0) {
    const sourcePath = pending.pop()!;
    if (files.has(sourcePath)) continue;
    files.add(sourcePath);

    for (const specifier of runtimeImportSpecifiers(sourcePath)) {
      if (!specifier.startsWith(".")) {
        packages.add(specifier);
        continue;
      }
      pending.push(resolve(dirname(sourcePath), specifier));
    }
  }

  return { files: [...files], packages: [...packages] };
}

describe("MCP startup import boundary", () => {
  it("keeps heavy runtime modules outside the eager index graph", () => {
    const extensionRoot = resolve(import.meta.dirname, "..");
    const graph = startupGraph(resolve(extensionRoot, "index.ts"));
    const localFiles = graph.files.map((path) => relative(extensionRoot, path));

    expect(localFiles).not.toContain("runtime-entry.ts");
    expect(localFiles).not.toContain("init.ts");
    expect(localFiles).not.toContain("commands.ts");
    expect(localFiles).not.toContain("proxy-modes.ts");
    expect(localFiles).not.toContain("direct-tools.ts");
    expect(localFiles).not.toContain("code-mode.ts");
    expect(localFiles).not.toContain("mcp-auth-flow.ts");
    expect(localFiles.some((path) => path.startsWith("effect/"))).toBe(false);
    expect(localFiles.some((path) => path.startsWith("vendor/opencode-codemode/"))).toBe(false);

    expect(graph.packages.some((name) => name === "effect" || name.startsWith("effect/"))).toBe(false);
    expect(graph.packages.some((name) => name.startsWith("@modelcontextprotocol/sdk"))).toBe(false);
    expect(graph.packages.some((name) => name.startsWith("@modelcontextprotocol/ext-apps"))).toBe(false);
    expect(graph.packages).not.toContain("acorn");
    expect(graph.packages).not.toContain("recheck");
    expect(graph.packages).not.toContain("open");
  });
});
