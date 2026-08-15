import { useState } from "react";
import type { ReactNode } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import type { NoteFrontmatter } from "../../../src/core/types";
import type { Mode } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type NoteMetadataProps = {
  metadata: NoteFrontmatter;
  mode: Mode;
  dirty: boolean;
  notePath?: string;
  connectedFiles: number;
  onChange: (metadata: NoteFrontmatter) => void;
  onModeChange: (mode: Mode) => void;
  onToggleInspector: () => void;
};

function MetadataRow({ label, children, muted = false }: { label: string; children: ReactNode; muted?: boolean }) {
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)] items-start gap-4 py-2 text-[13px]">
      <div className="pt-1 text-muted-foreground">{label}</div>
      <div className={muted ? "text-muted-foreground" : "min-w-0 text-foreground"}>{children}</div>
    </div>
  );
}

function StringListField({ values, onChange, placeholder }: { values: string[]; onChange: (values: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  function addValue() {
    const value = draft.trim();
    if (!value || values.includes(value)) return;
    onChange([...values, value]);
    setDraft("");
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {values.map((value) => (
        <Badge key={value} variant="secondary" className="gap-1 px-2 py-1 font-normal">
          <span className="max-w-[260px] truncate">{value}</span>
          <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((candidate) => candidate !== value))}>
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-[120px] flex-1 border-0 bg-transparent px-1 py-1 text-[13px] outline-none placeholder:text-muted-foreground"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            addValue();
          }
        }}
        onBlur={addValue}
      />
    </div>
  );
}

export function NoteMetadata({ metadata, mode, dirty, notePath, connectedFiles, onChange, onModeChange, onToggleInspector }: NoteMetadataProps) {
  const [extraKey, setExtraKey] = useState("");
  const update = (patch: Partial<NoteFrontmatter>) => onChange({ ...metadata, ...patch });
  const extras = Object.entries(metadata.extra);

  function addExtraProperty() {
    const key = extraKey.trim();
    if (!key || key in metadata.extra) return;
    onChange({ ...metadata, extra: { ...metadata.extra, [key]: "" } });
    setExtraKey("");
  }

  return (
    <section className="note-metadata mx-auto w-full max-w-[860px] px-8 pt-12 pb-8 max-[700px]:px-5 max-[700px]:pt-8" aria-label="Note metadata">
      <div className="mb-6 flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <span className="mb-2 block text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">{metadata.type}</span>
          <h1 aria-label={metadata.title} className="m-0 w-full text-[24px] leading-tight font-semibold tracking-[-0.02em] text-foreground">
            <span className="sr-only">{metadata.title}</span>
            <input
              aria-label="Note title"
              value={metadata.title}
              onChange={(event) => update({ title: event.target.value })}
              className="w-full border-0 bg-transparent p-0 text-[24px] leading-tight font-semibold tracking-[-0.02em] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {notePath && <code className="max-w-[420px] truncate font-mono" title={notePath}>{notePath}</code>}
            <span>·</span>
            <span>{connectedFiles} connected files</span>
            {dirty && <><span>·</span><span className="text-foreground">Unsaved</span></>}
          </div>
        </div>
        <div className="flex shrink-0 items-start gap-2">
          <Tabs value={mode} onValueChange={(value) => onModeChange(value as Mode)}>
            <TabsList className="h-9 rounded-lg bg-muted/80 p-1">
              <TabsTrigger value="source" className="h-7 px-2.5 text-xs">Source</TabsTrigger>
              <TabsTrigger value="reading" className="h-7 px-2.5 text-xs">Reading</TabsTrigger>
              <TabsTrigger value="live" className="h-7 px-2.5 text-xs">Live</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="ghost" size="icon-sm" aria-label="Open inspector" onClick={onToggleInspector}>
            <span className="text-sm">☷</span>
          </Button>
        </div>
      </div>

      <div className="border-t border-border/70 pt-3">
        <MetadataRow label="id" muted><code className="break-all font-mono text-[12px]">{metadata.id}</code></MetadataRow>
        <MetadataRow label="title"><span className="truncate">{metadata.title}</span></MetadataRow>
        <MetadataRow label="type">
          <select value={metadata.type} aria-label="Note type" onChange={(event) => update({ type: event.target.value as NoteFrontmatter["type"] })} className="rounded-md border border-transparent bg-transparent px-1 py-1 outline-none hover:border-border focus:border-ring">
            <option value="note">note</option>
            <option value="map">map</option>
            <option value="table">table</option>
          </select>
        </MetadataRow>
        <MetadataRow label="created_at" muted><time dateTime={metadata.created_at}>{metadata.created_at}</time></MetadataRow>
        <MetadataRow label="updated_at" muted><time dateTime={metadata.updated_at}>{metadata.updated_at}</time></MetadataRow>
        <MetadataRow label="aliases"><StringListField values={metadata.aliases} onChange={(aliases) => update({ aliases })} placeholder="Add alias" /></MetadataRow>
        <MetadataRow label="tags"><StringListField values={metadata.tags} onChange={(tags) => update({ tags })} placeholder="Add tag" /></MetadataRow>
        <MetadataRow label="applies_to">
          <div className="grid gap-2">
            {metadata.applies_to.map((item, index) => (
              <div key={`${item.target}:${index}`} className="grid grid-cols-[minmax(0,1fr)_130px_28px] gap-2 max-[700px]:grid-cols-[minmax(0,1fr)_28px]">
                <input value={item.target} aria-label={`Attachment target ${index + 1}`} onChange={(event) => update({ applies_to: metadata.applies_to.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, target: event.target.value } : candidate) })} className="min-w-0 rounded-md border border-transparent bg-transparent px-1 py-1 outline-none hover:border-border focus:border-ring" />
                <input value={item.relation} aria-label={`Attachment relation ${index + 1}`} onChange={(event) => update({ applies_to: metadata.applies_to.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, relation: event.target.value as typeof candidate.relation } : candidate) })} className="min-w-0 rounded-md border border-transparent bg-transparent px-1 py-1 text-muted-foreground outline-none hover:border-border focus:border-ring max-[700px]:hidden" />
                <button type="button" aria-label={`Remove attachment ${index + 1}`} onClick={() => update({ applies_to: metadata.applies_to.filter((_, candidateIndex) => candidateIndex !== index) })} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><XIcon className="size-3.5" /></button>
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" className="w-fit gap-1 text-xs" onClick={() => update({ applies_to: [...metadata.applies_to, { target: "", relation: "related_to" }] })}><PlusIcon className="size-3.5" />Add relation</Button>
          </div>
        </MetadataRow>
        {extras.map(([key, value]) => (
          <MetadataRow key={key} label={key}>
            <input value={typeof value === "string" ? value : JSON.stringify(value)} aria-label={key} onChange={(event) => update({ extra: { ...metadata.extra, [key]: event.target.value } })} className="w-full rounded-md border border-transparent bg-transparent px-1 py-1 outline-none hover:border-border focus:border-ring" />
          </MetadataRow>
        ))}
        <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <PlusIcon className="size-4" />
          <input value={extraKey} placeholder="Add property" aria-label="New property name" onChange={(event) => setExtraKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addExtraProperty(); } }} className="w-40 border-0 bg-transparent outline-none placeholder:text-muted-foreground" />
          <Button type="button" variant="ghost" size="sm" disabled={!extraKey.trim()} onClick={addExtraProperty}>Add</Button>
        </div>
      </div>
    </section>
  );
}
