import { relative, resolve, sep } from "node:path";

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

export function repositoryRelativePath(repositoryRoot: string, targetPath: string): string {
  const root = resolve(repositoryRoot);
  const target = resolve(targetPath);
  const result = toPosix(relative(root, target));
  if (!result || result === ".") return ".";
  if (result === ".." || result.startsWith("../")) throw new Error(`Path '${targetPath}' is outside repository root.`);
  return result.replace(/^\.\//, "");
}

export function noteNodeId(noteId: string): string { return `note:${noteId}`; }
export function projectNodeId(): string { return "project:root"; }
export function directoryNodeId(repositoryRoot: string, targetPath: string): string { return `dir:${repositoryRelativePath(repositoryRoot, targetPath)}`; }
export function fileNodeId(repositoryRoot: string, targetPath: string): string { return `file:${repositoryRelativePath(repositoryRoot, targetPath)}`; }
export function symbolNodeId(repositoryRoot: string, targetPath: string, qualifiedName: string): string { return `symbol:${repositoryRelativePath(repositoryRoot, targetPath)}#${qualifiedName}`; }
