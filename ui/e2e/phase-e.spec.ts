import { expect, test } from "@playwright/test";

// Fixture vault: cortex-sample-vault + cortex-sample-code workspace (see
// playwright.config.ts's webServer and workspace.yaml in the vault). Engine
// Notes carries real applies_to relations (implements src/engine.ts, owns
// src) plus a wikilink to Sample Plan, and is itself wikilinked from Stress
// Test Note and Project Map — enough real cross-repo/relationship data to
// exercise every D2-18/D2-19 acceptance criterion without mocking anything.

async function openNoteByTitle(page: import("@playwright/test").Page, title: string) {
  const rows = page.getByTestId("note-row");
  await expect(rows.first()).toBeVisible();
  let row = rows.filter({ hasText: title });
  if (await row.count() === 0 && title === "Sample Plan") {
    const plans = page.getByRole("treeitem", { name: /plans/ });
    await expect(plans).toBeVisible();
    if (await plans.getAttribute("aria-expanded") !== "true") await plans.click();
    row = rows.filter({ hasText: title });
  }
  await expect(row).toHaveCount(1);
  await row.first().click();
  // The rail's Context/Git/Diagnostics panels render an empty state until
  // the note's source (and its context/diagnostics) finish loading — wait
  // for the requested note title and editor before interacting with the rail,
  // or a slow fetch under concurrent test workers races the assertion.
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel("Markdown editor")).toBeVisible();
  await page.getByLabel("Open inspector").click();
  await expect(rail(page)).toBeVisible();
}

function rail(page: import("@playwright/test").Page) {
  return page.getByTestId("context-rail");
}

