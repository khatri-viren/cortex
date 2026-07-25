import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { directoryNodeId, fileNodeId, noteNodeId, projectNodeId, repositoryRelativePath } from "./identity.js";
import type { Diagnostic, NoteFrontmatter, ParsedNote } from "./types.js";
import type { GraphBuild, GraphEdge, GraphNode } from "./index-types.js";

const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const TEST_RE = /(^|[./])(?:__tests__|[^/]+\.(?:test|spec))\.[^.]+$/i;
const IMPORT_RE = /(?:import\s+(?:[\s\S]*?\s+from\s+|)|export\s+[\s\S]*?\s+from\s+|require\s*\()(["'])([^"']+)\1/g;

export type ProjectFile = { absolutePath: string; path: string; isDirectory: boolean };

export function walkProjectFiles(root: string): ProjectFile[] {
  const result: ProjectFile[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".cortex" || entry.name === "node_modules") continue;
      const absolutePath = join(directory, entry.name);
      const path = repositoryRelativePath(root, absolutePath);
      if (entry.isDirectory()) {
        result.push({ absolutePath, path, isDirectory: true });
        visit(absolutePath);
      } else if (entry.isFile()) {
        result.push({ absolutePath, path, isDirectory: false });
      }
    }
  };
  visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function fileKind(path: string): string {
  const name = basename(path);
  if (name.toLowerCase().endsWith(".md")) return "file";
  if (TEST_RE.test(path)) return "test";
  if (name === "package.json" || name.startsWith("tsconfig") || name.includes(".config.")) return "configuration";
  if (MODULE_EXTENSIONS.has(extname(name).toLowerCase())) return "module";
  return "file";
}

function candidatePaths(root: string, sourcePath: string, importPath: string, knownPaths: Set<string>): string[] {
  const sourceDirectory = dirname(join(root, sourcePath));
  const base = resolve(sourceDirectory, importPath);
  const candidates = [base, ...Array.from(MODULE_EXTENSIONS).map((extension) => `${base}${extension}`), ...Array.from(MODULE_EXTENSIONS).map((extension) => join(base, `index${extension}`))];
  return candidates.map((candidate) => repositoryRelativePath(root, candidate)).filter((candidate) => knownPaths.has(candidate));
}

function addEdge(edges: GraphEdge[], fromId: string, toId: string, kind: string, metadata: Record<string, unknown> = {}): void {
  edges.push({ fromId, toId, kind, metadata });
}

function addNode(nodes: GraphNode[], node: GraphNode): void {
  if (!nodes.some((existing) => existing.nodeId === node.nodeId)) nodes.push(node);
}

export function buildProjectGraph(vaultRoot: string, notes: ParsedNote[]): GraphBuild {
  const root = resolve(vaultRoot);
  const entries = walkProjectFiles(root);
  const paths = new Set(entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path));
  const nodes: GraphNode[] = [{ nodeId: projectNodeId(), kind: "project", name: basename(root), metadata: {} }];
  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const pathToNode = new Map<string, string>();
  const notesByPath = new Map<string, NoteFrontmatter>();
  for (const note of notes) {
    if (!note.frontmatter || !note.filePath) continue;
    notesByPath.set(repositoryRelativePath(root, note.filePath), note.frontmatter);
  }

  for (const entry of entries) {
    if (entry.isDirectory) {
      const nodeId = directoryNodeId(root, entry.absolutePath);
      pathToNode.set(entry.path, nodeId);
      addNode(nodes, { nodeId, kind: "directory", path: entry.path, name: basename(entry.path), metadata: {} });
      const parent = dirname(entry.path);
      addEdge(edges, parent === "." ? projectNodeId() : directoryNodeId(root, join(root, parent)), nodeId, "contains");
      continue;
    }

    const frontmatter = notesByPath.get(entry.path);
    const nodeId = frontmatter ? noteNodeId(frontmatter.id) : fileNodeId(root, entry.absolutePath);
    pathToNode.set(entry.path, nodeId);
    addNode(nodes, frontmatter
      ? { nodeId, kind: "note", path: entry.path, name: frontmatter.title, metadata: { type: frontmatter.type } }
      : { nodeId, kind: fileKind(entry.path), path: entry.path, name: basename(entry.path), metadata: { extension: extname(entry.path) } });
    const parent = dirname(entry.path);
    addEdge(edges, parent === "." ? projectNodeId() : directoryNodeId(root, join(root, parent)), nodeId, "contains");
  }

  const filesByPath = new Map(entries.filter((entry) => !entry.isDirectory).map((entry) => [entry.path, entry]));
  for (const entry of entries.filter((candidate) => !candidate.isDirectory && MODULE_EXTENSIONS.has(extname(candidate.path).toLowerCase()))) {
    const sourceId = pathToNode.get(entry.path);
    if (!sourceId) continue;
    const content = readFileSync(entry.absolutePath, "utf8");
    for (const match of content.matchAll(IMPORT_RE)) {
      const importPath = match[2];
      if (!importPath.startsWith(".")) continue;
      const targetPath = candidatePaths(root, entry.path, importPath, paths)[0];
      if (!targetPath) {
        diagnostics.push({ severity: "warning", code: "unresolved-import", message: `Could not resolve relative import '${importPath}'.`, filePath: entry.absolutePath });
        continue;
      }
      const targetId = pathToNode.get(targetPath);
      if (!targetId) continue;
      addEdge(edges, sourceId, targetId, "imports", { specifier: importPath });
      if (fileKind(entry.path) === "test") addEdge(edges, targetId, sourceId, "tested_by", { specifier: importPath });
    }
  }

  const packageJson = filesByPath.get("package.json");
  if (packageJson) {
    try {
      const manifest = JSON.parse(readFileSync(packageJson.absolutePath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const packageNodeId = pathToNode.get("package.json");
      for (const [section, dependencies] of [["dependencies", manifest.dependencies], ["devDependencies", manifest.devDependencies]] as const) {
        if (!dependencies || !packageNodeId) continue;
        for (const [name, version] of Object.entries(dependencies)) {
          const nodeId = `package:${name}`;
          addNode(nodes, { nodeId, kind: "package", name, metadata: { version, section } });
          addEdge(edges, packageNodeId, nodeId, "depends_on", { version, section });
        }
      }
    } catch (cause) {
      diagnostics.push({ severity: "error", code: "invalid-package-json", message: cause instanceof Error ? cause.message : String(cause), filePath: packageJson.absolutePath });
    }
  }

  for (const note of notes) {
    if (!note.frontmatter || !note.filePath) continue;
    const nodeId = noteNodeId(note.frontmatter.id);
    for (const attachment of note.frontmatter.applies_to) {
      if (attachment.repository) continue;
      const [targetPath, symbol] = attachment.target.split("#", 2);
      const normalizedTarget = targetPath || ".";
      let targetId = normalizedTarget === "." ? projectNodeId() : pathToNode.get(normalizedTarget);
      if (!targetId && existsSync(join(root, normalizedTarget))) {
        targetId = statSync(join(root, normalizedTarget)).isDirectory() ? directoryNodeId(root, join(root, normalizedTarget)) : fileNodeId(root, join(root, normalizedTarget));
      }
      if (symbol) {
        diagnostics.push({ severity: "warning", code: "unresolved-symbol-target", message: `Symbol target '${attachment.target}' is deferred until symbol indexing.`, filePath: note.filePath });
        continue;
      }
      if (!targetId) {
        diagnostics.push({ severity: "warning", code: "unresolved-attachment-target", message: `Could not resolve attachment target '${attachment.target}'.`, filePath: note.filePath });
        continue;
      }
      addEdge(edges, nodeId, targetId, attachment.relation, { target: attachment.target });
    }
  }

  return { nodes, edges, diagnostics };
}
