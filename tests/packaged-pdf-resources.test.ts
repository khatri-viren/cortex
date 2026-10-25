import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundledChromiumPath } from "../src/core/pdf-export.js";

test("packaged Chromium discovery works without a desktop-provided environment", () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-pdf-resources-"));
  try {
    const executable = join(root, "Contents/MacOS/cortex-sidecar");
    const browser = join(root, "Contents/Resources/chromium/Chromium.app/Contents/MacOS/Google Chrome for Testing");
    mkdirSync(dirname(browser), { recursive: true });
    writeFileSync(browser, "fixture");
    expect(bundledChromiumPath(executable, "darwin")).toBe(browser);
    expect(bundledChromiumPath(join(root, "missing/MacOS/cortex-sidecar"), "darwin")).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
