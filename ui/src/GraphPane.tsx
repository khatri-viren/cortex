import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow } from "@xyflow/react";
import type { Edge, Node, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getProjectMap, getWorkspaceStatus } from "./api";
import type { ApiGraph, ApiWorkspaceStatus } from "../../src/api/contracts";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { NetworkIcon } from "lucide-react";

const COLUMN_WIDTH = 190;
const ROW_HEIGHT = 100;

function layoutByLevel(graph: ApiGraph): Map<string, { x: number; y: number }> {
  const neighbors = new Map<string, string[]>();
  for (const node of [graph.anchor, ...graph.nodes]) neighbors.set(node.nodeId, []);
  for (const edge of graph.edges) {
    neighbors.get(edge.fromId)?.push(edge.toId);
    neighbors.get(edge.toId)?.push(edge.fromId);
  }

  const levels: string[][] = [[graph.anchor.nodeId]];
  const visited = new Set([graph.anchor.nodeId]);
  let frontier = [graph.anchor.nodeId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const neighborId of neighbors.get(nodeId) ?? []) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        next.push(neighborId);
      }
    }
    if (next.length === 0) break;
    levels.push(next);
    frontier = next;
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, ids] of levels.entries()) {
    const offset = ((ids.length - 1) * COLUMN_WIDTH) / 2;
    ids.forEach((nodeId, index) => positions.set(nodeId, { x: index * COLUMN_WIDTH - offset, y: level * ROW_HEIGHT }));
  }
  return positions;
}

type GraphPaneProps = {
  onOpenPath: (path: string) => void;
};

const CONTAINER_KINDS = new Set(["project", "repository", "directory"]);
const LEAF_CODE_KINDS = new Set(["file", "test", "configuration", "module", "symbol", "package"]);

function nodeStyle(kind: string): CSSProperties {
  if (kind === "note") {
    return {
      border: "1px solid var(--primary)",
      background: "color-mix(in oklch, var(--primary) 14%, var(--background))",
      color: "var(--foreground)",
    };
  }
  if (CONTAINER_KINDS.has(kind)) {
    return {
      border: "1px solid oklch(from var(--primary) l c calc(h + 140))",
      background: "color-mix(in oklch, oklch(from var(--primary) l c calc(h + 140)) 12%, var(--background))",
      color: "var(--foreground)",
      cursor: "pointer",
    };
  }
  if (LEAF_CODE_KINDS.has(kind)) {
    return { border: "1px dashed var(--border)", background: "var(--muted)", color: "var(--muted-foreground)", opacity: 0.85 };
  }
  return { border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)" };
}

function nodeColor(kind: string): string {
  if (kind === "note") return "var(--primary)";
  if (CONTAINER_KINDS.has(kind)) return "oklch(from var(--primary) l c calc(h + 140))";
  return "var(--muted-foreground)";
}

type NoteNodeData = { label: string; kind: string; path?: string; onDrill: () => void };

