import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarSeparator } from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HistoryIcon, ListTreeIcon, NetworkIcon, RotateCcwIcon, XIcon } from "lucide-react";
import type { ApiContext, ApiGraphEdge, ApiGraphNode, ApiHistory, ApiNoteSource, ApiSection, ApiVaultCheck, ApiWorkspaceStatus } from "../../../src/api/contracts";

export type InspectorPanel = "context" | "outline" | "git" | "diagnostics";

type RelationshipItem = { edge: ApiGraphEdge; node: ApiGraphNode };

type InspectorDrawerProps = {
  open: boolean;
  panel: InspectorPanel;
  source?: ApiNoteSource;
  context?: ApiContext;
  workspaceStatus?: ApiWorkspaceStatus;
  vaultCheck?: ApiVaultCheck;
  relationshipGroups: { implementsItems: RelationshipItem[]; relatedItems: RelationshipItem[]; ownedByItems: RelationshipItem[] };
  history?: ApiHistory;
  selectedRevision?: string;
  diff: string;
  codeTarget?: { repository: string; path: string; name: string };
  codeHistory?: ApiHistory;
  codeSelectedRevision?: string;
  codeDiff: string;
  outlineSections: ApiSection[];
  onClose: () => void;
  onPanelChange: (panel: InspectorPanel) => void;
  onOpenContextItem: (node: ApiGraphNode) => void;
  onViewInGraph: () => void;
  onRequestJump: (section: ApiSection) => void;
  onSelectRevision: (revision: string) => void;
  onSelectCodeRevision: (revision: string) => void;
  onBackToNote: () => void;
  onRestore: () => void;
};

