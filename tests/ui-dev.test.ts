import { expect, test } from "bun:test";
import { buildVaultUrl, getApiOrigin, getRuntimeConnection } from "../ui/src/runtime.js";

test("vault URLs keep the current UI origin and identify the vault runtime", () => {
  expect(buildVaultUrl("http://127.0.0.1:5175", "vault-a", 43821)).toBe(
    "http://127.0.0.1:5175/?vault=vault-a&port=43821",
  );
  expect(buildVaultUrl("tauri://localhost/?vault=vault-a", "vault-b", 43822)).toBe(
    "tauri://localhost/?vault=vault-b&port=43822",
  );
});

test("API requests target the selected per-vault sidecar in Tauri dev", () => {
  expect(getApiOrigin("?vault=vault-a&port=43821")).toBe("http://127.0.0.1:43821");
  expect(getApiOrigin("?vault=vault-a")).toBe("");
  expect(getApiOrigin("?vault=vault-a&port=not-a-port")).toBe("");
});

test("runtime connection memoizes one origin for the active page", () => {
  const first = getRuntimeConnection("?vault=vault-a&port=43821");
  const second = getRuntimeConnection("?vault=vault-a&port=43821");
  const nextVault = getRuntimeConnection("?vault=vault-b&port=43822");
  expect(first).toBe(second);
  expect(first.origin).toBe("http://127.0.0.1:43821");
  expect(nextVault).not.toBe(first);
  expect(nextVault.origin).toBe("http://127.0.0.1:43822");
});
