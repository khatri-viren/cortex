import { expect, test } from "bun:test";
import { buildVaultUrl, getApiOrigin } from "../ui/src/runtime.js";

test("dev vault URLs keep the Vite origin and identify the vault runtime", () => {
  expect(buildVaultUrl("http://127.0.0.1:5175", "vault-a", 43821)).toBe(
    "http://127.0.0.1:5175/?vault=vault-a&port=43821",
  );
});

test("API requests target the selected per-vault sidecar in Tauri dev", () => {
  expect(getApiOrigin("?vault=vault-a&port=43821")).toBe("http://127.0.0.1:43821");
  expect(getApiOrigin("?vault=vault-a")).toBe("");
  expect(getApiOrigin("?vault=vault-a&port=not-a-port")).toBe("");
});
