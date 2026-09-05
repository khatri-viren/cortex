import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { requireGitVault } from "./vault.js";

export const WORKSPACE_MANIFEST = "workspace.yaml";
export const WORKSPACE_VERSION = 1 as const;

const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.cortex/**",
  "**/target/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.venv/**",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
];

export type WorkspaceManifest = {
  version: typeof WORKSPACE_VERSION;
  workspace_root: string;
  discovery: {
    mode: "immediate-git-repositories";
    /**
     * Allowlist of repository ids. When non-empty only these are discovered, so
     * unrelated sibling repositories added later are never indexed silently.
     * An empty list keeps the default behaviour of discovering every child repo.
     */
    include: string[];
    exclude: string[];
  };
  ignore: string[];
};

export type WorkspaceRepository = {
  id: string;
  path: string;
  absolutePath: string;
  exists: boolean;
  gitRoot?: string;
  stale?: boolean;
};

export type WorkspaceDiagnostic = {
  severity: "warning" | "error";
  code: string;
  message: string;
  path?: string;
};

export type WorkspaceConfig = {
  vaultRoot: string;
  manifestPath: string;
  manifest: WorkspaceManifest;
  workspaceRoot: string;
  workspaceExists: boolean;
  repositories: WorkspaceRepository[];
  diagnostics: WorkspaceDiagnostic[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

function defaultManifest(workspaceRoot: string): WorkspaceManifest {
  return {
    version: WORKSPACE_VERSION,
    workspace_root: workspaceRoot,
    discovery: { mode: "immediate-git-repositories", include: [], exclude: ["_personal_working_docs"] },
    ignore: DEFAULT_IGNORES,
  };
}

export function workspaceManifestPath(vaultRoot: string): string {
  return join(requireGitVault(vaultRoot), WORKSPACE_MANIFEST);
}

export function readWorkspaceManifest(vaultRoot: string): WorkspaceManifest | undefined {
  const path = workspaceManifestPath(vaultRoot);
  if (!existsSync(path)) return undefined;
  const parsed: unknown = parseYaml(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`Workspace manifest must be a YAML object: ${path}`);
  const discovery = isRecord(parsed.discovery) ? parsed.discovery : {};
  const mode = discovery.mode ?? "immediate-git-repositories";
  if (parsed.version !== WORKSPACE_VERSION) throw new Error(`Unsupported workspace manifest version '${String(parsed.version)}'.`);
  if (typeof parsed.workspace_root !== "string" || parsed.workspace_root.trim().length === 0) throw new Error("Workspace manifest requires workspace_root.");
  if (mode !== "immediate-git-repositories") throw new Error(`Unsupported workspace discovery mode '${String(mode)}'.`);
  return {
    version: WORKSPACE_VERSION,
    workspace_root: parsed.workspace_root,
    discovery: {
      mode: "immediate-git-repositories",
      include: stringArray(discovery.include, []),
      exclude: stringArray(discovery.exclude, []),
    },
    ignore: stringArray(parsed.ignore, DEFAULT_IGNORES),
  };
}

function normalizedRelative(root: string, target: string): string {
  const value = relative(resolve(root), resolve(target)).replaceAll("\\", "/");
  if (!value || value === ".") return ".";
  if (value === ".." || value.startsWith("../")) throw new Error(`Workspace path '${target}' is outside '${root}'.`);
  return value;
}

export function isWorkspaceIgnored(path: string, patterns: string[]): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === ".") return false;

  const glob = (pattern: string, allowDescendants = false): RegExp => {
    let source = "^";
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index];
      if (character === "*" && pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else if (character === "*") {
        source += "[^/]*";
      } else if (character === "?") {
        source += "[^/]";
      } else {
        source += character.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
      }
    }
    if (allowDescendants) source += "(?:/.*)?";
    return new RegExp(source + "$");
  };

  return patterns.some((pattern) => {
    const value = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
    if (!value) return false;
    if (value.endsWith("/**")) return glob(value.slice(0, -3), true).test(normalized);
    if (!value.includes("/") && !value.includes("*")) {
      return normalized === value || normalized.startsWith(`${value}/`) || normalized.includes(`/${value}/`) || normalized.endsWith(`/${value}`);
    }
    return glob(value).test(normalized);
  });
}

function gitRoot(path: string): string | undefined {
  const marker = join(path, ".git");
  return existsSync(marker) ? path : undefined;
}

function isDiscoverable(name: string, included: string[], excluded: string[]): boolean {
  if (name.startsWith(".") || excluded.includes(name)) return false;
  return included.length === 0 || included.includes(name);
}

function discoverRepositories(root: string, included: string[], excluded: string[]): WorkspaceRepository[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isDiscoverable(entry.name, included, excluded))
    .map((entry) => ({ id: entry.name, path: entry.name, absolutePath: join(root, entry.name), exists: true, gitRoot: gitRoot(join(root, entry.name)) }))
    .filter((repository) => repository.gitRoot !== undefined);
}

