import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function isGitVault(vaultRoot: string): boolean {
  return existsSync(join(resolve(vaultRoot), ".git"));
}

export function requireGitVault(vaultRoot: string): string {
  const root = resolve(vaultRoot);
  if (!isGitVault(root)) throw new Error(`Vault is not a Git repository: ${root}`);
  return root;
}
