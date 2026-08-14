import { expect, test } from "@playwright/test";

function graphNodes(page: import("@playwright/test").Page) {
  return page.getByTestId("graph-node");
}

async function clickGraphNode(locator: import("@playwright/test").Locator) {
  // React Flow positions nodes on a pannable canvas; a node can be outside
  // the browser viewport even after the canvas has fitted the full graph.
  await locator.dispatchEvent("click");
}

async function openGraph(page: import("@playwright/test").Page) {
  await page.goto("/#/graph");
  await expect(page.getByRole("heading", { name: "Graph" })).toBeVisible();
  await expect(graphNodes(page)).not.toHaveCount(0);
}

test.describe("D2-20: full graph presentation", () => {
  test("renders readable node and relationship legends with graph actions", async ({ page }) => {
    await openGraph(page);

    const legend = page.getByTestId("graph-legend");
    await expect(legend).toBeVisible();
    await expect(legend.getByText("Node kinds", { exact: true })).toBeVisible();
    await expect(legend.getByText("Relationships", { exact: true })).toBeVisible();
    await expect(legend.getByText("Directory", { exact: true })).toBeVisible();
    await expect(legend.getByText("Contains", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Fit view", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset view" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Back to (note|notes)/ })).toBeVisible();
    await expect(page.getByLabel("Search graph")).toBeVisible();
  });

  test("search focuses a matching node without hiding its relationships", async ({ page }) => {
    await openGraph(page);

    await page.getByLabel("Search graph").fill("notes");
    const result = page.getByTestId("graph-search-result").filter({ hasText: "notes" });
    await expect(result).toHaveCount(1);
    await result.click();
    await expect(graphNodes(page).filter({ hasText: /Directory.*notes/ })).toHaveAttribute("data-focused", "true");
    await expect(page.getByText("Contains", { exact: true }).first()).toBeVisible();
  });
});

test.describe("D2-21: graph navigation and destinations", () => {
  test("drills from the root to a directory, expands a note, and opens the note", async ({ page }) => {
    await openGraph(page);

    const notesDirectory = graphNodes(page).filter({ hasText: /Directory.*notes/ });
    await expect(notesDirectory).toHaveCount(1);
    await clickGraphNode(notesDirectory);
    await expect(page.getByTestId("graph-breadcrumbs")).toContainText("notes");

    const engineNotes = graphNodes(page).filter({ hasText: "Engine Notes" });
    await expect(engineNotes).toBeVisible();
    await engineNotes.getByRole("button", { name: "Expand note neighborhood" }).click();
    await expect(page.getByTestId("graph-breadcrumbs")).toContainText("Engine Notes");
    await expect(graphNodes(page).filter({ hasText: "Sample Plan" })).toBeVisible();

    await clickGraphNode(graphNodes(page).filter({ hasText: /Note.*Engine Notes/ }));
    await expect(page).toHaveURL(/#\/notes$/);
    await expect(page.getByRole("heading", { name: "Engine Notes" })).toBeVisible();
  });

  test("breadcrumbs return to the root view and the API has no dangling edges", async ({ page }) => {
    await openGraph(page);
    await clickGraphNode(graphNodes(page).filter({ hasText: /Directory.*notes/ }));

    const breadcrumbs = page.getByTestId("graph-breadcrumbs");
    await expect(breadcrumbs.getByRole("button").first()).toBeVisible();
    await breadcrumbs.getByRole("button").first().click();
    await expect(breadcrumbs).not.toContainText("notes");

    const response = await page.request.get("/api/project-map?depth=1&limit=40");
    expect(response.ok()).toBeTruthy();
    const payload = await response.json() as { anchor: { nodeId: string }; nodes: Array<{ nodeId: string }>; edges: Array<{ fromId: string; toId: string }> };
    const ids = new Set([payload.anchor.nodeId, ...payload.nodes.map((node) => node.nodeId)]);
    expect(payload.edges.every((edge) => ids.has(edge.fromId) && ids.has(edge.toId))).toBeTruthy();
  });

  test("opens a workspace code node through the repository Git destination", async ({ page }) => {
    await openGraph(page);

    const repository = graphNodes(page).filter({ hasText: /Repository.*cortex-sample-code/ });
    await expect(repository).toHaveCount(1);
    await clickGraphNode(repository);
    await clickGraphNode(graphNodes(page).filter({ hasText: /Directory.*src/ }));
    await expect(graphNodes(page).filter({ hasText: /engine\.ts/ })).toBeVisible();

    await clickGraphNode(graphNodes(page).filter({ hasText: /engine\.ts/ }));
    await expect(page).toHaveURL(/#\/notes$/);
    await expect(page.getByTestId("context-rail").getByRole("tab", { name: "Git", selected: true })).toBeVisible();
    await expect(page.getByTestId("context-rail").getByText("Showing")).toBeVisible();
    await expect(page.getByTestId("context-rail").getByText("cortex-sample-code", { exact: false })).toBeVisible();
  });
});
