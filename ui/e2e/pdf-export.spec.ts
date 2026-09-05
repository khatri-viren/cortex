import { expect, test } from "@playwright/test";

test("exports the current unsaved note draft as a PDF download", async ({ page }) => {
  let requestBody: { note?: string; body?: string; title?: string } | undefined;
  await page.route("**/api/note/export/pdf", async (route) => {
    requestBody = route.request().postDataJSON() as typeof requestBody;
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="exported-draft.pdf"',
      },
      body: "%PDF-1.4\nmock export\n%%EOF",
    });
  });

  await page.goto("/?vault=phase-c-pdf-export");
  await page.getByTestId("note-row").first().click();
  await expect(page.getByRole("button", { name: "Export PDF" })).toBeEnabled();

  await page.locator('input[aria-label="Note title"]').fill("Exported Draft");
  await page.getByRole("tab", { name: "Source", exact: true }).click();
  await page.locator(".cm-content").fill("# Draft body\n\nThis was not saved.");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PDF" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("exported-draft.pdf");
  expect(requestBody?.title).toBe("Exported Draft");
  expect(requestBody?.body).toContain("This was not saved.");
  expect(requestBody?.note).toBeTruthy();
  await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();
});
