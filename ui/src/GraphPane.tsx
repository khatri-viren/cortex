import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow } from "@xyflow/react";
import type { Edge, Node, NodeProps, ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getProjectMap, getWorkspaceStatus } from "./api";
import type { ApiGraph, ApiGraphNode, ApiWorkspaceStatus } from "../../src/api/contracts";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ExternalLinkIcon, NetworkIcon, RotateCcwIcon, SearchIcon } from "lucide-react";

const COLUMN_WIDTH = 190;
const ROW_HEIGHT = 115;

const CONTAINER_KINDS = new Set(["project", "repository", "directory"]);
const LEAF_CODE_KINDS = new Set(["file", "test", "configuration", "module", "symbol", "package"]);
const KIND_ORDER = ["project", "repository", "directory", "note", "module", "test", "configuration", "file", "package", "symbol"];

const KIND_LABELS: Record<string, string> = {
  project: "Project root",
  repository: "Repository",
  directory: "Directory",
  note: "Note",
  module: "Source module",
  test: "Test",
  configuration: "Configuration",
  file: "File",
  package: "Package",
  symbol: "Symbol",
};

const RELATIONSHIP_LABELS: Record<string, string> = {
  contains: "Contains",
  wikilink: "Wikilink",
  documents: "Documents",
  implements: "Implements",
  owns: "Owns",
  imports: "Imports",
  tested_by: "Tested by",
  depends_on: "Depends on",
  related_to: "Related to",
};

type TrailEntry = { nodeId: string; name: string };

type GraphPaneProps = {
  onOpenPath: (path: string) => void;
  onOpenCode?: (node: ApiGraphNode) => void;
  onBackToNote?: () => void;
  activeNoteLabel?: string;
  // Set by the context rail's "View in graph" action so the graph opens
  // already centered on the active note instead of the project root.
  initialCenter?: string;
  initialCenterLabel?: string;
};

type GraphNodeData = {
  nodeId: string;
  label: string;
  kind: string;
  path?: string;
  focused: boolean;
  dimmed: boolean;
  onDrill?: () => void;
  onOpen?: () => void;
};

function nodeKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function nodeAccent(kind: string): string {
  if (kind === "project") return "var(--node-root)";
  if (kind === "repository") return "var(--node-repository)";
  if (kind === "directory") return "var(--node-directory)";
  if (kind === "note") return "var(--primary)";
  return "var(--muted-foreground)";
}

function nodeStyle(kind: string, focused: boolean, dimmed: boolean): CSSProperties {
  const accent = nodeAccent(kind);
  return {
    border: `1px solid ${accent}`,
    background: `color-mix(in oklch, ${accent} ${kind === "note" ? "16%" : "11%"}, var(--background))`,
    color: "var(--foreground)",
    opacity: dimmed ? 0.3 : 1,
    boxShadow: focused ? `0 0 0 2px color-mix(in oklch, ${accent} 32%, transparent)` : undefined,
    cursor: CONTAINER_KINDS.has(kind) || kind === "note" ? "pointer" : "default",
  };
}

function nodeColor(kind: string): string {
  return nodeAccent(kind);
}

function edgePresentation(kind: string): { stroke: string; strokeDasharray?: string; label: string } {
  const stroke = kind === "wikilink" || kind === "related_to"
    ? "var(--primary)"
    : kind === "implements" || kind === "documents"
      ? "var(--node-repository)"
      : kind === "owns"
        ? "var(--node-directory)"
        : "var(--border)";
  return {
    stroke,
    strokeDasharray: kind === "wikilink" || kind === "related_to" ? "5 4" : undefined,
    label: RELATIONSHIP_LABELS[kind] ?? kind,
  };
}

