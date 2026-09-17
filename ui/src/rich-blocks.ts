export type RichBlockKind = "mermaid" | "chart";

export const MAX_MERMAID_SOURCE_LENGTH = 50_000;
export const MAX_CHART_SOURCE_LENGTH = 50_000;
export const MAX_CHART_ROWS = 500;
export const MAX_CHART_SERIES = 8;

export type ChartSeries = {
  key: string;
  label?: string;
  color?: string;
};

export type ChartSpec = {
  version: 1;
  type: "bar" | "line" | "area" | "pie";
  name?: string;
  xKey?: string;
  series?: ChartSeries[];
  data: Array<Record<string, string | number>>;
};

export type ChartParseResult =
  | { ok: true; spec: ChartSpec }
  | { ok: false; message: string };

function fenceLanguage(info: string): string {
  return info.trim().split(/\s+/, 1)[0]?.toLocaleLowerCase() ?? "";
}

function isFenceStart(line: string): { marker: string; info: string } | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return undefined;
  return { marker: match[1], info: match[2] };
}

function isFenceEnd(line: string, marker: string): boolean {
  const character = marker[0];
  return new RegExp(`^ {0,3}${character}{${marker.length},}\\s*$`).test(line);
}

/** Return whether a Markdown document contains a fence Cortex can enrich. */
export function hasRichMarkdownBlock(markdown: string): boolean {
  let activeMarker: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    if (activeMarker) {
      if (isFenceEnd(line, activeMarker)) activeMarker = undefined;
      continue;
    }
    const fence = isFenceStart(line);
    if (!fence) continue;
    const language = fenceLanguage(fence.info);
    if (language === "mermaid" || language === "mmd" || language === "chart") return true;
    activeMarker = fence.marker;
  }
  return false;
}

export function richBlockKind(className: string | undefined): RichBlockKind | undefined {
  const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLocaleLowerCase();
  if (language === "mermaid" || language === "mmd") return "mermaid";
  if (language === "chart") return "chart";
  return undefined;
}

function isSafeString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeColor(value: unknown): value is string {
  return typeof value === "string" && /^(?:#[0-9a-f]{3,8}|oklch\([^\n]+\)|rgb\([^\n]+\)|hsl\([^\n]+\)|var\(--[a-z0-9-]+\))$/i.test(value);
}

/** Parse and bound the explicit chart fence contract. */
export function parseChartSpec(source: string): ChartParseResult {
  if (source.length > MAX_CHART_SOURCE_LENGTH) {
    return { ok: false, message: `Chart source is limited to ${MAX_CHART_SOURCE_LENGTH.toLocaleString()} characters.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, message: "Chart data is not valid JSON." };
  }
  if (!isRecord(parsed)) return { ok: false, message: "Chart data must be a JSON object." };
  if (parsed.version !== 1) return { ok: false, message: "Chart data must declare version 1." };
  if (parsed.type !== "bar" && parsed.type !== "line" && parsed.type !== "area" && parsed.type !== "pie") {
    return { ok: false, message: "Chart type must be bar, line, area, or pie." };
  }
  if (!Array.isArray(parsed.data) || parsed.data.length === 0 || parsed.data.length > MAX_CHART_ROWS) {
    return { ok: false, message: `Chart data must contain between 1 and ${MAX_CHART_ROWS} rows.` };
  }
  const data: Array<Record<string, string | number>> = [];
  for (const row of parsed.data) {
    if (!isRecord(row)) return { ok: false, message: "Every chart data row must be an object." };
    const safeRow: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "string") {
        if (value.length > 500) return { ok: false, message: "Chart labels are limited to 500 characters." };
        safeRow[key] = value;
      } else if (typeof value === "number" && Number.isFinite(value)) {
        safeRow[key] = value;
      } else {
        return { ok: false, message: "Chart values must be finite numbers or strings." };
      }
    }
    data.push(safeRow);
  }

  const name = parsed.name === undefined ? undefined : parsed.name;
  if (name !== undefined && !isSafeString(name, 200)) return { ok: false, message: "Chart name is invalid or too long." };
  const xKey = parsed.xKey === undefined ? undefined : parsed.xKey;
  if (xKey !== undefined && !isSafeString(xKey, 100)) return { ok: false, message: "Chart xKey is invalid or too long." };

  let series: ChartSeries[] | undefined;
  if (parsed.series !== undefined) {
    if (!Array.isArray(parsed.series) || parsed.series.length === 0 || parsed.series.length > MAX_CHART_SERIES) {
      return { ok: false, message: `Chart series must contain between 1 and ${MAX_CHART_SERIES} entries.` };
    }
    series = [];
    for (const item of parsed.series) {
      if (!isRecord(item) || !isSafeString(item.key, 100)) return { ok: false, message: "Every chart series needs a key." };
      const label = item.label === undefined ? undefined : item.label;
      const color = item.color === undefined ? undefined : item.color;
      if (label !== undefined && !isSafeString(label, 200)) return { ok: false, message: "Chart series labels are invalid or too long." };
      if (color !== undefined && !isSafeColor(color)) return { ok: false, message: "Chart series colors must be safe CSS colors." };
      series.push({ key: item.key, label, color });
    }
  }

  return {
    ok: true,
    spec: {
      version: 1,
      type: parsed.type,
      name,
      xKey,
      series,
      data,
    },
  };
}
