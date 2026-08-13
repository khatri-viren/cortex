import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fixture vault lives at ../../cortex-sample-vault relative to this file
// (cortex/ui/e2e -> Projects/cortex-sample-vault), reconstructed for these
// tests via `bun run src/cli.ts vault:init`. Notes are addressed by path so
// tests can simulate external (agent/other-writer) edits directly on disk.
const VAULT_ROOT = path.resolve(__dirname, "../../../cortex-sample-vault");
const ENGINE_NOTE = path.join(VAULT_ROOT, "notes/engine.md");
const STRESS_NOTE = path.join(VAULT_ROOT, "notes/stress-test-note.md");

// Every test in this file reads/writes the same two fixture notes on disk to
// simulate external edits — fullyParallel (playwright.config.ts) would race
// them against each other otherwise, so force this file to run serially.
test.describe.configure({ mode: "serial" });

async function openNoteByTitle(page: import("@playwright/test").Page, title: string) {
  const rows = page.getByTestId("note-row");
  await expect(rows.first()).toBeVisible();
  const row = rows.filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await row.first().click();
}

test.describe.serial("D2-14: rendered-editor stress test", () => {
  test("long, nested, link-heavy, table-heavy note loads and stays responsive in reading mode", async ({ page }) => {
    await page.goto("/?vault=phase-d-stress");
    await openNoteByTitle(page, "Stress Test Note");
    await expect(page.getByLabel("Markdown editor")).toBeVisible();
    // 40 sections plus the intro heading and "Jump Target" all appear in the
    // outline, confirming the whole document parsed and rendered.
    await expect(page.getByText("Section 1", { exact: true })).toBeVisible();

    const scroller = page.locator(".cm-scroller");
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.getByText("Jump Target", { exact: true })).toBeVisible();
  });

  test("source mode round-trips the full document without corruption", async ({ page }) => {
    const onDisk = readFileSync(STRESS_NOTE, "utf8");
    await page.goto("/?vault=phase-d-stress");
    await openNoteByTitle(page, "Stress Test Note");
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    await expect(page.getByLabel("Markdown editor")).toBeVisible();
    await expect(page.getByText("Section 40", { exact: false }).first()).toBeVisible();
    // Save should be a no-op (button disabled) since nothing was edited.
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(readFileSync(STRESS_NOTE, "utf8")).toBe(onDisk);
  });
});

test.describe("D2-16: link, wikilink, heading-anchor, and task interactions", () => {
  test("same-document heading-anchor link scrolls to the target heading", async ({ page }) => {
    await page.goto("/?vault=phase-d-anchor");
    await openNoteByTitle(page, "Stress Test Note");
    await expect(page.getByLabel("Markdown editor")).toBeVisible();

    const jumpHeading = page.getByText("Jump Target", { exact: true });
    await expect(jumpHeading).not.toBeAttached();

    await page.locator(".cm-atomic-link", { hasText: "Jump target" }).first().click();
    await expect(jumpHeading).toBeVisible();
  });

  test("wikilink click navigates to the target note", async ({ page }) => {
    await page.goto("/?vault=phase-d-wikilink");
    await openNoteByTitle(page, "Stress Test Note");
    await expect(page.getByLabel("Markdown editor")).toBeVisible();
    await page.locator(".cm-atomic-wiki-link-resolved", { hasText: "Engine Notes" }).first().click();
    await expect(page.getByRole("heading", { name: "Engine Notes" })).toBeVisible();
  });

  test("toggling a task checkbox in reading mode edits the underlying markdown", async ({ page }) => {
    const original = readFileSync(STRESS_NOTE, "utf8");
    try {
      await page.goto("/?vault=phase-d-task");
      await openNoteByTitle(page, "Stress Test Note");
      await expect(page.getByLabel("Markdown editor")).toBeVisible();
      await expect(page.getByText("Unchecked task 1.1", { exact: true })).toBeVisible();

      const checkbox = page.locator(".cm-atomic-task-checkbox").first();
      await checkbox.click();
      await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

      expect(readFileSync(STRESS_NOTE, "utf8")).toContain("[x] Unchecked task 1.1");
    } finally {
      writeFileSync(STRESS_NOTE, original);
    }
  });
});