function layoutByLevel(graph: ApiGraph, graphNodes: ApiGraphNode[]): Map<string, { x: number; y: number }> {
  const neighbors = new Map<string, string[]>();
  for (const node of graphNodes) neighbors.set(node.nodeId, []);
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

  // A valid API response should be connected to its anchor. Keeping any
  // unexpected isolated nodes in a final level gives them a visible position
  // instead of producing a node at (0, 0) with an unexplained overlap.
  const isolated = graphNodes.map((node) => node.nodeId).filter((nodeId) => !visited.has(nodeId));
  if (isolated.length > 0) levels.push(isolated);

  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, ids] of levels.entries()) {
    const offset = ((ids.length - 1) * COLUMN_WIDTH) / 2;
    ids.forEach((nodeId, index) => positions.set(nodeId, { x: index * COLUMN_WIDTH - offset, y: level * ROW_HEIGHT }));
  }
  return positions;
}

function workspaceLine(status?: ApiWorkspaceStatus): string | undefined {
  if (!status) return undefined;
  if (!status.active) return "Vault graph · local index";
  const ready = status.repositories.filter((repo) => repo.status === "ready");
  const stale = status.repositories.filter((repo) => repo.status !== "ready");
  const repositoryWord = ready.length === 1 ? "repository" : "repositories";
  const parts = [`${ready.length} ${repositoryWord}`];
  if (stale.length > 0) parts.push(`${stale.length} stale`);
  if (status.diagnostics.length > 0) parts.push(`${status.diagnostics.length} diagnostics`);
  return `Workspace index · ${parts.join(" · ")}`;
}

