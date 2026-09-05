import { expect, test } from "@playwright/test";

test("opens the note workspace and navigates its graph", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Toggle sidebar" })).toBeVisible();
  await expect(page.getByText("Project notes", { exact: true })).not.toBeVisible();
  await expect(page.getByTestId("note-row").first()).toBeVisible();

  await page.goto("/#/graph");
  await expect(page).toHaveURL(/#\/graph$/);
  await expect(page.locator(".react-flow")).toBeVisible();

  await page.goto("/#/notes");
  await expect(page.locator(".react-flow")).toHaveCount(0);
  await page.getByRole("tab", { name: "Reading", exact: true }).click();
  await expect(page.getByLabel("Markdown editor")).toBeVisible();
});

test("opens the graph page directly from its url", async ({ page }) => {
  await page.goto("/#/graph");
  await expect(page.locator(".react-flow")).toBeVisible();
});

test("searches notes and opens a result", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search notes").fill("engine");
  await expect(page.getByTestId("search-result").first()).toBeVisible();
  await page.getByTestId("search-result").first().click({ force: true });
  await expect(page.getByLabel("Markdown editor")).toBeVisible();
});
