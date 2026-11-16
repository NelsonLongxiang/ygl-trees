#!/usr/bin/env node
/**
 * Package structure gate — hard check that every package follows DSH conventions.
 * Run in pnpm test before unit tests. Exits 1 on any violation.
 *
 * Required per package (packages/<group>/<package>/):
 *   1. package.json     — with name (scoped), version
 *   2. tsconfig.json    — extends ../../tsconfig.base.json
 *   3. README.md        — with YAML frontmatter (description, kind)
 *   4. src/index.ts     — with @module JSDoc tag
 *   5. tests/           — at least one *.spec.ts file
 *
 * Also checks:
 *   - No loose .ts files at packages/ root or packages/<group>/ root
 *   - No .js files in src/ (TypeScript only)
 *   - src/index.ts must export at least one symbol
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const { lstatSync, readdirSync, readFileSync } = fs;
const { join, relative, resolve } = path;
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function directories(root, path) {
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return entries.filter(entry => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return false;
    if (entry.isSymbolicLink()) throw new Error("linked source directory: " + relative(root, join(path, entry.name)));
    return entry.isDirectory();
  }).map(entry => join(path, entry.name)).sort();
}

function checkSourceLayouts(root) {
  const layouts = []; let inPackages = false;
  for (const raw of readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trimEnd();
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { inPackages = line === "packages:"; continue; }
    if (!inPackages) continue;
    const item = /^\s+-\s+(['"]?)([^'"\s]+)\1$/.exec(line);
    if (!item) throw new Error("unsupported workspace layout entry: " + line.trim());
    layouts.push(item[2]);
  }
  if (JSON.stringify(layouts.sort()) !== JSON.stringify(["apps/*", "packages/*/*", "vendor/*"])) {
    throw new Error("workspace layouts changed; update the source-manifest gate: " + layouts.join(", "));
  }
}

function readWorkspaceManifests(root) {
  root = resolve(root);
  checkSourceLayouts(root);
  // These are the three source layouts in pnpm-workspace.yaml, not a recursive glob.
  const roots = ["packages", "apps", "vendor"].map(name => join(root, name));
  for (const path of roots) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("linked source root: " + relative(root, path)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const paths = [
    ...directories(root, roots[0]).flatMap(group => directories(root, group)),
    ...directories(root, roots[1]),
    ...directories(root, roots[2]),
  ];
  return paths.flatMap(path => {
    const file = join(path, "package.json");
    try {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("non-regular manifest: " + relative(root, file));
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      return [{ path: relative(root, file).replaceAll("\\", "/"), manifest }];
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  });
}

function checkWorkspaceGraph(entries) {
  const packages = new Map();
  for (const entry of entries) {
    const name = entry.manifest?.name;
    if (typeof name !== "string" || !name) throw new Error("missing workspace name: " + entry.path);
    if (packages.has(name)) throw new Error("duplicate workspace name: " + name + " (" + packages.get(name).path + ", " + entry.path + ")");
    packages.set(name, entry);
  }
  if (!packages.size) throw new Error("no workspace manifests found");
  const graph = new Map([...packages.keys()].sort().map(name => [name, new Set()]));
  for (const [name, entry] of packages) {
    for (const section of SECTIONS) {
      for (const [target, spec] of Object.entries(entry.manifest[section] ?? {})) {
        if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
        // The repository uses named workspace ranges, not aliases or relative protocols.
        if (!/^workspace:(?:\*|~|\^|[~^<>=\d])/.test(spec) || spec.slice(10).includes("/")) {
          throw new Error("unsupported workspace reference: " + name + " -> " + target + " (" + spec + ")");
        }
        if (!packages.has(target)) throw new Error("unknown workspace: " + name + " -> " + target + " (" + section + ")");
        graph.get(name).add(target);
      }
    }
  }
  const done = new Set(), active = new Set(), route = [];
  function visit(name) {
    if (active.has(name)) throw new Error("workspace cycle: " + [...route.slice(route.indexOf(name)), name].join(" -> "));
    if (done.has(name)) return;
    active.add(name); route.push(name);
    for (const target of [...graph.get(name)].sort()) visit(target);
    route.pop(); active.delete(name); done.add(name);
  }
  for (const name of graph.keys()) visit(name);
  return { packages: graph.size, edges: [...graph.values()].reduce((sum, edges) => sum + edges.size, 0), cycles: 0 };
}


if (process.argv[2] === "--workspace-graph") {
  try {
    if (process.argv.length > 4) throw new Error("usage: node scripts/gate.js --workspace-graph [repository]");
    const result = checkWorkspaceGraph(readWorkspaceManifests(process.argv[3] ?? ROOT));
    console.log("workspace-graph: " + result.packages + " packages, " + result.edges + " edges, no cycles");
  } catch (error) {
    console.error("workspace-graph: " + error.message);
    process.exit(1);
  }
  process.exit(0);
}


/** Package-source references are a different graph from workspace installation links. */
function checkSourceGraph(root, entries) {
  const ts = require("typescript");
  const packages = entries.filter(entry => entry.path.startsWith("packages/"));
  const owners = new Map(), sources = [], names = new Map();
  const key = file => process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file);
  for (const entry of packages) {
    const name = entry.manifest.name;
    if (typeof name !== "string" || !name) throw new Error("missing workspace name: " + entry.path);
    if (names.has(name)) throw new Error("duplicate workspace name: " + name);
    names.set(name, entry);
    const directory = join(dirnameManifest(entry.path), "src");
    collect(directory, name);
  }
  function dirnameManifest(file) { return path.dirname(resolve(root, file)); }
  function collect(directory, owner) {
    let items;
    try {
      if (lstatSync(directory).isSymbolicLink()) throw new Error("linked source directory: " + relative(root, directory));
      items = readdirSync(directory, { withFileTypes: true });
    } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === "node_modules" || item.name.startsWith(".")) continue;
      const file = join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error("linked source entry: " + relative(root, file));
      if (item.isDirectory()) collect(file, owner);
      else if (item.isFile() && /\.[cm]?[jt]sx?$/.test(item.name)) {
        sources.push({ file, owner }); owners.set(key(file), owner);
      }
    }
  }
  if (!sources.length) throw new Error("no package source files found");
  const edges = [];
  for (const { file, owner } of sources) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error("cannot parse package source: " + relative(root, file));
    function visit(node) {
      let literal, kind, typeOnly = false, importedSymbols = null;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        literal = node.moduleSpecifier; kind = ts.isImportDeclaration(node) ? "import" : "export";
        typeOnly = Boolean(node.importClause?.isTypeOnly || node.isTypeOnly);
        const clause = ts.isImportDeclaration(node) ? node.importClause : null;
        if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.namedBindings.elements.some(item => item.isTypeOnly)) {
          importedSymbols = clause.namedBindings.elements.map(item => (item.propertyName ?? item.name).text);
        }
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        literal = node.argument.literal; kind = "import-type"; typeOnly = true;
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        literal = node.moduleReference.expression; kind = "import-equals"; typeOnly = Boolean(node.isTypeOnly);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        literal = node.arguments[0]; kind = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require";
      }
      if (literal && ts.isStringLiteralLike(literal) && literal.text.startsWith(".")) {
        const specifier = literal.text;
        if (!/\.(?:json|css|svg|png|jpg|jpeg|webp)$/.test(specifier)) {
          const base = resolve(path.dirname(file), specifier), stem = base.replace(/\.[cm]?jsx?$/, "");
          const choices = [base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map(ext => stem + ext), ...["index.ts", "index.tsx", "index.js"].map(name => join(base, name))];
          const target = choices.find(candidate => owners.has(key(candidate)));
          if (!target) throw new Error("unresolved package source import: " + relative(root, file).replaceAll("\\", "/") + " -> " + specifier);
          const to = owners.get(key(target));
          if (to !== owner) edges.push({ from: owner, to, file: relative(root, file).replaceAll("\\", "/"), target: relative(root, target).replaceAll("\\", "/"), line: source.getLineAndCharacterOfPosition(literal.getStart()).line + 1, kind, typeOnly, importedSymbols });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  for (const edge of edges) {
    if (edge.file.startsWith("packages/core/") && !edge.target.startsWith("packages/core/")) throw new Error("core source must not depend on a domain: " + edge.file + " -> " + edge.target);
  }
  const graph = new Map([...names.keys()].sort().map(name => [name, new Set()]));
  for (const edge of edges) graph.get(edge.from).add(edge.to);
  const done = new Set(), active = new Set(), route = [];
  function visit(name) {
    if (active.has(name)) {
      const cycle = [...route.slice(route.indexOf(name)), name];
      const witness = edges.find(edge => edge.from === cycle[0] && edge.to === cycle[1]);
      throw new Error("source cycle: " + cycle.join(" -> ") + " (" + witness.file + ":" + witness.line + " -> " + witness.target + ")");
    }
    if (done.has(name)) return;
    active.add(name); route.push(name);
    for (const target of [...graph.get(name)].sort()) visit(target);
    route.pop(); active.delete(name); done.add(name);
  }
  for (const name of graph.keys()) visit(name);
  return { packages: names.size, files: sources.length, references: edges.length, edges: [...graph.values()].reduce((n, set) => n + set.size, 0) };
}

if (process.argv[2] === "--source-graph") {
  try {
    if (process.argv.length > 4) throw new Error("usage: node scripts/gate.js --source-graph [repository]");
    const root = resolve(process.argv[3] ?? ROOT), result = checkSourceGraph(root, readWorkspaceManifests(root));
    console.log("source-graph: " + result.packages + " packages, " + result.files + " files, " + result.references + " references, no cycles (literal relative package-source references, including type-only; no architecture exceptions)");
  } catch (error) {
    console.error("source-graph: " + error.message); process.exit(1);
  }
  process.exit(0);
}

const PACKAGES_DIR = path.join(ROOT, "packages");

let violations = 0;

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  violations++;
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

// ── Find all packages ──
const groups = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith("."));

