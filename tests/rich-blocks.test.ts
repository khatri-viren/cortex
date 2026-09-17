import { describe, expect, test } from "bun:test";
import { hasRichMarkdownBlock, parseChartSpec, richBlockKind } from "../ui/src/rich-blocks.js";

describe("rich Markdown blocks", () => {
  test("recognizes supported fences without treating prose as a block", () => {
    expect(hasRichMarkdownBlock("A mermaid word in prose.")).toBe(false);
    expect(hasRichMarkdownBlock("```mermaid\nflowchart LR\nA-->B\n```")).toBe(true);
    expect(hasRichMarkdownBlock("~~~CHART\n{}\n~~~")).toBe(true);
    expect(hasRichMarkdownBlock("```text\nmermaid\n```")).toBe(false);
  });

  test("maps fence classes to rich renderers", () => {
    expect(richBlockKind("language-mermaid")).toBe("mermaid");
    expect(richBlockKind("language-MMD")).toBe("mermaid");
    expect(richBlockKind("language-chart")).toBe("chart");
    expect(richBlockKind("language-javascript")).toBeUndefined();
  });

  test("validates and bounds the explicit chart contract", () => {
    const result = parseChartSpec(JSON.stringify({
      version: 1,
      type: "bar",
      xKey: "month",
      series: [{ key: "revenue", label: "Revenue" }],
      data: [{ month: "Jan", revenue: 120 }],
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.data[0]?.revenue).toBe(120);

    expect(parseChartSpec("not json")).toEqual({ ok: false, message: "Chart data is not valid JSON." });
    expect(parseChartSpec(JSON.stringify({ version: 1, type: "scatter", data: [{ x: 1 }] }))).toEqual({ ok: false, message: "Chart type must be bar, line, area, or pie." });
    expect(parseChartSpec(JSON.stringify({ version: 1, type: "bar", data: [{ value: null }] }))).toEqual({ ok: false, message: "Chart values must be finite numbers or strings." });
  });
});