function GraphNodeContent({ data }: NodeProps & { data: GraphNodeData }) {
  return (
    <div
      data-testid="graph-node"
      data-node-id={data.nodeId}
      data-focused={data.focused ? "true" : "false"}
      className="relative min-w-0"
      aria-label={`${nodeKindLabel(data.kind)}: ${data.label}`}
      role="group"
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate text-[9px] font-semibold tracking-wide text-muted-foreground uppercase">{nodeKindLabel(data.kind)}</span>
        {data.focused && <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1 text-[9px] text-primary">active</span>}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-medium"
          title={data.label}
          onClick={(event) => {
            event.stopPropagation();
            (data.onOpen ?? data.onDrill)?.();
          }}
        >
          {data.label}
        </button>
        {data.onDrill && (
          <button
            type="button"
            aria-label={data.kind === "note" ? "Expand note neighborhood" : "Show node neighborhood"}
            title={data.kind === "note" ? "Expand this note's neighborhood" : "Show this node's neighborhood"}
            onClick={(event) => {
              event.stopPropagation();
              data.onDrill?.();
            }}
            className="grid h-4 w-4 shrink-0 place-items-center rounded-sm border border-primary bg-transparent text-[10px] leading-none text-primary hover:bg-primary hover:text-primary-foreground"
          >
            +
          </button>
        )}
      </div>
      {data.path && <div className="mt-1 truncate font-mono text-[9px] text-muted-foreground" title={data.path}>{data.path}</div>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { graph: GraphNodeContent };

export function GraphPane({ onOpenPath, onOpenCode, onBackToNote, activeNoteLabel, initialCenter, initialCenterLabel }: GraphPaneProps) {
  const [graph, setGraph] = useState<ApiGraph>();
  const [workspace, setWorkspace] = useState<ApiWorkspaceStatus>();
  const [error, setError] = useState<string>();
  const [retryNonce, setRetryNonce] = useState(0);
  const [center, setCenter] = useState<string | undefined>(initialCenter);
  const [trail, setTrail] = useState<TrailEntry[]>(initialCenter ? [{ nodeId: initialCenter, name: initialCenterLabel ?? initialCenter }] : []);
  const [searchQuery, setSearchQuery] = useState("");
  const [focusedNodeId, setFocusedNodeId] = useState<string | undefined>(initialCenter);
  const flowRef = useRef<ReactFlowInstance | null>(null);

  useEffect(() => {
    getWorkspaceStatus().then(setWorkspace).catch(() => setWorkspace(undefined));
  }, []);

  // The graph route can be entered from a different active note without
  // unmounting the pane. Treat a new route center as a fresh navigation root.
  useEffect(() => {
    setCenter(initialCenter);
    setTrail(initialCenter ? [{ nodeId: initialCenter, name: initialCenter }] : []);
    setFocusedNodeId(initialCenter);
    setSearchQuery("");
    setGraph(undefined);
    setError(undefined);
  }, [initialCenter]);

  // The active note title can arrive after the graph route is already
  // mounted. Refresh only the breadcrumb label; changing the label must not
  // clear a graph that was just fetched.
  useEffect(() => {
    if (!initialCenter || !initialCenterLabel) return;
    setTrail((previous) => previous.length === 1 && previous[0].nodeId === initialCenter
      ? [{ nodeId: initialCenter, name: initialCenterLabel }]
      : previous);
  }, [initialCenter, initialCenterLabel]);

  useEffect(() => {
    let cancelled = false;
    setGraph(undefined);
    setError(undefined);
    getProjectMap(center)
      .then((fetched) => {
        if (cancelled) return;
        setGraph(fetched);
        setTrail((previous) => previous.length === 0 ? [{ nodeId: fetched.anchor.nodeId, name: fetched.anchor.name }] : previous);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [center, retryNonce]);

  const graphNodes = useMemo(() => {
    if (!graph) return [];
    const seen = new Set<string>();
    return [graph.anchor, ...graph.nodes].filter((node) => {
      if (seen.has(node.nodeId)) return false;
      seen.add(node.nodeId);
      return true;
    });
  }, [graph]);

  const graphNodeIds = useMemo(() => new Set(graphNodes.map((node) => node.nodeId)), [graphNodes]);
  const validEdges = useMemo(
    () => (graph?.edges ?? []).filter((edge) => graphNodeIds.has(edge.fromId) && graphNodeIds.has(edge.toId)),
    [graph, graphNodeIds],
  );
  const danglingEdgeCount = (graph?.edges.length ?? 0) - validEdges.length;

  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return [];
    return graphNodes.filter((node) => [node.name, node.path ?? "", node.kind].some((value) => value.toLocaleLowerCase().includes(query)));
  }, [graphNodes, searchQuery]);

  const drillInto = useCallback((nodeId: string, name: string) => {
    setTrail((previous) => previous[previous.length - 1]?.nodeId === nodeId ? previous : [...previous, { nodeId, name }]);
    setCenter(nodeId);
    setFocusedNodeId(nodeId);
    setSearchQuery("");
  }, []);

  const jumpTo = useCallback((index: number) => {
    const entry = trail[index];
    if (!entry) return;
    setTrail((previous) => previous.slice(0, index + 1));
    setCenter(index === 0 ? undefined : entry.nodeId);
    setFocusedNodeId(entry.nodeId);
    setSearchQuery("");
  }, [trail]);

  const focusNode = useCallback((nodeId: string) => {
    setFocusedNodeId(nodeId);
    const flow = flowRef.current;
    if (flow) void flow.fitView({ nodes: [{ id: nodeId }], padding: 0.7, duration: 300 });
  }, []);

  const fitGraph = useCallback(() => {
    if (flowRef.current) void flowRef.current.fitView({ padding: 0.2, duration: 300 });
  }, []);

  const resetGraphView = useCallback(() => {
    setSearchQuery("");
    setFocusedNodeId(center);
    fitGraph();
  }, [center, fitGraph]);

  const nodes = useMemo<Node[]>(() => {
    if (!graph) return [];
    const positions = layoutByLevel(graph, graphNodes);
    const query = searchQuery.trim().toLocaleLowerCase();
    return graphNodes.map((node) => {
      const focused = focusedNodeId === node.nodeId;
      const matchesSearch = !query || [node.name, node.path ?? "", node.kind].some((value) => value.toLocaleLowerCase().includes(query));
      return {
        id: node.nodeId,
        type: "graph",
        position: positions.get(node.nodeId) ?? { x: 0, y: 0 },
        data: {
          nodeId: node.nodeId,
          label: node.name,
          kind: node.kind,
          path: node.path,
          focused,
          dimmed: Boolean(query) && !matchesSearch,
          onDrill: CONTAINER_KINDS.has(node.kind) || node.kind === "note" ? () => drillInto(node.nodeId, node.name) : undefined,
          onOpen: node.kind === "note" && node.path
            ? () => onOpenPath(node.path!)
            : LEAF_CODE_KINDS.has(node.kind) && onOpenCode && node.path && typeof node.metadata?.repository_id === "string"
              ? () => onOpenCode(node)
              : CONTAINER_KINDS.has(node.kind)
                ? () => drillInto(node.nodeId, node.name)
                : undefined,
        } satisfies GraphNodeData,
        style: { borderRadius: 6, fontSize: 11, padding: 9, width: 170, ...nodeStyle(node.kind, focused, Boolean(query) && !matchesSearch) },
      };
    });
  }, [drillInto, focusedNodeId, graph, graphNodes, onOpenCode, onOpenPath, searchQuery]);

  const edges = useMemo<Edge[]>(() => validEdges.map((edge, index) => {
    const presentation = edgePresentation(edge.kind);
    return {
      id: `${edge.fromId}-${edge.toId}-${edge.kind}-${index}`,
      source: edge.fromId,
      target: edge.toId,
      label: presentation.label,
      style: { stroke: presentation.stroke, strokeDasharray: presentation.strokeDasharray, strokeWidth: 1.2 },
      labelStyle: { fill: "var(--muted-foreground)", fontSize: 9 },
      labelBgStyle: { fill: "var(--background)", fillOpacity: 0.9 },
    };
  }), [validEdges]);

  const relationshipKinds = useMemo(() => [...new Set(validEdges.map((edge) => edge.kind))], [validEdges]);
  const kindLegend = useMemo(() => {
    const present = new Set(graphNodes.map((node) => node.kind));
    return KIND_ORDER.filter((kind) => present.has(kind));
  }, [graphNodes]);

  if (error) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon"><NetworkIcon /></EmptyMedia>
          <EmptyTitle>Graph unavailable</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" onClick={() => setRetryNonce((value) => value + 1)}>Retry graph</Button>
      </Empty>
    );
  }

  if (!graph) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon"><NetworkIcon /></EmptyMedia>
          <EmptyTitle>Loading project map…</EmptyTitle>
          <EmptyDescription>Preparing the active vault graph.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const workspaceStatusLine = workspaceLine(workspace);
  const partial = graph.truncated || danglingEdgeCount > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-10 items-center justify-end gap-2 border-b px-3 py-1.5">
        <Badge variant="secondary">{graphNodes.length} nodes · {validEdges.length} relationships</Badge>
        <Button size="sm" variant="outline" onClick={fitGraph}>Fit view</Button>
        <Button size="sm" variant="outline" onClick={resetGraphView}><RotateCcwIcon className="size-3.5" />Reset view</Button>
        {onBackToNote && <Button size="sm" variant="ghost" className="gap-1" onClick={onBackToNote}><ExternalLinkIcon className="size-3.5" />{activeNoteLabel ? "Back to note" : "Back to notes"}</Button>}
      </div>
      {workspaceStatusLine && <div className="border-b bg-muted/40 px-5 py-1.5 text-[11px] text-muted-foreground">{workspaceStatusLine}</div>}
      <div className="border-b px-3 py-1.5">
        <Breadcrumb>
          <BreadcrumbList data-testid="graph-breadcrumbs">
            {trail.map((crumb, index) => (
              <Fragment key={`${crumb.nodeId}:${index}`}>
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
      <div className="flex min-h-0 flex-1">
        <aside data-testid="graph-legend" className="hidden w-56 shrink-0 overflow-y-auto border-r bg-card/40 p-3 lg:block">
          <div className="mb-4">
            <div className="mb-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Node kinds</div>
            <div className="grid gap-1.5">
              {kindLegend.map((kind) => (
                <div key={kind} className="flex items-center gap-2 text-[11px]">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: nodeColor(kind) }} />
                  <span>{nodeKindLabel(kind)}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Relationships</div>
            {relationshipKinds.length > 0 ? (
              <div className="grid gap-1.5">
                {relationshipKinds.map((kind) => {
                  const presentation = edgePresentation(kind);
                  return (
                    <div key={kind} className="flex items-center gap-2 text-[11px]">
                      <span className="w-5 border-t" style={{ borderColor: presentation.stroke, borderStyle: presentation.strokeDasharray ? "dashed" : "solid" }} />
                      <span>{presentation.label}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px] leading-normal text-muted-foreground">No relationships in this view.</p>
            )}
          </div>
        </aside>
        <div className="relative min-h-0 min-w-0 flex-1">
          <div className="absolute top-3 right-3 left-3 z-10 flex flex-wrap items-start justify-between gap-2 pointer-events-none">
            <div className="pointer-events-auto flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <div className="flex h-8 min-w-[220px] max-w-[360px] flex-1 items-center gap-1.5 rounded-md border bg-background/95 px-2 shadow-sm">
                <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  aria-label="Search graph"
                  placeholder="Search nodes"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
                {searchQuery && <span className="text-[10px] text-muted-foreground">{searchMatches.length}</span>}
              </div>
              {focusedNodeId && (
                <Button size="sm" variant="outline" onClick={() => focusNode(focusedNodeId)} className="pointer-events-auto bg-background/95 shadow-sm">
                  Focus active
                </Button>
              )}
            </div>
            {searchQuery.trim() && (
              <div data-testid="graph-search-results" className="pointer-events-auto w-full max-w-[360px] rounded-md border bg-background/95 p-1.5 shadow-sm">
                {searchMatches.length > 0 ? searchMatches.slice(0, 8).map((node) => (
                  <button
                    key={node.nodeId}
                    type="button"
                    data-testid="graph-search-result"
                    onClick={() => focusNode(node.nodeId)}
                    className="flex w-full items-start justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
                  >
                    <span className="min-w-0 truncate font-medium">{node.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{nodeKindLabel(node.kind)}</span>
                  </button>
                )) : <p className="px-2 py-1 text-[11px] text-muted-foreground">No matching nodes in this neighborhood.</p>}
              </div>
            )}
          </div>
          {partial && (
            <div data-testid="graph-partial-state" className="absolute right-3 bottom-3 z-10 max-w-[360px] rounded-md border border-warning/40 bg-background/95 px-3 py-2 text-[11px] text-muted-foreground shadow-sm">
              Showing a partial neighborhood. Expand a node to inspect its complete local relationships.
              {danglingEdgeCount > 0 && <span className="mt-0.5 block text-warning">{danglingEdgeCount} incomplete relationship{danglingEdgeCount === 1 ? "" : "s"} omitted.</span>}
            </div>
          )}
          {graphNodes.length === 1 && (
            <div data-testid="graph-empty-state" className="pointer-events-none absolute inset-0 z-[5] grid place-items-center p-6">
              <div className="max-w-sm rounded-lg border bg-background/95 p-5 text-center shadow-sm">
                <NetworkIcon className="mx-auto mb-2 size-6 text-muted-foreground" />
                <div className="text-sm font-medium">No graph relationships yet</div>
                <p className="mt-1 text-xs text-muted-foreground">This node has no indexed neighbors in the active vault.</p>
              </div>
            </div>
          )}
          <ReactFlow
            style={{ width: "100%", height: "100%" }}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            onInit={(instance) => { flowRef.current = instance; }}
            onNodeClick={(_, node) => {
              const data = node.data as GraphNodeData;
              const graphNode = graphNodes.find((candidate) => candidate.nodeId === node.id);
              if (!graphNode) return;
              if (CONTAINER_KINDS.has(data.kind)) {
                drillInto(node.id, data.label);
                return;
              }
              if (data.kind === "note" && data.path) {
                onOpenPath(data.path);
                return;
              }
              if (LEAF_CODE_KINDS.has(data.kind) && onOpenCode && graphNode.path && typeof graphNode.metadata.repository_id === "string") {
                onOpenCode(graphNode);
              }
            }}
          >
            <Background color="var(--border)" gap={24} />
            <Controls />
            <MiniMap nodeColor={(node) => nodeColor(typeof node.data?.kind === "string" ? node.data.kind : "")} />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
