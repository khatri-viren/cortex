import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ApiSection } from "../../src/api/contracts";
import type { NoteSummary } from "./api";
import {
  MAX_MERMAID_SOURCE_LENGTH,
  hasRichMarkdownBlock,
  parseChartSpec,
  richBlockKind,
  type ChartSeries,
  type ChartSpec,
} from "./rich-blocks";

type ReaderJumpRequest = { section: ApiSection; nonce: number };

type MarkdownReaderProps = {
  value: string;
  sections: ApiSection[];
  jumpRequest?: ReaderJumpRequest;
  notes?: NoteSummary[];
  onChange: (value: string) => void;
  onOpenNote?: (path: string) => void;
};

type MermaidState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

function slugifyHeading(text: string): string {
  return text
    .toLocaleLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function textFromChildren(children: ReactNode): string {
  return Array.isArray(children) ? children.map((child) => String(child)).join("") : String(children ?? "");
}

function replaceWikilinks(markdown: string): string {
  let fence: string | undefined;
  return markdown.split(/\r?\n/).map((line) => {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = undefined;
      return line;
    }
    if (opening) {
      fence = opening[1];
      return line;
    }
    return line.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_match, target: string, label?: string) => {
      const shown = (label ?? target).trim();
      return `[${shown}](cortex-wiki://${encodeURIComponent(target.trim())})`;
    });
  }).join("\n");
}

function useDocumentTheme(): "light" | "dark" {
  const read = () => document.documentElement.classList.contains("dark") ? "dark" as const : "light" as const;
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function RichBlockError({ kind, message, source }: { kind: string; message: string; source: string }) {
  return (
    <div className="markdown-rich-error" role="status" data-testid={`${kind}-render-error`}>
      <div className="markdown-rich-error-heading">Could not render {kind}</div>
      <div className="markdown-rich-error-message">{message}</div>
      <details>
        <summary>View source</summary>
        <pre><code>{source}</code></pre>
      </details>
    </div>
  );
}

function MermaidBlock({ source, theme }: { source: string; theme: "light" | "dark" }) {
  const id = useRef(`cortex-mermaid-${Math.random().toString(36).slice(2)}`).current;
  const [state, setState] = useState<MermaidState>({ status: "loading" });

  useEffect(() => {
    let disposed = false;
    if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
      setState({ status: "error", message: `Mermaid source is limited to ${MAX_MERMAID_SOURCE_LENGTH.toLocaleString()} characters.` });
      return () => { disposed = true; };
    }
    setState({ status: "loading" });
    void import("mermaid").then(async ({ default: mermaid }) => {
      if (disposed) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: theme === "dark" ? "dark" : "base",
        // Keep labels in native SVG text nodes so DOMPurify's SVG profile
        // does not remove them along with Mermaid's foreignObject labels.
        htmlLabels: false,
      });
      const result = await mermaid.render(id, source);
      if (disposed) return;
      const svg = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      setState({ status: "ready", svg });
    }).catch((cause: unknown) => {
      if (disposed) return;
      setState({ status: "error", message: cause instanceof Error ? cause.message : "Mermaid rejected this diagram." });
    });
    return () => { disposed = true; };
  }, [id, source, theme]);

  if (state.status === "loading") {
    return <div className="markdown-rich-loading" role="status" data-testid="mermaid-loading">Rendering diagram…</div>;
  }
  if (state.status === "error") return <RichBlockError kind="Mermaid diagram" message={state.message} source={source} />;
  return (
    <figure className="markdown-rich-figure" data-testid="mermaid-block">
      <div className="markdown-mermaid" aria-label="Rendered Mermaid diagram" dangerouslySetInnerHTML={{ __html: state.svg }} />
      <figcaption>Mermaid diagram</figcaption>
    </figure>
  );
}

