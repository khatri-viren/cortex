import { expect, test } from "@playwright/test";

test("opens the note workspace and navigates its graph", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Cortex", { exact: true })).toBeVisible();
  await expect(page.getByTestId("note-row").first()).toBeVisible();

  await page.getByRole("button", { name: "Graph" }).click();
  await expect(page).toHaveURL(/#\/graph$/);
  await expect(page.locator(".react-flow")).toBeVisible();
  await expect(page.getByTestId("workspace")).toHaveCount(0);

  await page.getByRole("button", { name: "Notes" }).click();
  await expect(page.locator(".react-flow")).toHaveCount(0);
  await page.getByRole("button", { name: "Reading" }).click();
  await expect(page.getByLabel("Markdown editor")).toBeVisible();
});

test("opens the graph page directly from its url", async ({ page }) => {
  await page.goto("/#/graph");
  await expect(page.locator(".react-flow")).toBeVisible();
});

test("searches notes and opens a result", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("Title or path").fill("engine");
  await expect(page.getByTestId("search-result").first()).toBeVisible();
  await page.getByTestId("search-result").first().click({ force: true });
  await expect(page.getByLabel("Markdown editor")).toBeVisible();
});
