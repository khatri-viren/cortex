import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { directoryNodeId, fileNodeId, noteNodeId, projectNodeId, repositoryRelativePath } from "./identity.js";
import type { Diagnostic, NoteFrontmatter, ParsedNote } from "./types.js";
import type { GraphBuild, GraphEdge, GraphNode } from "./index-types.js";

const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const TEST_RE = /(^|[./])(?:__tests__|[^/]+\.(?:test|spec))\.[^.]+$/i;
const IMPORT_RE = /(?:import\s+(?:[\s\S]*?\s+from\s+|)|export\s+[\s\S]*?\s+from\s+|require\s*\()(["'])([^"']+)\1/g;
const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([".git", ".cortex", "node_modules"]);

export type ProjectFile = {
  absolutePath: string;
  path: string;
  isDirectory: boolean;
  kind?: string;
  hash?: string;
  size?: number;
  mtimeMs?: number;
};

export type ProjectWalkOptions = {
  includeDirectories?: boolean;
  relativePath?: (absolutePath: string) => string | undefined;
  ignore?: (path: string, isDirectory: boolean) => boolean;
  collectFileMetadata?: (absolutePath: string, path: string) => Partial<ProjectFile>;
};

/**
 * Walk a source tree into the file records consumed by the canonical graph
 * builder. Source-specific indexers provide path normalization, ignore rules,
 * and optional file metadata; traversal remains shared.
 */
export function walkProjectFiles(root: string, options: ProjectWalkOptions = {}): ProjectFile[] {
  const result: ProjectFile[] = [];
  const includeDirectories = options.includeDirectories ?? true;
  const relativePath = options.relativePath ?? ((absolutePath: string) => repositoryRelativePath(root, absolutePath));
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (DEFAULT_IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      let path: string | undefined;
      try {
        path = relativePath(absolutePath);
      } catch {
        path = undefined;
      }
      if (!path || options.ignore?.(path, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        if (includeDirectories) result.push({ absolutePath, path, isDirectory: true });
        visit(absolutePath);
      } else if (entry.isFile()) {
        result.push({ absolutePath, path, isDirectory: false, ...options.collectFileMetadata?.(absolutePath, path) });
      }
    }
  };
  visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export function classifyProjectFile(path: string, treatMarkdownAsFile = true): string {
  const name = basename(path);
  if (treatMarkdownAsFile && name.toLowerCase().endsWith(".md")) return "file";
  if (TEST_RE.test(path)) return "test";
  if (name === "package.json" || name.startsWith("tsconfig") || name.includes(".config.")) return "configuration";
  if (MODULE_EXTENSIONS.has(extname(name).toLowerCase())) return "module";
  return "file";
}

export type GraphSourcePolicy = {
  rootKind: "vault" | "workspace";
  rootPath: string;
  rootNode: GraphNode;
  normalizePath: (absolutePath: string) => string;
  directoryNodeId: (path: string) => string;
  fileNodeId: (path: string) => string;
  packageNodeId: (name: string) => string;
  ignore: (path: string, isDirectory: boolean) => boolean;
  includeMarkdownNotes: boolean;
  noteAttachmentPolicy: "vault" | "none";
  repositoryNamespace?: string;
  packageNamespace?: string;
  allowJsToTsResolution: boolean;
  treatMarkdownAsFile: boolean;
  nodeMetadata?: (kind: "directory" | "file" | "package", path: string) => Record<string, unknown>;
  edgeMetadata?: (kind: "contains" | "imports" | "tested_by" | "depends_on", path?: string) => Record<string, unknown>;
  diagnosticPath: (absolutePath: string, path: string) => string | undefined;
};

export type GraphSource = {
  policy: GraphSourcePolicy;
  files: ProjectFile[];
  notes?: ParsedNote[];
};

function addNode(nodes: GraphNode[], node: GraphNode, nodeIds: Set<string>): void {
  if (nodeIds.has(node.nodeId)) return;
  nodeIds.add(node.nodeId);
  nodes.push(node);
}

function addEdge(edges: GraphEdge[], edgeKeys: Set<string>, edge: GraphEdge): void {
  const key = `${edge.fromId}\u0000${edge.toId}\u0000${edge.kind}\u0000${JSON.stringify(edge.metadata ?? {})}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  edges.push(edge);
}

function mergeMetadata(...values: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  return Object.assign({}, ...values);
}

function nodeMetadata(policy: GraphSourcePolicy, kind: "directory" | "file" | "package", path: string): Record<string, unknown> {
  return policy.nodeMetadata?.(kind, path) ?? {};
}

function edgeMetadata(policy: GraphSourcePolicy, kind: "contains" | "imports" | "tested_by" | "depends_on", path?: string): Record<string, unknown> {
  return policy.edgeMetadata?.(kind, path) ?? {};
}

function candidatePaths(policy: GraphSourcePolicy, sourcePath: string, importPath: string, knownPaths: Set<string>): string[] {
  const sourceDirectory = dirname(resolve(policy.rootPath, sourcePath));
  const base = resolve(sourceDirectory, importPath);
  const extensions = Array.from(MODULE_EXTENSIONS);
  const candidates = [base, ...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => join(base, `index${extension}`))];

  // TypeScript ESM commonly writes './module.js' for a source file stored as
  // 'module.ts'. The workspace policy enables this fallback explicitly.
  if (policy.allowJsToTsResolution) {
    const specifierExtension = extname(base).toLowerCase();
    if (MODULE_EXTENSIONS.has(specifierExtension)) {
      const withoutExtension = base.slice(0, -specifierExtension.length);
      candidates.push(...extensions.map((extension) => `${withoutExtension}${extension}`));
    }
  }

  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const candidate of candidates) {
    try {
      const path = policy.normalizePath(candidate);
      if (knownPaths.has(path) && !seen.has(path)) {
        seen.add(path);
        resolved.push(path);
      }
    } catch {
      // An import outside the source root is an unresolved import, not a
      // reason to abort the source projection.
    }
  }
  return resolved;
}

function directoryPaths(files: ProjectFile[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    if (file.isDirectory && file.path !== ".") paths.add(file.path);
    if (file.isDirectory) continue;
    let parent = dirname(file.path);
    while (parent !== "." && parent !== "") {
      paths.add(parent);
      parent = dirname(parent);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

/**
 * Build a graph for either a vault project or a workspace repository. The
 * source policy supplies identity, namespace, path, ignore, attachment, and
 * metadata rules while this implementation owns traversal results,
 * classification, imports, packages, diagnostics, and stable assembly.
 */
export function buildProjectGraphFromSource(source: GraphSource): GraphBuild {
  const { policy } = source;
  const notes = policy.includeMarkdownNotes ? source.notes ?? [] : [];
  const files = source.files
    .filter((entry) => !policy.ignore(entry.path, entry.isDirectory))
    .sort((left, right) => left.path.localeCompare(right.path));
  const nodes: GraphNode[] = [{ ...policy.rootNode, metadata: { ...(policy.rootNode.metadata ?? {}) } }];
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  const pathToNode = new Map<string, string>();
  const notesByPath = new Map<string, NoteFrontmatter>();
  for (const note of notes) {
    if (!note.frontmatter || !note.filePath) continue;
    try {
      notesByPath.set(policy.normalizePath(note.filePath), note.frontmatter);
    } catch {
      // A note outside the graph root cannot be attached to this source.
    }
  }

  for (const path of directoryPaths(files)) {
    const nodeId = policy.directoryNodeId(path);
    pathToNode.set(path, nodeId);
    addNode(nodes, { nodeId, kind: "directory", path, name: basename(path), metadata: nodeMetadata(policy, "directory", path) }, nodeIds);
    const parent = dirname(path);
    const parentId = parent === "." ? policy.rootNode.nodeId : policy.directoryNodeId(parent);
    addEdge(edges, edgeKeys, { fromId: parentId, toId: nodeId, kind: "contains", metadata: edgeMetadata(policy, "contains", path) });
  }

  const filesByPath = new Map(files.filter((entry) => !entry.isDirectory).map((entry) => [entry.path, entry]));
  for (const entry of files.filter((candidate) => !candidate.isDirectory)) {
    const frontmatter = notesByPath.get(entry.path);
    const nodeId = frontmatter ? noteNodeId(frontmatter.id) : policy.fileNodeId(entry.path);
    pathToNode.set(entry.path, nodeId);
    const node = frontmatter
      ? { nodeId, kind: "note", path: entry.path, name: frontmatter.title, metadata: { type: frontmatter.type } }
      : { nodeId, kind: entry.kind ?? classifyProjectFile(entry.path, policy.treatMarkdownAsFile), path: entry.path, name: basename(entry.path), metadata: nodeMetadata(policy, "file", entry.path) };
    addNode(nodes, node, nodeIds);
    const parent = dirname(entry.path);
    const parentId = parent === "." ? policy.rootNode.nodeId : policy.directoryNodeId(parent);
    addEdge(edges, edgeKeys, { fromId: parentId, toId: nodeId, kind: "contains", metadata: edgeMetadata(policy, "contains", entry.path) });
  }

  const knownPaths = new Set(filesByPath.keys());
  for (const entry of files.filter((candidate) => !candidate.isDirectory && MODULE_EXTENSIONS.has(extname(candidate.path).toLowerCase()))) {
    const sourceId = pathToNode.get(entry.path);
    if (!sourceId) continue;
    const content = readFileSync(entry.absolutePath, "utf8");
    for (const match of content.matchAll(IMPORT_RE)) {
      const importPath = match[2];
      if (!importPath.startsWith(".")) continue;
      const targetPath = candidatePaths(policy, entry.path, importPath, knownPaths)[0];
      if (!targetPath) {
        diagnostics.push({ severity: "warning", code: "unresolved-import", message: `Could not resolve relative import '${importPath}'.`, filePath: policy.diagnosticPath(entry.absolutePath, entry.path) });
        continue;
      }
      const targetId = pathToNode.get(targetPath);
      if (!targetId) continue;
      addEdge(edges, edgeKeys, { fromId: sourceId, toId: targetId, kind: "imports", metadata: mergeMetadata({ specifier: importPath }, edgeMetadata(policy, "imports", entry.path)) });
      if ((entry.kind ?? classifyProjectFile(entry.path, policy.treatMarkdownAsFile)) === "test") {
        addEdge(edges, edgeKeys, { fromId: targetId, toId: sourceId, kind: "tested_by", metadata: mergeMetadata({ specifier: importPath }, edgeMetadata(policy, "tested_by", entry.path)) });
      }
    }
  }

  const packageJson = filesByPath.get("package.json");
  if (packageJson) {
    try {
      const manifest = JSON.parse(readFileSync(packageJson.absolutePath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const packageManifestNodeId = pathToNode.get("package.json");
      for (const [section, dependencies] of [["dependencies", manifest.dependencies], ["devDependencies", manifest.devDependencies]] as const) {
        if (!dependencies || !packageManifestNodeId) continue;
        for (const [name, version] of Object.entries(dependencies)) {
          const nodeId = policy.packageNodeId(name);
          addNode(nodes, { nodeId, kind: "package", name, metadata: mergeMetadata(nodeMetadata(policy, "package", name), { version, section }) }, nodeIds);
          addEdge(edges, edgeKeys, { fromId: packageManifestNodeId, toId: nodeId, kind: "depends_on", metadata: mergeMetadata(edgeMetadata(policy, "depends_on", "package.json"), { version, section }) });
        }
      }
    } catch (cause) {
      diagnostics.push({ severity: "error", code: "invalid-package-json", message: cause instanceof Error ? cause.message : String(cause), filePath: policy.diagnosticPath(packageJson.absolutePath, packageJson.path) });
    }
  }

  if (policy.noteAttachmentPolicy === "vault") {
    for (const note of notes) {
      if (!note.frontmatter || !note.filePath) continue;
      const nodeId = noteNodeId(note.frontmatter.id);
      for (const attachment of note.frontmatter.applies_to) {
        if (attachment.repository) continue;
        const [targetPath, symbol] = attachment.target.split("#", 2);
        const normalizedTarget = targetPath || ".";
        let targetId = normalizedTarget === "." ? policy.rootNode.nodeId : pathToNode.get(normalizedTarget);
        if (!targetId && existsSync(resolve(policy.rootPath, normalizedTarget))) {
          const absoluteTarget = resolve(policy.rootPath, normalizedTarget);
          targetId = statSync(absoluteTarget).isDirectory() ? policy.directoryNodeId(normalizedTarget) : policy.fileNodeId(normalizedTarget);
        }
        if (symbol) {
          diagnostics.push({ severity: "warning", code: "unresolved-symbol-target", message: `Symbol target '${attachment.target}' is deferred until symbol indexing.`, filePath: note.filePath });
          continue;
        }
        if (!targetId) {
          diagnostics.push({ severity: "warning", code: "unresolved-attachment-target", message: `Could not resolve attachment target '${attachment.target}'.`, filePath: note.filePath });
          continue;
        }
        addEdge(edges, edgeKeys, { fromId: nodeId, toId: targetId, kind: attachment.relation, metadata: { target: attachment.target } });
      }
    }
  }

  return { nodes, edges, diagnostics };
}

export function buildProjectGraph(vaultRoot: string, notes: ParsedNote[]): GraphBuild {
  const root = resolve(vaultRoot);
  const policy: GraphSourcePolicy = {
    rootKind: "vault",
    rootPath: root,
    rootNode: { nodeId: projectNodeId(), kind: "project", name: basename(root), metadata: {} },
    normalizePath: (absolutePath) => repositoryRelativePath(root, absolutePath),
    directoryNodeId: (path) => directoryNodeId(root, join(root, path)),
    fileNodeId: (path) => fileNodeId(root, join(root, path)),
    packageNodeId: (name) => `package:${name}`,
    ignore: (path) => path.split("/").some((part) => DEFAULT_IGNORED_DIRECTORY_NAMES.has(part)),
    includeMarkdownNotes: true,
    noteAttachmentPolicy: "vault",
    allowJsToTsResolution: false,
    treatMarkdownAsFile: true,
    nodeMetadata: (kind, path) => kind === "file" ? { extension: extname(path) } : {},
    diagnosticPath: (absolutePath) => absolutePath,
  };
  return buildProjectGraphFromSource({ policy, files: walkProjectFiles(root), notes });
}