function ChartTable({ spec }: { spec: ChartSpec }) {
  const keys = Object.keys(spec.data[0] ?? {});
  return (
    <details className="markdown-chart-data">
      <summary>View data table</summary>
      <div className="markdown-table-scroll">
        <table>
          <thead><tr>{keys.map((key) => <th key={key}>{key}</th>)}</tr></thead>
          <tbody>{spec.data.map((row, index) => <tr key={index}>{keys.map((key) => <td key={key}>{String(row[key] ?? "")}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}

function ChartBlock({ source }: { source: string }) {
  const parsed = useMemo(() => parseChartSpec(source), [source]);
  if (!parsed.ok) return <RichBlockError kind="chart" message={parsed.message} source={source} />;
  const { spec } = parsed;
  const series: ChartSeries[] = spec.series ?? Object.keys(spec.data[0] ?? {}).filter((key) => key !== spec.xKey).slice(0, 1).map((key) => ({ key }));
  const name = spec.name ?? "Chart";
  const xKey = spec.xKey ?? Object.keys(spec.data[0] ?? {})[0] ?? "label";
  const label = (key: string) => series.find((item) => item.key === key)?.label ?? key;
  const color = (key: string, index: number) => series.find((item) => item.key === key)?.color ?? CHART_COLORS[index % CHART_COLORS.length];
  const chart = spec.type === "pie" ? (
    <PieChart>
      <Tooltip />
      <Legend />
      <Pie data={spec.data} dataKey={series[0]?.key ?? "value"} nameKey={xKey} name={name} outerRadius="72%" label>
        {spec.data.map((_entry, index) => <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
      </Pie>
    </PieChart>
  ) : spec.type === "bar" ? (
    <BarChart data={spec.data}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey={xKey} />
      <YAxis />
      <Tooltip />
      <Legend />
      {series.map((item, index) => <Bar key={item.key} dataKey={item.key} name={label(item.key)} fill={color(item.key, index)} />)}
    </BarChart>
  ) : spec.type === "area" ? (
    <AreaChart data={spec.data}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey={xKey} />
      <YAxis />
      <Tooltip />
      <Legend />
      {series.map((item, index) => <Area key={item.key} type="monotone" dataKey={item.key} name={label(item.key)} stroke={color(item.key, index)} fill={color(item.key, index)} fillOpacity={0.22} />)}
    </AreaChart>
  ) : (
    <LineChart data={spec.data}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey={xKey} />
      <YAxis />
      <Tooltip />
      <Legend />
      {series.map((item, index) => <Line key={item.key} type="monotone" dataKey={item.key} name={label(item.key)} stroke={color(item.key, index)} />)}
    </LineChart>
  );
  return (
    <figure className="markdown-rich-figure markdown-chart" data-testid="chart-block">
      <div className="markdown-chart-frame" role="img" aria-label={name}>
        <ResponsiveContainer width="100%" height={280}>{chart}</ResponsiveContainer>
      </div>
      <figcaption>{name}</figcaption>
      <ChartTable spec={spec} />
    </figure>
  );
}

export function MarkdownReader({ value, sections, jumpRequest, notes = [], onChange, onOpenNote }: MarkdownReaderProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const theme = useDocumentTheme();
  const renderedMarkdown = useMemo(() => replaceWikilinks(value), [value]);
  let headingIndex = 0;

  useEffect(() => {
    if (!jumpRequest || !rootRef.current) return;
    const sectionIndex = sections.findIndex((section) => section.startLine === jumpRequest.section.startLine);
    const selector = sectionIndex >= 0 ? `[data-heading-index="${sectionIndex}"]` : `[data-heading-slug="${slugifyHeading(jumpRequest.section.heading)}"]`;
    rootRef.current.querySelector<HTMLElement>(selector)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [jumpRequest, sections]);

  function findNote(title: string): NoteSummary | undefined {
    const lowered = title.toLocaleLowerCase();
    return notes.find((note) => note.title.toLocaleLowerCase() === lowered || note.aliases.some((alias) => alias.toLocaleLowerCase() === lowered) || note.path.replace(/\.md$/i, "").split("/").at(-1)?.toLocaleLowerCase() === lowered);
  }

  function toggleTask(lineNumber: number, checked: boolean) {
    const lines = value.split(/\r?\n/);
    const line = lines[lineNumber - 1];
    if (!line) return;
    const next = line.replace(/^(\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]/, (_match, prefix: string) => `${prefix}[${checked ? "x" : " "}]`);
    if (next !== line) onChange(lines.map((candidate, index) => index === lineNumber - 1 ? next : candidate).join("\n"));
  }

  const heading = (level: number, children: ReactNode, props: Record<string, unknown>) => {
    const text = textFromChildren(children);
    const index = headingIndex;
    headingIndex += 1;
    const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    return <Tag {...props} id={slugifyHeading(text)} data-heading-index={index} data-heading-slug={slugifyHeading(text)}>{children}</Tag>;
  };

  const components: Components = {
    code({ className, children, ...props }) {
      const kind = richBlockKind(className);
      const source = String(children).replace(/\n$/, "");
      if (kind === "mermaid") return <MermaidBlock source={source} theme={theme} />;
      if (kind === "chart") return <ChartBlock source={source} />;
      return <code className={className} {...props}>{children}</code>;
    },
    h1: ({ children, ...props }) => heading(1, children, props),
    h2: ({ children, ...props }) => heading(2, children, props),
    h3: ({ children, ...props }) => heading(3, children, props),
    h4: ({ children, ...props }) => heading(4, children, props),
    h5: ({ children, ...props }) => heading(5, children, props),
    h6: ({ children, ...props }) => heading(6, children, props),
    input: ({ type, checked, node, ...props }) => {
      if (type !== "checkbox") return <input type={type} {...props} />;
      const lineNumber = (node as { position?: { start?: { line?: number } } } | undefined)?.position?.start?.line;
      return <input type="checkbox" checked={Boolean(checked)} disabled={!lineNumber} onChange={() => lineNumber && toggleTask(lineNumber, !checked)} {...props} />;
    },
    a: ({ href, children, ...props }) => {
      const target = href?.startsWith("cortex-wiki://") ? decodeURIComponent(href.slice("cortex-wiki://".length)) : undefined;
      return <a href={href} {...props} onClick={(event) => {
        if (target) {
          event.preventDefault();
          const note = findNote(target);
          if (note) onOpenNote?.(note.path);
          return;
        }
        if (href?.startsWith("#")) {
          event.preventDefault();
          rootRef.current?.querySelector<HTMLElement>(href)?.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        if (href) {
          event.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
        }
      }}>{children}</a>;
    },
  };

  return (
    <div ref={rootRef} className="markdown-reader" data-testid="markdown-reader" aria-label="Rendered Markdown note">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{renderedMarkdown}</ReactMarkdown>
    </div>
  );
}

export { hasRichMarkdownBlock };
