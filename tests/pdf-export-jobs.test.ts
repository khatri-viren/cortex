import { describe, expect, test } from "bun:test";
import { ServiceError } from "../src/core/errors.js";
import { PDF_MAX_INPUT_BYTES, PDF_MAX_OUTPUT_BYTES, PdfExportJobManager } from "../src/core/pdf-export-jobs.js";
import { markdownToHtml, pdfRendererInfo, type PdfRenderer } from "../src/core/pdf-export.js";

const input = { notePath: "/vault/notes/example.md", title: "Example", body: "# Example\n\nBody", vaultRoot: "/vault" };

describe("bounded PDF export jobs", () => {
  test("uses an explicit offline renderer contract", () => {
    expect(pdfRendererInfo().id).toBe("chromium");
    expect(pdfRendererInfo().offline).toBe(true);
  });

  test("keeps the fidelity corpus features in the offline HTML contract", async () => {
    const rendered = await markdownToHtml({
      notePath: `${process.cwd()}/README.md`,
      vaultRoot: process.cwd(),
      title: "Fidelity corpus",
      body: "# Fidelity corpus\n\n## Sections\n\n- [x] task\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst value = 1;\n```\n\n[[Offline link]].",
    });
    expect(rendered.html).toContain("<table>");
    expect(rendered.html).toContain('type="checkbox"');
    expect(rendered.html).toContain("<pre><code");
    expect(rendered.html).toContain("break-after: avoid");
    expect(rendered.html).not.toMatch(/(?:src|href)=\"https?:/i);
  });

  test("admits one renderer and recovers across repeated exports", async () => {
    let active = 0;
    let peak = 0;
    const renderer: PdfRenderer = {
      id: "chromium",
      async render() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return Buffer.from("%PDF-1.4\nfixture\n%%EOF");
      },
    };
    const manager = new PdfExportJobManager(renderer, 4);
    for (let index = 0; index < 20; index += 1) {
      const artifact = await manager.submit({ ...input, title: `Example ${index}` });
      expect(artifact.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.timings.outputBytes).toBe(artifact.pdf.length);
    }
    expect(peak).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.stats()).toEqual({ active: false, queued: 0, maxQueuedJobs: 4, renderer: "chromium" });
  });

  test("cancels queued work and enforces the queue bound", async () => {
    let release!: () => void;
    const renderer: PdfRenderer = {
      id: "chromium",
      async render(_input, options) {
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
        return Buffer.from("pdf");
      },
    };
    const manager = new PdfExportJobManager(renderer, 1);
    const first = manager.submit(input);
    const controller = new AbortController();
    const second = manager.submit(input, { signal: controller.signal });
    const third = manager.submit(input);
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: "EXPORT_CANCELLED" });
    await expect(third).rejects.toMatchObject({ code: "EXPORT_QUEUE_FULL" });
    release();
    await expect(first).resolves.toMatchObject({ pdf: Buffer.from("pdf") });
  });

  test("rejects expired jobs before invoking the renderer", async () => {
    let calls = 0;
    const renderer: PdfRenderer = { id: "chromium", async render() { calls += 1; return Buffer.from("pdf"); } };
    const manager = new PdfExportJobManager(renderer, 1);
    const controller = new AbortController();
    controller.abort(new ServiceError("EXPORT_CANCELLED", "cancelled"));
    await expect(manager.submit(input, { signal: controller.signal })).rejects.toMatchObject({ code: "EXPORT_CANCELLED" });
    expect(calls).toBe(0);
  });

  test("rejects oversized input and output before delivery", async () => {
    const renderer: PdfRenderer = { id: "chromium", async render() { return Buffer.alloc(PDF_MAX_OUTPUT_BYTES + 1); } };
    const manager = new PdfExportJobManager(renderer);
    await expect(manager.submit({ ...input, body: "x".repeat(PDF_MAX_INPUT_BYTES + 1) })).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
    await expect(manager.submit(input)).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
  });
});
