import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Background, Controls, MiniMap, ReactFlow } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getProjectMap, getWorkspaceStatus } from "./api";
import type { ApiWorkspaceStatus } from "../../src/api/contracts";

type GraphPaneProps = {
  onOpenPath: (path: string) => void;
};

const CODE_KINDS = new Set(["dir", "file", "symbol"]);
const STRUCTURAL_KINDS = new Set(["project", "repo"]);

function nodeStyle(kind: string): CSSProperties {
  if (kind === "note") return { border: "1px solid #d28b37", background: "#fff7e6", color: "#173b35" };
  if (STRUCTURAL_KINDS.has(kind)) return { border: "1px solid #6d7fd6", background: "#eef0fc", color: "#2a2f66" };
  if (CODE_KINDS.has(kind)) return { border: "1px dashed #9bbdb5", background: "#f6fbf9", color: "#3a5450", opacity: 0.85 };
  return { border: "1px solid #9bbdb5", background: "#f6fbf9", color: "#173b35" };
}

function nodeColor(kind: string): string {
  if (kind === "note") return "#d28b37";
  if (STRUCTURAL_KINDS.has(kind)) return "#6d7fd6";
  return "#5c9d91";
}

function workspaceLine(status?: ApiWorkspaceStatus): string | undefined {
  if (!status || !status.active) return undefined;
  const ready = status.repositories.filter((repo) => repo.status === "ready");
  const stale = status.repositories.filter((repo) => repo.status !== "ready");
  const parts = [ready.length + " repositor" + (ready.length === 1 ? "y" : "ies") + (ready.length ? " (" + ready.map((repo) => repo.id).join(", ") + ")" : "")];
  if (stale.length > 0) parts.push(stale.length + " stale (" + stale.map((repo) => repo.id).join(", ") + ")");
  return "Workspace: " + parts.join("; ") + ".";
}

export function GraphPane({ onOpenPath }: GraphPaneProps) {
  const [graph, setGraph] = useState<{ nodes: Array<{ nodeId: string; kind: string; path?: string; name: string }>; edges: Array<{ fromId: string; toId: string; kind: string }> }>();
  const [workspace, setWorkspace] = useState<ApiWorkspaceStatus>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    getProjectMap().then(setGraph).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    getWorkspaceStatus().then(setWorkspace).catch(() => setWorkspace(undefined));
  }, []);

  const nodes = useMemo<Node[]>(() => (graph?.nodes ?? []).map((node, index) => ({
    id: node.nodeId,
    position: { x: (index % 4) * 190, y: Math.floor(index / 4) * 100 },
    data: { label: node.name, kind: node.kind, path: node.path },
    style: { borderRadius: 4, fontSize: 11, padding: 8, width: 150, cursor: node.kind === "note" ? "pointer" : "default", ...nodeStyle(node.kind) },
  })), [graph]);

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
        <span className="text-[11px] text-muted">{graph.nodes.length} nodes · {graph.edges.length} edges</span>
      </div>
      {workspaceStatusLine && <div className="border-b border-line bg-surface-muted px-3 py-1.5 text-[11px] text-muted">{workspaceStatusLine}</div>}
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          onNodeClick={(_, node) => {
            const kind = typeof node.data.kind === "string" ? node.data.kind : "";
            if (CODE_KINDS.has(kind) || STRUCTURAL_KINDS.has(kind)) return;
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
