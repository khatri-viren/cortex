import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_ROOT = path.resolve(__dirname, "../../../cortex-sample-vault");
const RICH_NOTE_PATH = path.join(VAULT_ROOT, "notes/rich-rendering-test.md");
const RICH_NOTE_RELATIVE_PATH = "notes/rich-rendering-test.md";
const RICH_NOTE_BODY = `# Rich Rendering Test

This note checks ordinary Markdown, Mermaid, and explicit chart rendering.

## Workflow

\`\`\`mermaid
flowchart LR
  Draft[Draft] --> Review[Review]
  Review --> Published[Published]
\`\`\`

## Metrics

\`\`\`chart
{
  "version": 1,
  "type": "bar",
  "name": "Revenue",
  "xKey": "month",
  "series": [{"key": "revenue", "label": "Revenue"}],
  "data": [{"month": "Jan", "revenue": 120}, {"month": "Feb", "revenue": 180}]
}
\`\`\`

## Unsupported code

\`\`\`python
print("This remains a code block")
\`\`\`
`;

test.describe.configure({ mode: "serial" });

test("renders Mermaid and validated chart fences in Reading mode", async ({ page, request }) => {
  const hadOriginal = existsSync(RICH_NOTE_PATH);
  const original = hadOriginal ? readFileSync(RICH_NOTE_PATH, "utf8") : undefined;
  try {
    if (hadOriginal) unlinkSync(RICH_NOTE_PATH);
    const create = await request.post("http://127.0.0.1:4170/api/notes", {
      data: { title: "Rich Rendering Test", type: "note", path: RICH_NOTE_RELATIVE_PATH, body: RICH_NOTE_BODY },
    });
    expect(create.ok()).toBeTruthy();
    const rebuild = await request.post("http://127.0.0.1:4170/api/index/rebuild");
    expect(rebuild.ok()).toBeTruthy();

    await page.goto("/");
    const row = page.getByTestId("note-row").filter({ hasText: "Rich Rendering Test" });
    await expect(row).toHaveCount(1);
    await row.click();
    await expect(page.getByRole("heading", { name: "Rich Rendering Test", exact: true })).toBeVisible();
    await expect(page.getByTestId("markdown-reader")).toBeVisible();
    await expect(page.getByTestId("mermaid-block")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("mermaid-block").locator("svg")).toBeVisible();
    await expect(page.getByTestId("chart-block")).toBeVisible();
    await expect(page.locator("pre code").filter({ hasText: "This remains a code block" })).toBeVisible();
    await expect(page.getByText("Workflow", { exact: true })).toBeVisible();
  } finally {
    if (hadOriginal && original !== undefined) writeFileSync(RICH_NOTE_PATH, original);
    else if (existsSync(RICH_NOTE_PATH)) unlinkSync(RICH_NOTE_PATH);
    await request.post("http://127.0.0.1:4170/api/index/rebuild");
  }
});
