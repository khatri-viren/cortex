import { expect, test, type Locator, type Page } from "@playwright/test";

const intro = "# Table editing regression\n\n" + Array.from({ length: 35 }, (_, i) => `Paragraph ${i}: context above the review table.\n\n`).join("");
const table = "| Item | Description | Owner | Decision | Notes |\n| --- | --- | --- | --- | --- |\n" + Array.from({ length: 16 }, (_, i) => `| ITEM-${i} | ${"A long description that wraps across lines. ".repeat(5).trim()} | Owner ${i} | ${i === 12 ? "ok" : "pending"} | Retain this cell |\n`).join("");
const tail = Array.from({ length: 8 }, (_, i) => `\n## Later section ${i}\n\n${table.replaceAll("ITEM-", `LATER-${i}-`)}\nSection ${i} must survive.\n`).join("") + "\nEND OF DOCUMENT\n";
const original = intro + table + tail;
const expectedEmpty = original.replace("| Owner 12 | ok |", "| Owner 12 |  |");
// Full-document equality below catches any lost suffix, changed sibling cell,
// or Markdown damage, even when the visible cell appears to edit correctly.
const documentText = (page: Page) => page.evaluate(() => (window as any).editorDocument() as string);
async function caret(cell: Locator, end = true) {
  await cell.evaluate((el, atEnd) => {
    (el as HTMLElement).focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(!atEnd);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, end);
}
async function openCell(page: Page) {
  await page.goto("/e2e/fixtures/live-editor.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof (window as any).mountEditor === "function");
  await page.evaluate(body => (window as any).mountEditor(body), original);
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.evaluate(pos => (window as any).revealPosition(pos), original.indexOf("| ITEM-12 |"));
  const cell = page.locator(".cm-atomic-table tr").filter({ has: page.locator("td").first().filter({ hasText: /^ITEM-12$/ }) }).locator(".cm-atomic-table-cell-source").nth(3);
  await cell.click();
  await caret(cell);
  await expect(cell).toBeFocused();
  return cell;
}

for (const direction of ["above", "below"] as const) {
  test(`Backspace after scrolling ${direction} a focused table preserves every other cell and section`, async ({ page }) => {
    const cell = await openCell(page);
    await page.mouse.move(800, 350);
    await page.mouse.wheel(0, direction === "above" ? -5000 : 12000);
    // Allow CM to virtualize the old viewport. Keyboard input must still target
    // the original cell; do not refocus it or use locator.press (auto-scroll).
    await page.waitForTimeout(300);
    const viewport = await page.locator(".note-document-scroll").boundingBox();
    const box = await cell.boundingBox();
    expect(box!.y + box!.height < viewport!.y || box!.y > viewport!.y + viewport!.height).toBeTruthy();
    await expect(cell).toBeFocused();
    for (let i = 0; i < 8; i++) await page.keyboard.press("Backspace");
    await expect.poll(() => documentText(page)).toBe(expectedEmpty);
    await expect(cell).toHaveText("");
    await page.keyboard.type("hello world");
    await expect(cell).toHaveText("hello world");
    await expect.poll(() => documentText(page)).toBe(original.replace("| Owner 12 | ok |", "| Owner 12 | hello world |"));
  });
}

test("deletion at either cell boundary and selected-text deletion stay inside the cell", async ({ page }) => {
  const cell = await openCell(page);
  await caret(cell, false);
  await page.keyboard.press("Backspace");
  await expect.poll(() => documentText(page)).toBe(original);
  await caret(cell);
  await page.keyboard.press("Delete");
  await expect.poll(() => documentText(page)).toBe(original);
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect.poll(() => documentText(page)).toBe(original.replace("| Owner 12 | ok |", "| Owner 12 | o |"));
});
