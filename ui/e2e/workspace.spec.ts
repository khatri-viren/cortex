import { expect, test } from "@playwright/test";

test("opens the note workspace and navigates its graph", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Cortex", { exact: true })).toBeVisible();
  await expect(page.locator(".note-row").first()).toBeVisible();

  await page.getByRole("button", { name: "Graph" }).click();
  await expect(page.locator(".react-flow")).toBeVisible();

  await page.getByRole("button", { name: "Reading" }).click();
  await expect(page.locator(".editor-host")).toBeVisible();
});

test("searches notes and opens a result", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("Title or path").fill("engine");
  await expect(page.locator(".search-result").first()).toBeVisible();
  await page.locator(".search-result").first().click({ force: true });
  await expect(page.locator(".editor-host")).toBeVisible();
});
