import { expect, test } from "@playwright/test";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";

const SAMPLE_VAULT = path.resolve(import.meta.dirname, "../../../cortex-sample-vault");

test.describe.configure({ mode: "serial" });

test("DP-03 keeps an edit made while the first save acknowledgement is pending", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const title = `S1 Ordering ${suffix}`;
  const relativePath = `notes/s1-save-${suffix}.md`;
  const absolutePath = path.join(SAMPLE_VAULT, relativePath);
  const created = await page.request.post("http://127.0.0.1:4170/api/notes", { data: { title, type: "note", path: relativePath, body: "Original body.\n" } });
  expect(created.ok()).toBe(true);
  const original = await page.request.get(`http://127.0.0.1:4170/api/note?selector=${encodeURIComponent(relativePath)}&source=true`).then((response) => response.json()) as { body: string };
  let putCount = 0;
  let releaseFirst!: () => void;
  let firstPutStarted!: () => void;
  const firstPut = new Promise<void>((resolve) => { firstPutStarted = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });

  await page.route("**/api/note", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    putCount += 1;
    if (putCount === 1) {
      firstPutStarted();
      await firstRelease;
    }
    const response = await route.fetch();
    await route.fulfill({ response });
  });

  try {
    await page.goto("/?vault=phase-s1-save-ordering");
    await page.getByLabel("Search notes").fill(title);
    const result = page.getByTestId("search-result").filter({ hasText: title });
    await expect(result).toHaveCount(1);
    await result.click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    await expect(page.getByLabel("Markdown editor")).toBeVisible();
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type("\nFirst revision.");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await firstPut;

    // Typing stays enabled while the acknowledgement is in flight.
    await page.locator(".cm-content").click();
    await page.keyboard.type("\nSecond revision while save is pending.");
    releaseFirst();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    expect(putCount).toBe(2);

    await expect.poll(async () => {
      const final = await page.request.get(`http://127.0.0.1:4170/api/note?selector=${encodeURIComponent(relativePath)}&source=true`).then((response) => response.json()) as { body: string };
      return final.body;
    }, { timeout: 5_000 }).toContain("First revision.");
    await expect.poll(async () => {
      const final = await page.request.get(`http://127.0.0.1:4170/api/note?selector=${encodeURIComponent(relativePath)}&source=true`).then((response) => response.json()) as { body: string };
      return final.body;
    }, { timeout: 5_000 }).toContain("Second revision while save is pending.");
  } finally {
    if (existsSync(absolutePath)) unlinkSync(absolutePath);
    await page.request.post("http://127.0.0.1:4170/api/index/rebuild").catch(() => undefined);
    await page.unroute("**/api/note");
  }
});