test.describe("D2-15: live editing mode", () => {
  test("toggling between reading and live preserves scroll position", async ({ page }) => {
    await page.goto("/?vault=phase-d-live-scroll");
    await openNoteByTitle(page, "Stress Test Note");
    await expect(page.getByLabel("Markdown editor")).toBeVisible();

    const scroller = page.locator(".cm-scroller");
    await scroller.evaluate((el) => { el.scrollTop = 5000; });
    const before = await scroller.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(1000);

    await page.getByRole("tab", { name: "Live", exact: true }).click();
    const after = await scroller.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(50);
  });

  test("typing in live mode edits the document and saves", async ({ page }) => {
    const original = readFileSync(ENGINE_NOTE, "utf8");
    try {
      await page.goto("/?vault=phase-d-live-edit");
      await openNoteByTitle(page, "Engine Notes");
      await page.getByRole("tab", { name: "Live", exact: true }).click();
      await expect(page.getByLabel("Markdown editor")).toBeVisible();
      await expect(page.getByText("The Bun backend owns parsing and vault diagnostics.")).toBeVisible();

      await page.getByText("The Bun backend owns parsing and vault diagnostics.").click();
      await page.keyboard.press("End");
      await page.keyboard.type(" Edited live.");
      await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

      expect(readFileSync(ENGINE_NOTE, "utf8")).toContain("Edited live.");
    } finally {
      writeFileSync(ENGINE_NOTE, original);
    }
  });
});

test.describe("D2-17: external change, unsaved, and conflict presentation", () => {
  test("a clean note reloads automatically when the file changes externally", async ({ page }) => {
    const original = readFileSync(ENGINE_NOTE, "utf8");
    try {
      await page.goto("/?vault=phase-d-external-clean");
      await openNoteByTitle(page, "Engine Notes");
      await expect(page.getByLabel("Markdown editor")).toBeVisible();
      await expect(page.getByText("The Bun backend owns parsing and vault diagnostics.")).toBeVisible();

      writeFileSync(ENGINE_NOTE, original.replace("owns parsing", "owns parsing and externally-edited content"));

      await expect(page.getByText("owns parsing and externally-edited content")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/Reloaded external change/)).toBeVisible();
    } finally {
      writeFileSync(ENGINE_NOTE, original);
    }
  });

  test("a dirty note surfaces a conflict banner on external change, and both resolutions work", async ({ page }) => {
    const original = readFileSync(ENGINE_NOTE, "utf8");
    try {
      await page.goto("/?vault=phase-d-conflict");
      await openNoteByTitle(page, "Engine Notes");
      await page.getByRole("tab", { name: "Source", exact: true }).click();
      await expect(page.getByLabel("Markdown editor")).toBeVisible();
      await page.locator(".cm-content").click();
      await page.keyboard.type("\nLocal unsaved addition.");
      await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();

      writeFileSync(ENGINE_NOTE, original + "\nExternal concurrent addition.\n");

      await expect(page.getByText("External edit needs your decision")).toBeVisible({ timeout: 10_000 });

      await page.getByRole("button", { name: "Take theirs" }).click();
      await expect(page.getByText("External edit needs your decision")).not.toBeVisible();
      await expect(page.getByText("Local unsaved addition.")).not.toBeVisible();
      await expect(page.getByText("External concurrent addition.")).toBeVisible();
    } finally {
      writeFileSync(ENGINE_NOTE, original);
    }
  });

  test("switching notes with unsaved changes prompts for confirmation", async ({ page }) => {
    await page.goto("/?vault=phase-d-unsaved-guard");
    await openNoteByTitle(page, "Engine Notes");
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    await expect(page.getByLabel("Markdown editor")).toBeVisible();
    await page.locator(".cm-content").click();
    await page.keyboard.type("Unsaved edit.");
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();

    let dialogSeen = false;
    page.once("dialog", (dialog) => {
      dialogSeen = true;
      void dialog.dismiss();
    });
    await openNoteByTitle(page, "Sample Plan");
    await expect.poll(() => dialogSeen).toBe(true);
    // Dismissed: still on the original note, edit intact.
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();

    page.once("dialog", (dialog) => void dialog.accept());
    await openNoteByTitle(page, "Sample Plan");
    await expect(page.getByRole("heading", { name: "Sample Plan" })).toBeVisible();
  });
});