function NoteNodeContent({ data }: NodeProps & { data: NoteNodeData }) {
  return (
    <div className="flex items-center justify-between gap-1.5">
      <Handle type="target" position={Position.Top} />
      <span className="truncate">{data.label}</span>
      <button
        type="button"
        title="Show this note's neighborhood"
        onClick={(event) => {
          event.stopPropagation();
          data.onDrill();
        }}
        className="grid h-4 w-4 shrink-0 place-items-center rounded-sm border border-primary bg-transparent text-[10px] leading-none text-primary hover:bg-primary hover:text-primary-foreground"
      >
        +
      </button>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function workspaceLine(status?: ApiWorkspaceStatus): string | undefined {
  if (!status || !status.active) return undefined;
  const ready = status.repositories.filter((repo) => repo.status === "ready");
  const stale = status.repositories.filter((repo) => repo.status !== "ready");
  const parts = [ready.length + " repositor" + (ready.length === 1 ? "y" : "ies") + (ready.length ? " (" + ready.map((repo) => repo.id).join(", ") + ")" : "")];
  if (stale.length > 0) parts.push(stale.length + " stale (" + stale.map((repo) => repo.id).join(", ") + ")");
  return "Workspace: " + parts.join("; ") + ".";
}

const nodeTypes = { note: NoteNodeContent };

export function GraphPane({ onOpenPath }: GraphPaneProps) {
  const [graph, setGraph] = useState<ApiGraph>();
  const [workspace, setWorkspace] = useState<ApiWorkspaceStatus>();
  const [error, setError] = useState<string>();
  const [center, setCenter] = useState<string>();
  const [trail, setTrail] = useState<Array<{ nodeId: string; name: string }>>([]);

  useEffect(() => {
    getWorkspaceStatus().then(setWorkspace).catch(() => setWorkspace(undefined));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getProjectMap(center)
      .then((fetched) => {
        if (cancelled) return;
        setGraph(fetched);
        setTrail((prev) => (prev.length === 0 ? [{ nodeId: fetched.anchor.nodeId, name: fetched.anchor.name }] : prev));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [center]);

  function drillInto(nodeId: string, name: string) {
    setTrail((prev) => [...prev, { nodeId, name }]);
    setCenter(nodeId);
  }

  function jumpTo(index: number) {
    setTrail((prev) => prev.slice(0, index + 1));
    setCenter(index === 0 ? undefined : trail[index].nodeId);
  }

  const nodes = useMemo<Node[]>(() => {
    if (!graph) return [];
    const positions = layoutByLevel(graph);
    return [graph.anchor, ...graph.nodes].map((node) => ({
      id: node.nodeId,
      type: node.kind === "note" ? "note" : undefined,
      position: positions.get(node.nodeId) ?? { x: 0, y: 0 },
      data: { label: node.name, kind: node.kind, path: node.path, onDrill: () => drillInto(node.nodeId, node.name) },
      style: { borderRadius: 4, fontSize: 11, padding: 8, width: 150, cursor: node.kind === "note" ? "pointer" : "default", ...nodeStyle(node.kind) },
    }));
  }, [graph]);

  const edges = useMemo<Edge[]>(() => (graph?.edges ?? []).map((edge, index) => ({
    id: edge.fromId + "-" + edge.toId + "-" + index,
    source: edge.fromId,
    target: edge.toId,
    label: edge.kind,
    style: { stroke: "var(--border)" },
    labelStyle: { fill: "var(--muted-foreground)", fontSize: 9 },
  })), [graph]);

  if (error) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <NetworkIcon />
          </EmptyMedia>
          <EmptyTitle>Graph unavailable</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (!graph) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <NetworkIcon />
          </EmptyMedia>
          <EmptyTitle>Loading project map…</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  const workspaceStatusLine = workspaceLine(workspace);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[64px] items-center justify-between gap-4 border-b px-5 py-3">
        <div><span className="block text-[10px] font-semibold tracking-wide text-primary uppercase">Project map</span><h1 className="mt-1 text-base leading-tight font-semibold">Graph</h1></div>
        <Badge variant="secondary">{graph.nodes.length + 1} nodes · {graph.edges.length} edges</Badge>
      </div>
      {workspaceStatusLine && <div className="border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">{workspaceStatusLine}</div>}
      <div className="border-b px-3 py-1.5">
        <Breadcrumb>
          <BreadcrumbList>
            {trail.map((crumb, index) => (
              <Fragment key={crumb.nodeId}>
                {index > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem>
                  {index === trail.length - 1 ? (
                    <BreadcrumbPage>{crumb.name}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink render={<button type="button" onClick={() => jumpTo(index)} />}>{crumb.name}</BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow
          style={{ width: "100%", height: "100%" }}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          onNodeClick={(_, node) => {
            const kind = typeof node.data.kind === "string" ? node.data.kind : "";
            if (CONTAINER_KINDS.has(kind)) {
              drillInto(node.id, typeof node.data.label === "string" ? node.data.label : node.id);
              return;
            }
            if (LEAF_CODE_KINDS.has(kind)) return;
            const path = typeof node.data.path === "string" ? node.data.path : undefined;
            if (path?.endsWith(".md")) onOpenPath(path);
          }}
        >
          <Background color="var(--border)" gap={24} />
          <Controls />
          <MiniMap nodeColor={(node) => nodeColor(typeof node.data?.kind === "string" ? node.data.kind : "")} />
        </ReactFlow>
      </div>
    </div>
  );
}