function RailGroup({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return (
    <Collapsible defaultOpen>
      <SidebarGroup>
        <SidebarGroupLabel render={<CollapsibleTrigger className="w-full cursor-pointer" />}>
          {label}
          {typeof count === "number" && <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[9px] font-normal">{count}</Badge>}
        </SidebarGroupLabel>
        <CollapsibleContent>{children}</CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

function RelationshipList({ items, onOpen, emptyLabel }: { items: RelationshipItem[]; onOpen: (node: ApiGraphNode) => void; emptyLabel: string }) {
  if (items.length === 0) return <p className="px-2 pb-1 text-[11px] leading-normal text-muted-foreground">{emptyLabel}</p>;
  return (
    <SidebarMenu>
      {items.map(({ edge, node }) => {
        const destination = node.kind === "note" || (typeof node.metadata?.repository_id === "string" && Boolean(node.path));
        return (
          <SidebarMenuItem key={edge.kind + ":" + edge.fromId + ":" + edge.toId}>
            <SidebarMenuButton disabled={!destination} onClick={() => onOpen(node)} tooltip={node.path ?? node.name}>
              <span className="truncate">{node.name}</span>
              {node.path && node.kind !== "note" && <span className="ml-auto shrink-0 truncate text-[10px] text-muted-foreground">{node.kind}</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

export function InspectorDrawer({ open, panel, source, context, workspaceStatus, vaultCheck, relationshipGroups, history, selectedRevision, diff, codeTarget, codeHistory, codeSelectedRevision, codeDiff, outlineSections, onClose, onPanelChange, onOpenContextItem, onViewInGraph, onRequestJump, onSelectRevision, onSelectCodeRevision, onBackToNote, onRestore }: InspectorDrawerProps) {
  if (!open) return null;

  return (
    <aside data-testid="context-rail" aria-label="Inspector" className="absolute inset-y-0 right-0 z-30 flex w-[340px] max-w-[calc(100vw-24px)] flex-col border-l bg-card shadow-2xl max-[700px]:w-full">
      <div className="flex items-center gap-2 border-b p-2">
        <Tabs value={panel} onValueChange={(value) => onPanelChange(value as InspectorPanel)} className="min-w-0 flex-1">
          <TabsList className="w-full">
            <TabsTrigger value="context" className="flex-1">Context</TabsTrigger>
            <TabsTrigger value="outline" className="flex-1">Outline</TabsTrigger>
            <TabsTrigger value="git" className="flex-1">Git</TabsTrigger>
            <TabsTrigger value="diagnostics" className="flex-1">Diagnostics</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button variant="ghost" size="icon-sm" aria-label="Close inspector" onClick={onClose}><XIcon /></Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {panel === "context" && (
          !source ? (
            <Empty className="h-full"><EmptyHeader><EmptyMedia variant="icon"><NetworkIcon /></EmptyMedia><EmptyDescription>Select a note to see how it connects to the rest of the vault.</EmptyDescription></EmptyHeader></Empty>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2"><code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={source.note.path}>{source.note.path}</code><Button size="sm" variant="outline" className="shrink-0 gap-1" disabled={!context?.anchor} onClick={onViewInGraph}><NetworkIcon className="size-3.5" />View in graph</Button></div>
              <SidebarSeparator />
              <RailGroup label="Repository">
                {workspaceStatus?.active ? workspaceStatus.repositories.length ? <SidebarMenu>{workspaceStatus.repositories.map((repository) => <SidebarMenuItem key={repository.id}><div className="flex items-center justify-between gap-2 px-2 py-1"><div className="flex min-w-0 flex-col gap-0.5"><span className="truncate text-xs font-medium">{repository.id}</span><span className="text-[10px] text-muted-foreground">Index {repository.status}</span></div><Badge variant={repository.gitChangedFileCount ? "outline" : "secondary"} className="shrink-0 text-[10px] font-normal">{repository.gitChangedFileCount === undefined ? "—" : `${repository.gitChangedFileCount} changed`}</Badge></div></SidebarMenuItem>)}</SidebarMenu> : <p className="px-2 pb-1 text-[11px] text-muted-foreground">No repositories discovered in this workspace.</p> : <div className="flex items-center justify-between gap-2 px-2 py-1"><span className="text-xs font-medium">This vault</span><Badge variant={vaultCheck?.gitStatus.length ? "outline" : "secondary"} className="shrink-0 text-[10px] font-normal">{vaultCheck ? `${vaultCheck.gitStatus.length} changed` : "—"}</Badge></div>}
              </RailGroup>
              <SidebarSeparator />
              <RailGroup label="Implements" count={relationshipGroups.implementsItems.length}><RelationshipList items={relationshipGroups.implementsItems} onOpen={onOpenContextItem} emptyLabel="Doesn't implement any connected source modules." /></RailGroup>
              <SidebarSeparator />
              <RailGroup label="Related notes" count={relationshipGroups.relatedItems.length}><RelationshipList items={relationshipGroups.relatedItems} onOpen={onOpenContextItem} emptyLabel="No linked decisions, plans, tasks, or references." /></RailGroup>
              <SidebarSeparator />
              <RailGroup label="Owned by" count={relationshipGroups.ownedByItems.length}><RelationshipList items={relationshipGroups.ownedByItems} onOpen={onOpenContextItem} emptyLabel="No project or repository ownership recorded." /></RailGroup>
            </>
          )
        )}
        {panel === "outline" && (!source ? <Empty className="h-full"><EmptyHeader><EmptyMedia variant="icon"><ListTreeIcon /></EmptyMedia><EmptyDescription>Select a note to see its section outline.</EmptyDescription></EmptyHeader></Empty> : outlineSections.length === 0 ? <p className="px-3 pt-3 text-[11px] text-muted-foreground">This note has no marked headings.</p> : <SidebarGroup><SidebarMenu>{outlineSections.map((section, index) => <SidebarMenuItem key={section.startLine + ":" + index}><SidebarMenuButton data-testid="rail-outline-item" style={{ paddingLeft: 8 + (section.level - 1) * 12 }} onClick={() => onRequestJump(section)}><span className="truncate">{section.heading}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>)}
        {panel === "git" && (!source ? <Empty className="h-full"><EmptyHeader><EmptyMedia variant="icon"><HistoryIcon /></EmptyMedia><EmptyDescription>Select a note to inspect its Git history and diff.</EmptyDescription></EmptyHeader></Empty> : <>
          {codeTarget && <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2"><span className="min-w-0 truncate text-[11px] text-muted-foreground">Showing <strong className="text-foreground">{codeTarget.name}</strong> in {codeTarget.repository}</span><Button size="sm" variant="ghost" className="shrink-0" onClick={onBackToNote}>Back to note</Button></div>}
          <SidebarGroup><div className="flex items-center justify-between"><SidebarGroupLabel className="px-0">History</SidebarGroupLabel>{!codeTarget && <Button size="icon-sm" variant="ghost" disabled={!selectedRevision} onClick={onRestore}><RotateCcwIcon /><span className="sr-only">Restore</span></Button>}</div><SidebarMenu>{(codeTarget ? codeHistory?.commits : history?.commits)?.length ? (codeTarget ? codeHistory! : history!).commits.map((commit) => <SidebarMenuItem key={commit.hash}><SidebarMenuButton size="lg" isActive={(codeTarget ? codeSelectedRevision : selectedRevision) === commit.hash} onClick={() => codeTarget ? onSelectCodeRevision(commit.hash) : onSelectRevision(commit.hash)}><div className="flex min-w-0 flex-col items-start gap-0.5"><span className="truncate font-medium">{commit.subject}</span><span className="truncate text-[10px] text-muted-foreground">{commit.hash.slice(0, 8)} · {new Date(commit.date).toLocaleDateString()}</span></div></SidebarMenuButton></SidebarMenuItem>) : <p className="px-2 text-[10px] text-muted-foreground">No committed history for this {codeTarget ? "file" : "note"}.</p>}</SidebarMenu></SidebarGroup><SidebarSeparator /><SidebarGroup><SidebarGroupLabel>Diff</SidebarGroupLabel><pre className="mx-2 mb-2 max-h-[280px] overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[10px] leading-relaxed break-words whitespace-pre-wrap text-foreground">{(codeTarget ? codeDiff : diff) || "Select a revision"}</pre></SidebarGroup>
        </>)}
        {panel === "diagnostics" && <><RailGroup label="This note" count={source?.diagnostics.length ?? 0}><div className="grid gap-1.5 px-2 pb-1">{source?.diagnostics.length ? source.diagnostics.map((item, index) => <Alert key={item.code + index} variant="destructive"><AlertDescription>{item.severity}: {item.message}</AlertDescription></Alert>) : <p className="text-[11px] text-muted-foreground">No diagnostics for the selected note.</p>}</div></RailGroup><SidebarSeparator /><RailGroup label="Vault" count={vaultCheck?.diagnostics.length ?? 0}><div className="grid gap-1.5 px-2 pb-1">{vaultCheck?.diagnostics.length ? vaultCheck.diagnostics.map((item, index) => <Alert key={item.code + index} variant={item.severity === "error" ? "destructive" : "default"}><AlertDescription>{item.severity}: {item.message}{item.filePath && <span className="mt-0.5 block truncate font-mono text-[10px] opacity-80">{item.filePath}</span>}</AlertDescription></Alert>) : <p className="text-[11px] text-muted-foreground">{vaultCheck ? "No vault-wide diagnostics." : "Loading…"}</p>}</div></RailGroup></>}
      </ScrollArea>
    </aside>
  );
}