test.describe("D2-18: context rail relationship labels and destinations", () => {
  test("Context is the default panel and shows Implements/Related notes/Owned by with real cross-repo data", async ({ page }) => {
    await page.goto("/");
    await openNoteByTitle(page, "Engine Notes");

    await expect(rail(page).getByRole("tab", { name: "Context", selected: true })).toBeVisible();

    await expect(rail(page).getByText("Repository", { exact: true })).toBeVisible();
    await expect(rail(page).getByText("cortex-sample-code")).toBeVisible();
    await expect(rail(page).getByText("cortex-sample-vault")).toBeVisible();

    await expect(rail(page).getByRole("button", { name: "Implements" })).toContainText("1");
    await expect(rail(page).getByRole("button", { name: /^engine\.ts/ })).toBeVisible();

    await expect(rail(page).getByRole("button", { name: "Related notes" })).toContainText("3");
    await expect(rail(page).getByRole("button", { name: "Sample Plan", exact: true })).toBeVisible();
    await expect(rail(page).getByRole("button", { name: "Stress Test Note", exact: true })).toBeVisible();
    await expect(rail(page).getByRole("button", { name: "Project Map", exact: true })).toBeVisible();

    await expect(rail(page).getByRole("button", { name: "Owned by" })).toContainText("1");
    await expect(rail(page).getByRole("button", { name: /^src\b/ })).toBeVisible();
  });

  test("shows empty-state copy for a note with no code/ownership relations", async ({ page }) => {
    await page.goto("/");
    await openNoteByTitle(page, "Sample Plan");

    await expect(rail(page).getByText("Doesn't implement any connected source modules.")).toBeVisible();
    await expect(rail(page).getByText("No project or repository ownership recorded.")).toBeVisible();
    await expect(rail(page).getByRole("button", { name: "Engine Notes", exact: true })).toBeVisible();
  });

  test("clicking a note relationship navigates to that note", async ({ page }) => {
    await page.goto("/");
    await openNoteByTitle(page, "Engine Notes");
    await rail(page).getByRole("button", { name: "Sample Plan", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sample Plan" })).toBeVisible();
  });

  test("clicking a code relationship switches the Git tab to that file's repository-scoped history", async ({ page }) => {
    await page.goto("/");
    await openNoteByTitle(page, "Engine Notes");
    await rail(page).getByRole("button", { name: /^engine\.ts/ }).click();

    await expect(rail(page).getByRole("tab", { name: "Git", selected: true })).toBeVisible();
    await expect(rail(page).getByText("Showing")).toBeVisible();
    await expect(rail(page).getByText("cortex-sample-code", { exact: false })).toBeVisible();
    await expect(rail(page).getByRole("button", { name: "Back to note" })).toBeVisible();
  });

  test("Back to note returns the Git tab to the active note's own history", async ({ page }) => {
    await page.goto("/");
    await openNoteByTitle(page, "Engine Notes");
    await rail(page).getByRole("button", { name: /^engine\.ts/ }).click();
    await rail(page).getByRole("button", { name: "Back to note" }).click();
    await expect(rail(page).getByText("Showing")).not.toBeVisible();
  });

  test("RailGroup sections collapse and re-expand", async ({ page }) => {
    await page.goto("/");
    await openNoteByTitle(page, "Engine Notes");

    const relatedLabel = rail(page).getByRole("button", { name: /Related notes/ });
    const samplePlanItem = rail(page).getByRole("button", { name: "Sample Plan", exact: true });
    await expect(samplePlanItem).toBeVisible();
    await relatedLabel.click();
    await expect(samplePlanItem).not.toBeVisible();
    await relatedLabel.click();
    await expect(samplePlanItem).toBeVisible();
  });

  test("View in graph opens the graph pane centered on the active note", async ({ page }) => {
    await page.goto("/");
    await openNoteByTitle(page, "Engine Notes");
    await rail(page).getByRole("button", { name: "View in graph" }).click();

    await expect(page.locator(".react-flow")).toBeVisible();
    // The graph pane's layout can take longer than the default 5s under
    // parallel test-worker contention (observed flaky at 4 workers, stable
    // in isolation) — this is real render work, not a hung app, so give it
    // more room rather than serializing the whole file over it.
    await expect(page.getByTestId("graph-breadcrumbs")).toContainText("Engine Notes", { timeout: 15_000 });
    expect(page.url()).toContain("#/graph/note");
  });
});

test.describe("D2-19: outline, Git, and diagnostics panels", () => {
  test("Outline tab lists headings and jumps the reading pane to a clicked one", async ({ page }) => {
    await page.goto("/");
    await openNoteByTitle(page, "Stress Test Note");
    await page.getByLabel("Close inspector").click();
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    await page.getByLabel("Open inspector").click();
    await rail(page).getByRole("tab", { name: "Outline" }).click();

    const items = page.getByTestId("rail-outline-item");
    await expect(items.first()).toBeVisible();
    await expect(items.filter({ hasText: "Jump Target" })).toHaveCount(1);

    await items.filter({ hasText: "Jump Target" }).click();
    // Jumping switches out of Source mode into Reading so the target text is visible.
    await expect(page.getByRole("tab", { name: "Reading", exact: true, selected: true })).toBeVisible();
    await expect(page.getByText("Jump Target", { exact: true })).toBeVisible();
  });

  test("reading surface keeps one color and the outline follows scrolling", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await page.goto("/");
    await openNoteByTitle(page, "Stress Test Note");
    await page.getByLabel("Close inspector").click();
    await page.getByRole("tab", { name: "Reading", exact: true }).click();

    const colors = await page.evaluate(() => ({
      toolbar: getComputedStyle(document.querySelector(".note-toolbar-surface")!).backgroundColor,
      metadata: getComputedStyle(document.querySelector(".note-metadata")!).backgroundColor,
      reader: getComputedStyle(document.querySelector(".atomic-editor-host")!).backgroundColor,
    }));
    expect(colors.metadata).toBe(colors.reader);
    expect(colors.toolbar).toBe(colors.reader);

    const geometry = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>("[data-testid=note-document-scroll]");
      const editor = document.querySelector<HTMLElement>(".note-editor-section > div");
      const content = document.querySelector<HTMLElement>(".cm-content");
      const outline = document.querySelector<HTMLElement>("nav[aria-label='Section outline']");
      if (!viewport || !editor || !content || !outline) return null;
      const viewportRect = viewport.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const outlineRect = outline.getBoundingClientRect();
      return {
        viewportCenter: viewportRect.left + viewportRect.width / 2,
        editorCenter: editorRect.left + editorRect.width / 2,
        contentCenter: contentRect.left + contentRect.width / 2,
        editorWidth: editorRect.width,
        viewportWidth: viewportRect.width,
        outlineRight: outlineRect.right,
        editorRight: editorRect.right,
      };
    });
    expect(geometry).not.toBeNull();
    expect(Math.abs(geometry!.editorCenter - geometry!.viewportCenter)).toBeLessThan(2);
    expect(Math.abs(geometry!.contentCenter - geometry!.viewportCenter)).toBeLessThan(2);
    expect(Math.abs(geometry!.editorWidth - geometry!.viewportWidth)).toBeLessThan(2);
    expect(Math.abs(geometry!.outlineRight - geometry!.editorRight)).toBeLessThan(2);

    const documentScroll = page.getByTestId("note-document-scroll");
    await documentScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const outlineStack = page.getByTestId("outline-stack");
    const scroller = page.locator(".cm-scroller");
    await expect(outlineStack).toBeVisible();
    const visibleCenterDelta = () => page.evaluate(() => {
      const nav = [...document.querySelectorAll("nav")].find((element) => element.getAttribute("aria-label") === "Section outline");
      const stack = nav?.querySelector<HTMLElement>("[data-testid=outline-stack]");
      const viewport = document.querySelector<HTMLElement>("[data-testid=note-document-scroll]");
      const reader = document.querySelector<HTMLElement>(".cm-scroller");
      if (!stack || !viewport || !reader) return Number.POSITIVE_INFINITY;
      const stackRect = stack.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const readerRect = reader.getBoundingClientRect();
      const visibleTop = Math.max(readerRect.top, viewportRect.top);
      const visibleBottom = Math.min(readerRect.bottom, viewportRect.bottom);
      if (visibleBottom <= visibleTop) return Number.POSITIVE_INFINITY;
      return Math.abs((stackRect.top + stackRect.bottom) / 2 - (visibleTop + visibleBottom) / 2);
    });
    await documentScroll.evaluate((element) => { element.scrollTop = Math.min(100, element.scrollHeight); });
    await expect.poll(visibleCenterDelta).toBeLessThan(12);
    await documentScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(visibleCenterDelta).toBeLessThan(12);

    const activeBefore = await page.locator('[data-testid="outline-tick"]').evaluateAll((ticks) => ticks.findIndex((tick) => tick.getAttribute("aria-current") === "true"));
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(async () => page.locator('[data-testid="outline-tick"]').evaluateAll((ticks) => ticks.findIndex((tick) => tick.getAttribute("aria-current") === "true"))).toBeGreaterThan(activeBefore);
    const lastTickIndex = await page.locator('[data-testid="outline-tick"]').count() - 1;
    await expect.poll(async () => page.locator('[data-testid="outline-tick"]').evaluateAll((ticks) => ticks.findIndex((tick) => tick.getAttribute("aria-current") === "true"))).toBe(lastTickIndex);
  });

  test("Git tab shows the active note's own history and diff by default", async ({ page }) => {
    await page.goto("/");
    await openNoteByTitle(page, "Engine Notes");
    await rail(page).getByRole("tab", { name: "Git" }).click();

    // Git history is a separate async fetch from the note's own content, so
    // wait for the actual commit to render rather than the static "History"
    // label — asserting on real loaded data avoids racing that fetch.
    await expect(rail(page).getByText("Initial sample vault fixture for e2e tests")).toBeVisible();
    await expect(rail(page).getByText("Diff", { exact: true })).toBeVisible();
  });

  test("Diagnostics tab shows per-note and vault-wide sections", async ({ page }) => {
    await page.goto("/");
    await openNoteByTitle(page, "Engine Notes");
    await rail(page).getByRole("tab", { name: "Diagnostics" }).click();

    await expect(rail(page).getByRole("button", { name: "This note" })).toBeVisible();
    await expect(rail(page).getByText("No diagnostics for the selected note.")).toBeVisible();
    // The fixture vault genuinely has pre-existing missing-section-id
    // warnings (headings without a cortex:section marker), so assert on
    // that real content rather than assuming an empty vault.
    await expect(rail(page).getByRole("button", { name: "Vault" })).toBeVisible();
    await expect(rail(page).getByText(/warning: Heading .* has no section ID\./).first()).toBeVisible();
  });

  test("panel selection persists across the four tabs without losing the active note", async ({ page }) => {
    await page.goto("/");
    await openNoteByTitle(page, "Engine Notes");
    for (const tab of ["Outline", "Git", "Diagnostics", "Context"]) {
      await rail(page).getByRole("tab", { name: tab, exact: true }).click();
      await expect(page.getByRole("heading", { name: "Engine Notes" })).toBeVisible();
    }
  });
});
