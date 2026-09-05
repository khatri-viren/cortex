import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { chromium } from "playwright-core";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { ServiceError } from "./errors.js";

const SECTION_MARKER_RE = /^\s*<!--\s*cortex:section\s+id="sec-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\s*-->\s*$/i;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const IMAGE_RE = /(<img\b[^>]*\bsrc=")([^"]+)(")/gi;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

export type MarkdownPdfInput = {
  notePath: string;
  title: string;
  body: string;
  vaultRoot: string;
};

export type NormalizedMarkdownPdf = {
  title: string;
  markdown: string;
};

function inlineCodeRanges(line: string): Array<[number, number]> {
  const runs = Array.from(line.matchAll(/`+/g), (match) => ({ index: match.index ?? 0, length: match[0].length }));
  const ranges: Array<[number, number]> = [];
  let index = 0;
  while (index < runs.length) {
    const opener = runs[index];
    const closer = runs.findIndex((run, position) => position > index && run.length === opener.length);
    if (closer === -1) {
      index += 1;
      continue;
    }
    ranges.push([opener.index, runs[closer].index + runs[closer].length]);
    index = closer + 1;
  }
  return ranges;
}

function stripSectionMarkers(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let inFence = false;
  let fenceCharacter = "";

  for (const line of lines) {
    const fence = line.match(FENCE_RE);
    if (fence) {
      const character = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceCharacter = character;
      } else if (fenceCharacter === character) {
        inFence = false;
      }
      output.push(line);
      continue;
    }
    if (!inFence && SECTION_MARKER_RE.test(line)) continue;
    output.push(line);
  }

  return output.join("\n");
}

function replaceWikilinks(body: string): string {
  const lines = body.split("\n");
  let inFence = false;
  let fenceCharacter = "";

  return lines.map((line) => {
    const fence = line.match(FENCE_RE);
    if (fence) {
      const character = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceCharacter = character;
      } else if (fenceCharacter === character) {
        inFence = false;
      }
      return line;
    }
    if (inFence) return line;

    const ranges = inlineCodeRanges(line);
    let result = "";
    let cursor = 0;
    for (const match of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (ranges.some(([from, to]) => start >= from && end <= to)) continue;
      const raw = match[1].trim();
      const [target, display] = raw.split("|", 2);
      result += line.slice(cursor, start) + (display?.trim() || target.trim());
      cursor = end;
    }
    return cursor === 0 ? line : result + line.slice(cursor);
  }).join("\n");
}

function withoutDuplicateTitleHeading(body: string, title: string): string {
  const lines = body.split("\n");
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first += 1;
  const heading = lines[first]?.match(HEADING_RE);
  if (!heading || heading[1].length !== 1) return body;
  const headingText = heading[2].trim().replace(/\s+#*$/, "");
  if (headingText.localeCompare(title.trim(), undefined, { sensitivity: "accent" }) !== 0) return body;
  lines.splice(first, 1);
  if (lines[first]?.trim() === "") lines.splice(first, 1);
  return lines.join("\n");
}

export function normalizeMarkdownForPdf(input: MarkdownPdfInput): NormalizedMarkdownPdf {
  const title = input.title.trim();
  if (!title) throw new ServiceError("INVALID_INPUT", "PDF export requires a non-empty title.");
  const withoutMarkers = stripSectionMarkers(input.body);
  const withoutDuplicate = withoutDuplicateTitleHeading(withoutMarkers, title);
  return { title, markdown: replaceWikilinks(withoutDuplicate).replace(/^\n+|\n+$/g, "") };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function imageMimeType(path: string): string | undefined {
  const extension = extname(path).toLocaleLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" } as Record<string, string>)[extension];
}

function embedLocalImages(html: string, notePath: string, vaultRoot: string): string {
    const resolvedVaultRoot = realpathSync(vaultRoot);
  return html.replace(IMAGE_RE, (whole, prefix: string, source: string, suffix: string) => {
    if (/^(?:data:|https?:|#|\/\/)/i.test(source)) return whole;
    let decoded = source;
    try {
      decoded = decodeURIComponent(source);
    } catch {
      return whole;
    }
    const candidate = resolve(dirname(notePath), decoded.split(/[?#]/, 1)[0]);
    const candidateForComparison = statSafe(candidate) ? realpathSync(candidate) : candidate;
    const relativePath = relative(resolvedVaultRoot, candidateForComparison);
    if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\")) {
      throw new ServiceError("INVALID_INPUT", `Image path escapes the vault: ${source}`);
    }
    if (!isAbsolute(candidate) || !statSafe(candidate)) return whole;
    const mime = imageMimeType(candidate);
    if (!mime) return whole;
    const data = readFileSync(candidate).toString("base64");
    return `${prefix}data:${mime};base64,${data}${suffix}`;
  });
}

function statSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function printDocument(title: string, content: string): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    @page { size: A4; }
    :root { color: #1f2937; background: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; font-size: 10.5pt; line-height: 1.55; overflow-wrap: anywhere; }
    h1, h2, h3, h4, h5, h6 { color: #111827; line-height: 1.2; break-after: avoid; }
    h1 { margin: 0 0 1.25em; font-size: 25pt; letter-spacing: -0.02em; }
    h2 { margin: 1.7em 0 0.55em; font-size: 17pt; }
    h3 { margin: 1.35em 0 0.45em; font-size: 13.5pt; }
    h4, h5, h6 { margin: 1.1em 0 0.35em; font-size: 11pt; }
    p, ul, ol, blockquote, pre, table, hr { margin: 0 0 0.9em; }
    ul, ol { padding-left: 1.5em; }
    li > ul, li > ol { margin-bottom: 0.2em; }
    a { color: #1d4ed8; text-decoration: underline; }
    blockquote { border-left: 3px solid #cbd5e1; color: #475569; padding-left: 1em; break-inside: avoid; }
    code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.9em; }
    pre { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 5px; padding: 0.8em; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }
    pre code { font-size: 8.5pt; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9pt; break-inside: auto; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; break-after: auto; }
    th, td { border: 1px solid #cbd5e1; padding: 0.45em 0.55em; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { background: #f1f5f9; color: #0f172a; }
    img { display: block; max-width: 100%; height: auto; margin: 0.75em 0; break-inside: avoid; }
    hr { border: 0; border-top: 1px solid #cbd5e1; }
    input[type="checkbox"] { margin-right: 0.45em; vertical-align: -0.08em; }
  </style>
</head>
<body><h1 class="pdf-title">${safeTitle}</h1>${content}</body>
</html>`;
}

export async function markdownToHtml(input: MarkdownPdfInput): Promise<{ title: string; html: string }> {
  const normalized = normalizeMarkdownForPdf(input);
  const content = String(await unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeStringify).process(normalized.markdown));
  return { title: normalized.title, html: printDocument(normalized.title, embedLocalImages(content, input.notePath, input.vaultRoot)) };
}

function chromiumPath(): string | undefined {
  const configured = process.env.CORTEX_CHROMIUM_PATH?.trim();
  if (configured) return configured;
  const packaged = process.env.CORTEX_PACKAGED_CHROMIUM_PATH?.trim();
  if (packaged) return packaged;
  if (process.env.CORTEX_PACKAGED === "1") return undefined;

  // `playwright-core` does not download a browser, but when a pinned browser
  // has already been installed in the developer's Playwright cache it exposes
  // the deterministic executable path. This keeps `desktop:dev` usable while
  // still requiring packaged builds to provide CORTEX_PACKAGED_CHROMIUM_PATH.
  const discovered = chromium.executablePath();
  return discovered && existsSync(discovered) ? discovered : undefined;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`PDF rendering exceeded ${milliseconds}ms.`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function renderMarkdownPdf(input: MarkdownPdfInput): Promise<Buffer> {
  const { title, html } = await markdownToHtml(input);
  const executablePath = chromiumPath();
  if (!executablePath) {
    throw new ServiceError("EXPORT_RENDERER_UNAVAILABLE", "PDF export requires a bundled Chromium executable. Set CORTEX_CHROMIUM_PATH for development.");
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 10_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    return await withTimeout(page.pdf({
      format: "A4",
      displayHeaderFooter: true,
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "24mm", right: "18mm", bottom: "18mm", left: "18mm" },
      headerTemplate: `<div style="width:100%;padding:0 18mm;color:#64748b;font:8px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escapeHtml(title)}</div>`,
      footerTemplate: `<div style="width:100%;padding:0 18mm;color:#64748b;font:8px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;text-align:right"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
    }), 15_000);
  } catch (cause) {
    if (cause instanceof ServiceError) throw cause;
    throw new ServiceError("EXPORT_RENDERER_UNAVAILABLE", `Could not render PDF: ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export function exportFilename(title: string): string {
  const slug = title.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled-note";
  return `${slug}.pdf`;
}
