import { expect, test } from "@playwright/test";

// Each test gets a fresh browser context (isolated localStorage), so no
// explicit clearing is needed — and page.addInitScript would be the wrong
// tool anyway, since it re-runs on every navigation including page.reload().

test("groups notes into recents, plans, tasks, and references", async ({ page }) => {
  await page.goto("/?vault=phase-c-test");
  await expect(page.getByText("Plans", { exact: true })).toBeVisible();
  await expect(page.getByText("Tasks", { exact: true })).toBeVisible();
  await expect(page.getByText("References", { exact: true })).toBeVisible();
});

test("opening notes adds tabs, and tabs support back/forward and close", async ({ page }) => {
  await page.goto("/?vault=phase-c-test");
  const rows = page.getByTestId("note-row");
  await expect(rows.first()).toBeVisible();

  const firstTitle = (await rows.nth(0).innerText()).trim().split("\n")[0];
  const secondTitle = (await rows.nth(1).innerText()).trim().split("\n")[0];

  await rows.nth(0).click();
  await rows.nth(1).click();

  const tabs = page.getByTestId("open-tab");
  await expect(tabs).toHaveCount(2);

  const backButton = page.getByTestId("workspace").getByRole("button", { name: "Back", exact: true });
  const forwardButton = page.getByTestId("workspace").getByRole("button", { name: "Forward", exact: true });
  await expect(backButton).toBeEnabled();
  await expect(forwardButton).toBeDisabled();

  await backButton.click();
  await expect(page.getByRole("heading", { name: firstTitle })).toBeVisible();
  await expect(forwardButton).toBeEnabled();

  await forwardButton.click();
  await expect(page.getByRole("heading", { name: secondTitle })).toBeVisible();

  await tabs.first().hover();
  await page.getByLabel(/^Close /).first().click();
  await expect(tabs).toHaveCount(1);
});

test("recents update as notes are opened", async ({ page }) => {
  await page.goto("/?vault=phase-c-test");
  const rows = page.getByTestId("note-row");
  await expect(rows.first()).toBeVisible();
  await rows.nth(2).click();

  await expect(page.getByText("Recents", { exact: true })).toBeVisible();
});

test("note header shows tags and updated time", async ({ page }) => {
  await page.goto("/?vault=phase-c-test");
  await page.getByTestId("note-row").first().click();
  await expect(page.getByText(/Updated .*(ago|just now)/)).toBeVisible();
  await expect(page.getByText(/connected files/)).toBeVisible();
});

test("vault footer reports note and repository counts", async ({ page }) => {
  await page.goto("/?vault=phase-c-test");
  await expect(page.getByText(/\d+ notes/)).toBeVisible();
  await expect(page.getByText(/\d+ repositories/)).toBeVisible();
  await expect(page.getByText("Index current")).toBeVisible();
});

test("session (open tabs) persists across reload, scoped by vault", async ({ page }) => {
  await page.goto("/?vault=phase-c-test");
  const rows = page.getByTestId("note-row");
  await expect(rows.first()).toBeVisible();
  await rows.nth(0).click();
  await rows.nth(1).click();
  await expect(page.getByTestId("open-tab")).toHaveCount(2);

  await page.reload();
  await expect(page.getByTestId("open-tab")).toHaveCount(2);

  await page.goto("/?vault=phase-c-other");
  await expect(page.getByTestId("open-tab")).toHaveCount(0);
});
