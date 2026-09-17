import { expect, test } from "@playwright/test";

// Each test gets a fresh browser context (isolated localStorage), so no
// explicit clearing is needed — and page.addInitScript would be the wrong
// tool anyway, since it re-runs on every navigation including page.reload().

test("shows recents and the filesystem explorer", async ({ page }) => {
  await page.goto("/?vault=phase-c-test");
  await expect(page.getByText("Recents", { exact: true })).toBeVisible();
  await expect(page.getByText("Everything", { exact: false })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Vault files" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /notes/ })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /plans/ })).toBeVisible();
  await expect(page.getByText("Plans", { exact: true })).not.toBeVisible();
});

test("folder disclosures replace the folder glyph only while the row is hovered", async ({ page }) => {
  await page.goto("/?vault=phase-c-test");
  const disclosureButton = page.getByLabel("Collapse notes");
  const folderIcon = disclosureButton.getByTestId("tree-folder-icon");
  const disclosure = disclosureButton.getByTestId("tree-disclosure");

  await expect(folderIcon).toHaveCSS("opacity", "1");
  await expect(disclosure).toHaveCSS("opacity", "0");

  await disclosureButton.hover();

  await expect(folderIcon).toHaveCSS("opacity", "0");
  await expect(disclosure).toHaveCSS("opacity", "1");
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

  const openNotesStrip = page.getByRole("tablist", { name: "Open notes" });
  await expect(openNotesStrip).toHaveClass(/cortex-tabs-scroll/);
  await expect(openNotesStrip).toHaveCSS("overflow-x", "auto");
  await expect(openNotesStrip).toHaveCSS("scrollbar-width", "none");
  const activeTabShell = page.locator('[data-active-tab="true"]');
  await expect(activeTabShell).toHaveCount(1);
  await expect(activeTabShell).toHaveClass(/bg-primary\/20/);

  const backButton = page.getByRole("button", { name: "Back", exact: true });
  const forwardButton = page.getByRole("button", { name: "Forward", exact: true });
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

test("keeps the active tab visible when the tab strip overflows", async ({ page }) => {
  await page.addInitScript(() => {
    const tabs = Array.from({ length: 8 }, (_, index) => `notes/tab-${index}.md`);
    localStorage.setItem("cortex.vaultSession.phase-c-active-tab-visibility", JSON.stringify({
      tabs,
      activeTabPath: tabs.at(-1),
      expandedTreePaths: [],
      contextPanelOpen: false,
      panel: "context",
      mode: "reading",
    }));
  });
  await page.goto("/?vault=phase-c-active-tab-visibility");

  const strip = page.getByRole("tablist", { name: "Open notes" });
  const activeShell = page.locator('[data-active-tab="true"]');
  await expect(activeShell).toHaveCount(1);
  await expect.poll(async () => {
    return strip.evaluate((element) => {
      const active = element.querySelector<HTMLElement>('[data-active-tab="true"]');
      if (!active) return false;
      const stripBox = element.getBoundingClientRect();
      const activeBox = active.getBoundingClientRect();
      const left = activeBox.left - stripBox.left + element.scrollLeft;
      const right = activeBox.right - stripBox.left + element.scrollLeft;
      return left >= element.scrollLeft - 1 && right <= element.scrollLeft + element.clientWidth + 1;
    });
  }).toBe(true);
});

test("Cmd/Ctrl+W closes the active tab and requests the window close on the last tab", async ({ page }) => {
  await page.addInitScript(() => {
    const target = window as Window & {
      __TAURI__?: { core?: { invoke?: (command: string) => Promise<void> } };
      __cortexNativeCommands?: string[];
    };
    target.__cortexNativeCommands = [];
    target.__TAURI__ = {
      core: {
        invoke: async (command) => {
          if (command === "close_main_window") target.__cortexNativeCommands?.push(command);
        },
      },
    };
  });
  await page.goto("/?vault=phase-c-cmd-w");
  const rows = page.getByTestId("note-row");
  await expect(rows.first()).toBeVisible();

  await rows.nth(0).click();
  await rows.nth(1).click();
  const tabs = page.getByTestId("open-tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Meta+w");
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Meta+w");
  await expect.poll(() => page.evaluate(() => (window as Window & { __cortexNativeCommands?: string[] }).__cortexNativeCommands)).toEqual(["close_main_window"]);
});

test("collapsing the sidebar keeps title-bar controls on one non-overlapping row", async ({ page }) => {
  await page.goto("/?vault=phase-c-collapsed-toolbar");
  const toggle = page.getByRole("button", { name: "Toggle sidebar" });
  const nodes = page.getByRole("tab", { name: "Nodes", exact: true });
  const graph = page.getByRole("tab", { name: "Graph", exact: true });
  const back = page.getByRole("button", { name: "Back", exact: true });
  const forward = page.getByRole("button", { name: "Forward", exact: true });

  await toggle.click();
  await expect(page.locator('[data-slot="sidebar"][data-state="collapsed"]')).toBeVisible();

  const [toggleBox, nodesBox, graphBox, backBox, forwardBox] = await Promise.all([toggle.boundingBox(), nodes.boundingBox(), graph.boundingBox(), back.boundingBox(), forward.boundingBox()]);
  expect(toggleBox).not.toBeNull();
  expect(nodesBox).not.toBeNull();
  expect(graphBox).not.toBeNull();
  expect(backBox).not.toBeNull();
  expect(forwardBox).not.toBeNull();
  expect(toggleBox!.width).toBeGreaterThanOrEqual(32);
  expect(toggleBox!.height).toBeGreaterThanOrEqual(32);
  expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(nodesBox!.x);
  expect(nodesBox!.x + nodesBox!.width).toBeLessThanOrEqual(graphBox!.x);
  expect(graphBox!.x + graphBox!.width).toBeLessThanOrEqual(backBox!.x);
  expect(backBox!.x + backBox!.width).toBeLessThanOrEqual(forwardBox!.x);
  expect(Math.abs((toggleBox!.y + toggleBox!.height / 2) - (backBox!.y + backBox!.height / 2))).toBeLessThanOrEqual(1);
});

test("the Nodes and Graph switcher stays available and follows the active view", async ({ page }) => {
  await page.goto("/?vault=phase-c-view-switcher");
  const toggle = page.getByRole("button", { name: "Toggle sidebar" });
  const nodes = page.getByRole("tab", { name: "Nodes", exact: true });
  const graph = page.getByRole("tab", { name: "Graph", exact: true });

  await expect(page.getByTestId("workspace-view-switcher")).toBeVisible();
  await expect(nodes).toHaveAttribute("aria-selected", "true");
  await expect(graph).toHaveAttribute("aria-selected", "false");

  await graph.click();
  await expect(page).toHaveURL(/#\/graph$/);
  await expect(graph).toHaveAttribute("aria-selected", "true");

  await toggle.click();
  await expect(page.locator('[data-slot="sidebar"][data-state="collapsed"]')).toBeVisible();
  await expect(page.getByTestId("workspace-view-switcher")).toBeVisible();

  await nodes.click();
  await expect(page).toHaveURL(/#\/notes$/);
  await expect(nodes).toHaveAttribute("aria-selected", "true");

  await toggle.click();
  await expect(page.locator('[data-slot="sidebar"][data-state="expanded"]')).toBeVisible();
  await expect(page.getByTestId("workspace-view-switcher")).toBeVisible();
});

test("recents update as notes are opened", async ({ page }) => {
  await page.goto("/?vault=phase-c-test");
  const rows = page.getByTestId("note-row");
  await expect(rows.first()).toBeVisible();
  await rows.nth(2).click();

  await expect(page.getByText("Recents", { exact: true })).toBeVisible();
});

test("note metadata shows editable properties and connected files", async ({ page }) => {
  await page.goto("/?vault=phase-c-test");
  await page.getByTestId("note-row").first().click();
  await expect(page.getByText("id", { exact: true })).toBeVisible();
  await expect(page.getByText("updated_at", { exact: true })).toBeVisible();
  await expect(page.getByText(/connected files/)).toBeVisible();
});

test("vault footer reports note and repository counts", async ({ page }) => {
  await page.goto("/?vault=phase-c-test");
  await expect(page.getByText(/\d+ notes/)).toBeVisible();
  await expect(page.getByText(/\d+ repositories/)).toBeVisible();
  await expect(page.getByText("Index current")).toBeVisible();
  await expect(page.getByTestId("workspace-status-footer")).toBeVisible();
  await expect(page.getByTestId("vault-switcher")).toBeVisible();
  await expect(page.getByTestId("vault-switcher-glyph")).toBeVisible();
});

test("vault footer exposes the theme switch beside the vault control", async ({ page }) => {
  await page.goto("/?vault=phase-c-theme");
  const toggle = page.getByTestId("theme-toggle");

  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-label", "Switch to dark theme");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", "Switch to light theme");
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("stale index status exposes a refresh action", async ({ page }) => {
  let refreshCalls = 0;
  let sourceCalls = 0;
  await page.route("**/api/note*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("source") === "true") sourceCalls += 1;
    await route.continue();
  });
  await page.route("**/api/workspace/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ active: true, phase: "current", repositories: [{ id: "sample", path: "sample", status: "stale" }], diagnostics: [] }),
    });
  });
  await page.route("**/api/index/rebuild", async (route) => {
    refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ index: { mode: "full" } }) });
  });

  await page.goto("/?vault=phase-c-stale");
  await page.getByTestId("note-row").first().click();
  await expect(page.locator("h1").first()).toBeVisible();
  const sourceCallsBeforeRefresh = sourceCalls;
  const refresh = page.getByTestId("refresh-index");
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(refresh.locator("svg")).toHaveClass(/animate-spin/);
  await expect.poll(() => refreshCalls).toBe(1);
  await expect.poll(() => sourceCalls).toBeGreaterThan(sourceCallsBeforeRefresh);
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