export function loadWorkspaceConfig(vaultRoot: string, workspaceOverride?: string): WorkspaceConfig {
  const root = requireGitVault(vaultRoot);
  const manifestPath = workspaceManifestPath(root);
  const onDisk = readWorkspaceManifest(root);
  const manifest = onDisk ?? defaultManifest(workspaceOverride ?? process.env.CORTEX_WORKSPACE_ROOT ?? "..");
  const configuredRoot = workspaceOverride ?? process.env.CORTEX_WORKSPACE_ROOT ?? manifest.workspace_root;
  const workspaceRoot = isAbsolute(configuredRoot) ? resolve(configuredRoot) : resolve(dirname(manifestPath), configuredRoot);
  const diagnostics: WorkspaceDiagnostic[] = [];
  if (!existsSync(workspaceRoot)) {
    diagnostics.push({ severity: "error", code: "missing-workspace-root", message: `Workspace root does not exist: ${workspaceRoot}`, path: workspaceRoot });
    return { vaultRoot: root, manifestPath, manifest, workspaceRoot, workspaceExists: false, repositories: [], diagnostics };
  }
  const { include, exclude } = manifest.discovery;
  const repositories = discoverRepositories(workspaceRoot, include, exclude);
  if (repositories.length === 0) diagnostics.push({ severity: "warning", code: "no-workspace-repositories", message: "No immediate child Git repositories were discovered.", path: workspaceRoot });
  for (const repository of repositories) {
    if (isWorkspaceIgnored(repository.path, manifest.ignore)) diagnostics.push({ severity: "warning", code: "ignored-repository", message: `Repository '${repository.id}' is covered by an ignore pattern.`, path: repository.path });
  }
  for (const name of include) {
    if (!repositories.some((repository) => repository.id === name)) {
      diagnostics.push({ severity: "warning", code: "missing-included-repository", message: `Included repository '${name}' was not found as a Git repository under the workspace root.`, path: name });
    }
  }
  for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
    // An allowlist states the intended scope, so unlisted directories are deliberate omissions rather than gaps.
    if (entry.isDirectory() && isDiscoverable(entry.name, include, exclude) && !gitRoot(join(workspaceRoot, entry.name))) {
      diagnostics.push({ severity: "warning", code: "non-repository-directory", message: `Directory '${entry.name}' is not a Git repository and was not indexed.`, path: entry.name });
    }
  }
  return { vaultRoot: root, manifestPath, manifest, workspaceRoot, workspaceExists: true, repositories, diagnostics };
}

function manifestWorkspaceRoot(vaultRoot: string, workspaceRoot: string): string {
  const resolvedTarget = resolve(workspaceRoot);
  const value = relative(resolve(vaultRoot), resolvedTarget).replaceAll("\\", "/");
  const isNested = value.length > 0 && value !== ".." && !value.startsWith("../");
  return isNested ? value : resolvedTarget;
}

export function initializeWorkspaceManifest(vaultRoot: string, workspaceRoot: string, include: string[] = []): WorkspaceConfig {
  const root = requireGitVault(vaultRoot);
  const path = workspaceManifestPath(root);
  if (existsSync(path)) throw new Error(`Workspace manifest already exists: ${path}`);
  const manifest = defaultManifest(manifestWorkspaceRoot(root, workspaceRoot));
  manifest.discovery.include = include;
  writeFileSync(path, stringifyYaml(manifest), "utf8");
  return loadWorkspaceConfig(root);
}

export function removeWorkspaceRepository(vaultRoot: string, repositoryId: string): WorkspaceManifest {
  const root = requireGitVault(vaultRoot);
  const path = workspaceManifestPath(root);
  const manifest = readWorkspaceManifest(root);
  if (!manifest) throw new Error(`Workspace manifest does not exist: ${path}`);
  if (!manifest.discovery.exclude.includes(repositoryId)) manifest.discovery.exclude.push(repositoryId);
  writeFileSync(path, stringifyYaml(manifest), "utf8");
  return manifest;
}

export function repositoryRelativePath(workspaceRoot: string, repository: WorkspaceRepository, target: string): string {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(repository.absolutePath, target);
  const relativePath = normalizedRelative(repository.absolutePath, absolute);
  if (relativePath === "." || isWorkspaceIgnored(relativePath, [".git", "node_modules", ".cortex", "target"])) throw new Error(`Workspace target '${target}' is not indexable.`);
  if (normalizedRelative(workspaceRoot, absolute).startsWith("../")) throw new Error(`Workspace target '${target}' is outside the workspace.`);
  return relativePath;
}

export function workspaceIgnorePatterns(manifest: WorkspaceManifest): string[] {
  return [...DEFAULT_IGNORES, ...manifest.ignore];
}

export function workspaceManifestExample(workspaceRoot: string): WorkspaceManifest {
  return defaultManifest(workspaceRoot);
}