test("saving a local edit does not surface its own filesystem event as a conflict", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const title = `S1 Save Conflict ${suffix}`;
  const relativePath = `notes/s1-save-conflict-${suffix}.md`;
  const absolutePath = path.join(SAMPLE_VAULT, relativePath);
  let saveStarted = false;

  const created = await page.request.post("http://127.0.0.1:4170/api/notes", {
    data: { title, type: "note", path: relativePath, body: "Original body.\n" },
  });
  expect(created.ok()).toBe(true);

  await page.route("**/api/note", async (route) => {
    if (route.request().method() === "PUT") {
      saveStarted = true;
      return route.continue();
    }
    if (saveStarted && route.request().method() === "GET") {
      // Delay the change-event refetch until after the save acknowledgement.
      // This is the ordering that used to leave the false conflict banner
      // visible after a successful local save.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return route.continue();
  });

  try {
    await page.goto("/?vault=phase-s1-save-conflict");
    await page.getByLabel("Search notes").fill(title);
    await page.getByTestId("search-result").filter({ hasText: title }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type("\nLocal saved addition.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(page.getByText("External edit needs your decision")).not.toBeVisible();
  } finally {
    if (existsSync(absolutePath)) unlinkSync(absolutePath);
    await page.request.post("http://127.0.0.1:4170/api/index/rebuild").catch(() => undefined);
    await page.unroute("**/api/note");
  }
});

test("Cmd+S saves the active note", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const title = `S1 Cmd Save ${suffix}`;
  const relativePath = `notes/s1-cmd-save-${suffix}.md`;
  const absolutePath = path.join(SAMPLE_VAULT, relativePath);
  const created = await page.request.post("http://127.0.0.1:4170/api/notes", {
    data: { title, type: "note", path: relativePath, body: "Original body.\n" },
  });
  expect(created.ok()).toBe(true);

  try {
    await page.goto("/?vault=phase-s1-cmd-save");
    await page.getByLabel("Search notes").fill(title);
    await page.getByTestId("search-result").filter({ hasText: title }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type("\nSaved with Cmd+S.");
    await page.keyboard.press("Meta+s");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

    await expect.poll(async () => {
      const final = await page.request.get(`http://127.0.0.1:4170/api/note?selector=${encodeURIComponent(relativePath)}&source=true`).then((response) => response.json()) as { body: string };
      return final.body;
    }, { timeout: 5_000 }).toContain("Saved with Cmd+S.");
  } finally {
    if (existsSync(absolutePath)) unlinkSync(absolutePath);
    await page.request.post("http://127.0.0.1:4170/api/index/rebuild").catch(() => undefined);
  }
});

test("idle editing autosaves the active note", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const title = `S1 Autosave ${suffix}`;
  const relativePath = `notes/s1-autosave-${suffix}.md`;
  const absolutePath = path.join(SAMPLE_VAULT, relativePath);
  const created = await page.request.post("http://127.0.0.1:4170/api/notes", {
    data: { title, type: "note", path: relativePath, body: "Original body.\n" },
  });
  expect(created.ok()).toBe(true);

  try {
    await page.goto("/?vault=phase-s1-autosave");
    await page.getByLabel("Search notes").fill(title);
    await page.getByTestId("search-result").filter({ hasText: title }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type("\nSaved after an idle pause.");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0, { timeout: 5_000 });

    await expect.poll(async () => {
      const final = await page.request.get(`http://127.0.0.1:4170/api/note?selector=${encodeURIComponent(relativePath)}&source=true`).then((response) => response.json()) as { body: string };
      return final.body;
    }, { timeout: 5_000 }).toContain("Saved after an idle pause.");
  } finally {
    if (existsSync(absolutePath)) unlinkSync(absolutePath);
    await page.request.post("http://127.0.0.1:4170/api/index/rebuild").catch(() => undefined);
  }
});

test("DP-04 preserves a dirty deleted note and can restore the local draft", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const title = `S1 Deleted Draft ${suffix}`;
  const relativePath = `notes/s1-deleted-${suffix}.md`;
  const absolutePath = path.join(SAMPLE_VAULT, relativePath);
  const created = await page.request.post("http://127.0.0.1:4170/api/notes", {
    data: { title, type: "note", path: relativePath, body: "Original body.\n" },
  });
  expect(created.ok()).toBe(true);

  try {
    await page.goto("/?vault=phase-s1-delete-recovery");
    await page.getByLabel("Search notes").fill(title);
    const result = page.getByTestId("search-result").filter({ hasText: title });
    await expect(result).toHaveCount(1);
    await result.click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type("Local draft that must survive deletion.");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

    unlinkSync(absolutePath);
    await expect(page.getByTestId("deleted-note-recovery")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Your unsaved draft is preserved.")).toBeVisible();
    await page.getByRole("button", { name: "Restore local draft" }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByTestId("deleted-note-recovery")).toHaveCount(0);
    expect(existsSync(absolutePath)).toBe(true);
  } finally {
    if (existsSync(absolutePath)) unlinkSync(absolutePath);
    await page.request.post("http://127.0.0.1:4170/api/index/rebuild").catch(() => undefined);
  }
});

test("DP-04 paginates a 150-note catalog without losing the active note", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const paths: string[] = [];
  try {
    for (let index = 0; index < 150; index += 1) {
      const relativePath = `notes/s1-catalog-${suffix}-${index}.md`;
      paths.push(relativePath);
      const response = await page.request.post("http://127.0.0.1:4170/api/notes", {
        data: { title: `S1 Catalog ${suffix} ${index}`, type: "note", path: relativePath, body: `# Catalog ${index}\n` },
      });
      expect(response.ok()).toBe(true);
    }
    const firstPage = await page.request.get("http://127.0.0.1:4170/api/notes?limit=100").then((response) => response.json()) as { notes: Array<{ path: string }>; truncated: boolean; next_cursor?: string };
    expect(firstPage.notes).toHaveLength(100);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.next_cursor).toBeTruthy();

    await page.goto("/?vault=phase-s1-large-catalog");
    await page.getByLabel("Search notes").fill(`S1 Catalog ${suffix} 149`);
    const result = page.getByTestId("search-result").filter({ hasText: `S1 Catalog ${suffix} 149` });
    await expect(result).toHaveCount(1);
    await result.click();
    await expect(page.getByRole("heading", { name: `S1 Catalog ${suffix} 149`, exact: true })).toBeVisible();

    // An unrelated catalog refresh must not evict an open tab that is outside
    // the first metadata page.
    await page.request.post("http://127.0.0.1:4170/api/notes", {
      data: { title: `S1 Catalog ${suffix} extra`, type: "note", path: `notes/s1-catalog-${suffix}-extra.md`, body: "# Extra\n" },
    });
    await expect(page.getByRole("heading", { name: `S1 Catalog ${suffix} 149`, exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("open-tab")).toContainText(`S1 Catalog ${suffix} 149`);
  } finally {
    for (const relativePath of paths) {
      const absolutePath = path.join(SAMPLE_VAULT, relativePath);
      if (existsSync(absolutePath)) unlinkSync(absolutePath);
    }
    const extra = path.join(SAMPLE_VAULT, `notes/s1-catalog-${suffix}-extra.md`);
    if (existsSync(extra)) unlinkSync(extra);
    await page.request.post("http://127.0.0.1:4170/api/index/rebuild").catch(() => undefined);
  }
});