if (!groups.length) fail("packages/ is empty");

const packages = [];
for (const group of groups) {
  const groupPath = path.join(PACKAGES_DIR, group.name);
  
  // Check: no loose .ts files at group root
  const looseTs = fs.readdirSync(groupPath).filter(f => f.endsWith(".ts"));
  if (looseTs.length) {
    fail(`packages/${group.name}/ has loose .ts files: ${looseTs.join(", ")}`);
  }
  
  // Find packages within group
  const subs = fs.readdirSync(groupPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith("."));
  
  if (!subs.length) {
    fail(`packages/${group.name}/ has no sub-packages`);
  }
  
  for (const sub of subs) {
    packages.push({
      group: group.name,
      name: sub.name,
      path: path.join(groupPath, sub.name),
      relPath: `packages/${group.name}/${sub.name}`,
    });
  }
}

// Check: no loose .ts at packages/ root
const looseAtRoot = fs.readdirSync(PACKAGES_DIR).filter(f => f.endsWith(".ts"));
if (looseAtRoot.length) {
  fail(`packages/ root has loose .ts files: ${looseAtRoot.join(", ")}`);
}

// ── Check each package ──
console.log(`\nChecking ${packages.length} packages:\n`);

for (const pkg of packages) {
  const { path: p, relPath, group, name } = pkg;
  
  // 1. package.json
  const pkgJsonPath = path.join(p, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    fail(`${relPath}: missing package.json`);
  } else {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    if (!pkgJson.name) fail(`${relPath}: package.json missing name`);
    if (!pkgJson.version) fail(`${relPath}: package.json missing version`);
    if (pkgJson.name && !pkgJson.name.includes("/")) {
      fail(`${relPath}: package.json name should be scoped (e.g. @ygl/${group}-${name})`);
    }
  }
  
  // 2. tsconfig.json
  const tsconfigPath = path.join(p, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    fail(`${relPath}: missing tsconfig.json`);
  } else {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
    if (!tsconfig.extends) fail(`${relPath}: tsconfig.json missing extends`);
    if (!tsconfig.compilerOptions || tsconfig.compilerOptions.rootDir !== "src") {
      fail(`${relPath}: tsconfig.json should have rootDir: "src"`);
    }
  }
  
  // 3. README.md with frontmatter
  const readmePath = path.join(p, "README.md");
  if (!fs.existsSync(readmePath)) {
    fail(`${relPath}: missing README.md`);
  } else {
    const readme = fs.readFileSync(readmePath, "utf8");
    if (!readme.startsWith("---")) {
      fail(`${relPath}: README.md missing YAML frontmatter`);
    } else {
      const fm = readme.slice(0, 200);
      if (!fm.includes("description:")) fail(`${relPath}: README.md frontmatter missing description`);
      if (!fm.includes("kind:")) fail(`${relPath}: README.md frontmatter missing kind`);
    }
  }
  
  // 4. src/index.ts with @module
  const srcDir = path.join(p, "src");
  const indexPath = path.join(srcDir, "index.ts");
  if (!fs.existsSync(indexPath)) {
    fail(`${relPath}: missing src/index.ts`);
  } else {
    const index = fs.readFileSync(indexPath, "utf8");
    if (!index.includes("@module")) {
      fail(`${relPath}: src/index.ts missing @module JSDoc tag`);
    }
    // Check it exports something
    if (!index.includes("export")) {
      fail(`${relPath}: src/index.ts has no exports`);
    }
    // Check no .js files in src/
    const jsFiles = fs.readdirSync(srcDir).filter(f => f.endsWith(".js"));
    if (jsFiles.length) {
      fail(`${relPath}: src/ contains .js files: ${jsFiles.join(", ")}`);
    }
  }
  
  // 5. tests/ with at least one .spec.ts
  const testsDir = path.join(p, "tests");
  if (!fs.existsSync(testsDir) || !fs.statSync(testsDir).isDirectory()) {
    fail(`${relPath}: missing tests/ directory`);
  } else {
    const specs = fs.readdirSync(testsDir).filter(f => f.endsWith(".spec.ts"));
    if (!specs.length) {
      fail(`${relPath}: tests/ has no *.spec.ts files`);
    }
  }
}

// ── Summary ──
console.log(`\n${"-".repeat(50)}`);
if (violations > 0) {
  console.error(`✗ ${violations} violation(s) — FIX BEFORE COMMIT\n`);
  process.exit(1);
} else {
  console.log(`✓ All ${packages.length} packages pass structure gate\n`);
}
