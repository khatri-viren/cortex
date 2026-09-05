import { expect, test, type Page } from "@playwright/test";

type TestNote = {
  id: string;
  path: string;
  title: string;
  type: "note";
  created_at: string;
  updated_at: string;
  aliases: string[];
  tags: string[];
  content_hash: string;
};

function note(id: string, path: string, title: string): TestNote {
  return {
    id,
    path,
    title,
    type: "note",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    aliases: [],
    tags: [],
    content_hash: id + "-hash",
  };
}

function sourceFor(current: TestNote, body = "") {
  return {
    note: current,
    markdown: `---\nid: ${current.id}\ntitle: ${current.title}\ntype: note\ncreated_at: ${current.created_at}\nupdated_at: ${current.updated_at}\naliases: []\ntags: []\n---\n`,
    body,
    frontmatter: { ...current, applies_to: [], extra: {} },
    sections: [],
    diagnostics: [],
  };
}

async function stubNoteApi(page: Page, startWithExisting = true) {
  const notes: TestNote[] = startWithExisting ? [note("existing", "notes/existing.md", "Existing")] : [];
  let createCalls = 0;
  const events: string[] = [];

  await page.route("**/api/notes*", async (route) => {
    if (route.request().method() === "POST") {
      events.push("create");
      createCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
      const created = note(`created-${createCalls}`, `notes/untitled${createCalls === 1 ? "" : "-" + createCalls}.md`, "Untitled");
      notes.unshift(created);
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ path: created.path, id: created.id }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notes, truncated: false }) });
  });
  await page.route("**/api/note", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    events.push("update");
    const input = route.request().postDataJSON() as { note?: string; body?: string; metadata?: { title?: string } };
    const current = notes.find((candidate) => candidate.path === input.note) ?? notes[0];
    if (!current) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "No note" } }) });
      return;
    }
    if (input.metadata?.title) current.title = input.metadata.title;
    current.content_hash += "-saved";
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sourceFor(current, input.body ?? "")) });
  });
  await page.route("**/api/note?*", async (route) => {
    const selector = new URL(route.request().url()).searchParams.get("selector");
    const current = notes.find((candidate) => candidate.path === selector) ?? notes[0];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sourceFor(current)) });
  });
  await page.route("**/api/vault/tree", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rootName: "Test vault", truncated: false, children: [{ kind: "directory", path: "notes", name: "notes", children: notes.map((current) => ({ kind: "note", path: current.path, name: current.path.split("/").pop(), noteId: current.id, title: current.title, type: current.type, updated_at: current.updated_at })) }] }),
    });
  });
  await page.route("**/api/context?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ likely_files: [], attached_notes: [], related_nodes: [], relationships: [] }) });
  });
  await page.route("**/api/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", phase: 3, index: { noteCount: notes.length }, workspace: { active: false, phase: "disabled" } }) });
  });
  await page.route("**/api/workspace/status*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ active: false, phase: "disabled", repositories: [], diagnostics: [] }) });
  });
  return { getCreateCalls: () => createCalls, getEvents: () => [...events] };
}

test("creates a blank note from the toolbar, focuses its title, and ignores held Cmd/Ctrl+N", async ({ page }) => {
  const api = await stubNoteApi(page);
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.type());
    await dialog.dismiss();
  });

  await page.goto("/?vault=note-creation-toolbar");
  await expect(page.getByTestId("note-row").first()).toBeVisible();

  await page.getByTestId("new-note-button").click();
  await expect(page.getByTestId("note-creation-progress")).toBeVisible();
  await expect(page.getByTestId("new-note-button")).toBeDisabled();
  await expect.poll(api.getCreateCalls).toBe(1);
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Untitled");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeFocused();
  await expect(page.getByTestId("open-tab").last()).toHaveText("Untitled");
  expect(dialogs).toEqual([]);

  const title = page.getByRole("textbox", { name: "Note title" });
  await title.fill("Renamed");
  await title.press("Enter");
  await expect(page.locator(".cm-content").last()).toBeFocused();

  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, repeat: true, bubbles: true })));
  await expect.poll(api.getCreateCalls).toBe(1);
});

test("saves dirty edits before creating a note", async ({ page }) => {
  const api = await stubNoteApi(page);
  await page.goto("/?vault=note-creation-dirty");
  await expect(page.getByTestId("note-row").first()).toBeVisible();
  await page.getByTestId("note-row").first().click();
  await page.getByRole("tab", { name: "Live", exact: true }).click();
  const editor = page.locator(".cm-content").last();
  await editor.click();
  await editor.type("draft");

  await page.getByTestId("new-note-button").click();
  await expect.poll(api.getEvents).toEqual(["update", "create"]);
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Untitled");
});

test("Cmd/Ctrl+N creates a note from the graph route", async ({ page }) => {
  const api = await stubNoteApi(page);
  await page.goto("/?vault=note-creation-keyboard");
  await expect(page.getByTestId("note-row").first()).toBeVisible();

  await page.getByTestId("graph-view").click();
  await page.keyboard.press("Control+n");
  await expect.poll(api.getCreateCalls).toBe(1);
  await expect(page).toHaveURL(/#\/notes$/);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeFocused();
});

test("the empty document state exposes the same create action", async ({ page }) => {
  const api = await stubNoteApi(page, false);
  await page.goto("/?vault=note-creation-empty");
  const create = page.getByTestId("create-note-empty");
  await expect(create).toBeVisible();

  await create.click();
  await expect.poll(api.getCreateCalls).toBe(1);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeFocused();
});
