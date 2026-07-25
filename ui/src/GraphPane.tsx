import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow } from "@xyflow/react";
import type { Edge, Node, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getProjectMap, getWorkspaceStatus } from "./api";
import type { ApiGraph, ApiWorkspaceStatus } from "../../src/api/contracts";

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
  if (kind === "note") return { border: "1px solid #d28b37", background: "#fff7e6", color: "#173b35" };
  if (CONTAINER_KINDS.has(kind)) return { border: "1px solid #6d7fd6", background: "#eef0fc", color: "#2a2f66", cursor: "pointer" };
  if (LEAF_CODE_KINDS.has(kind)) return { border: "1px dashed #9bbdb5", background: "#f6fbf9", color: "#3a5450", opacity: 0.85 };
  return { border: "1px solid #9bbdb5", background: "#f6fbf9", color: "#173b35" };
}

function nodeColor(kind: string): string {
  if (kind === "note") return "#d28b37";
  if (CONTAINER_KINDS.has(kind)) return "#6d7fd6";
  return "#5c9d91";
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
        className="grid h-4 w-4 shrink-0 place-items-center rounded-sm border border-[#d28b37] bg-transparent text-[10px] leading-none text-[#d28b37] hover:bg-[#d28b37] hover:text-white"
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
    style: { stroke: "#a7bdb8" },
    labelStyle: { fill: "#56716b", fontSize: 9 },
  })), [graph]);

  if (error) return <div className="grid h-full min-h-[300px] content-center place-items-center gap-1.5 p-6 text-center text-muted">Graph unavailable: {error}</div>;
  if (!graph) return <div className="grid h-full min-h-[300px] content-center place-items-center gap-1.5 p-6 text-center text-muted">Loading project map...</div>;
  const workspaceStatusLine = workspaceLine(workspace);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[82px] items-center justify-between gap-4 border-b border-line px-6 py-4 max-[700px]:px-4 max-[700px]:py-3.5">
        <div><span className="block text-[10px] font-extrabold tracking-[0.12em] text-brand uppercase">Project map</span><h1 className="mt-1 text-[19px] leading-tight font-bold">Graph</h1></div>
        <span className="text-[11px] text-muted">{graph.nodes.length + 1} nodes · {graph.edges.length} edges</span>
      </div>
      {workspaceStatusLine && <div className="border-b border-line bg-surface-muted px-3 py-1.5 text-[11px] text-muted">{workspaceStatusLine}</div>}
      <div className="flex items-center gap-1 border-b border-line px-3 py-1.5 text-[11px] text-muted">
        {trail.map((crumb, index) => (
          <span key={crumb.nodeId} className="flex items-center gap-1">
            {index > 0 && <span>›</span>}
            {index === trail.length - 1 ? (
              <span className="font-semibold text-ink">{crumb.name}</span>
            ) : (
              <button type="button" onClick={() => jumpTo(index)} className="text-brand hover:underline">
                {crumb.name}
              </button>
            )}
          </span>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow
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
          <Background color="#dce9e5" gap={24} />
          <Controls />
          <MiniMap nodeColor={(node) => nodeColor(typeof node.data?.kind === "string" ? node.data.kind : "")} />
        </ReactFlow>
      </div>
    </div>
  );
}
