import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const vault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../cortex-sample-vault");
const relative = "notes/document-width-table-test.md";
const file = path.join(vault, relative);

test("full width and live table resizing preserve Markdown editing", async ({ page, request }) => {
  const original = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  try {
    if (original !== undefined) unlinkSync(file);
    const created = await request.post("http://127.0.0.1:4170/api/notes", { data: {
      title: "Width Table Test", type: "note", path: relative,
      body: "# Width Table Test\n\n| Name | Description |\n| --- | --- |\n| One | A long description with many words that should wrap within its column. |\n",
    } });
    expect(created.ok()).toBeTruthy();
    await request.post("http://127.0.0.1:4170/api/index/rebuild");
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/");
    await page.getByTestId("note-row").filter({ hasText: "Width Table Test" }).click();
    const full = page.getByRole("button", { name: "Full width" });
    const metadata = page.getByLabel("Note metadata");
    const before = (await metadata.boundingBox())!.width;
    await full.click();
    expect((await metadata.boundingBox())!.width).toBeGreaterThan(before + 100);
    await page.getByRole("tab", { name: "Live" }).click();
    const handle = page.getByRole("button", { name: "Resize column 2" });
    await expect(handle).toBeVisible();
    const header = page.locator(".cm-atomic-table th").nth(1);
    const width = (await header.boundingBox())!.width;
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await header.boundingBox())!.width).toBeLessThan(width);
    const dragStart = await handle.boundingBox();
    await page.mouse.move(dragStart!.x + dragStart!.width / 2, dragStart!.y + dragStart!.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragStart!.x + dragStart!.width / 2 - 40, dragStart!.y + dragStart!.height / 2);
    await page.mouse.up();
    await expect.poll(async () => (await header.boundingBox())!.width).toBeLessThan(width - 20);
    const source = page.locator(".cm-atomic-table td .cm-atomic-table-cell-source").nth(1);
    await expect(source).toHaveCSS("overflow-wrap", "anywhere");
    await source.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Edited");
    await expect(source).toContainText("Edited");
    await expect.poll(() => readFileSync(file, "utf8"), { timeout: 10_000 }).toContain("Edited");
    await page.reload();
    await expect(full).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".cm-atomic-table td .cm-atomic-table-cell-source").nth(1)).toContainText("Edited");
  } finally {
    if (original !== undefined) writeFileSync(file, original);
    else if (existsSync(file)) unlinkSync(file);
    await request.post("http://127.0.0.1:4170/api/index/rebuild");
  }
});
