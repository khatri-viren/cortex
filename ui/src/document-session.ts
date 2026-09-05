import { useCallback, useMemo, useRef, useState } from "react";
import type { ApiNoteSource } from "../../src/api/contracts";
import type { NoteFrontmatter } from "../../src/core/types";

function cloneMetadata(metadata: NoteFrontmatter): NoteFrontmatter {
  return {
    ...metadata,
    aliases: [...metadata.aliases],
    tags: [...metadata.tags],
    applies_to: metadata.applies_to.map((item) => ({ ...item })),
    extra: { ...metadata.extra },
  };
}

/**
 * Owns the editable document's revision and draft/base pair. Keeping this
 * protocol in one hook makes save acknowledgements and conflict handling use
 * the same rules, even when the editor is loaded as a separate feature chunk.
 */
export function useDocumentSession() {
  const [draft, setDraftState] = useState("");
  const [base, setBase] = useState("");
  const [metadataDraft, setMetadataDraftState] = useState<NoteFrontmatter>();
  const [baseMetadata, setBaseMetadata] = useState<NoteFrontmatter>();
  const localRevision = useRef(0);
  const draftRef = useRef("");
  const metadataDraftRef = useRef<NoteFrontmatter | undefined>(undefined);
  const baseRef = useRef("");
  const baseMetadataRef = useRef<NoteFrontmatter | undefined>(undefined);
  const isDirtyRef = useRef(false);
  const pendingDraftFrame = useRef<number | undefined>(undefined);

  const updateDraft = useCallback((next: string) => {
    localRevision.current += 1;
    draftRef.current = next;
    isDirtyRef.current = next !== baseRef.current || JSON.stringify(metadataDraftRef.current) !== JSON.stringify(baseMetadataRef.current);
    // CodeMirror already owns the hot keystroke path. Sync the shell snapshot
    // at most once per animation frame so a burst of typing does not schedule
    // one full WorkspaceApp render per keypress.
    if (pendingDraftFrame.current === undefined) {
      pendingDraftFrame.current = requestAnimationFrame(() => {
        pendingDraftFrame.current = undefined;
        setDraftState(draftRef.current);
      });
    }
  }, []);

  const updateMetadata = useCallback((next: NoteFrontmatter) => {
    localRevision.current += 1;
    metadataDraftRef.current = next;
    isDirtyRef.current = draftRef.current !== baseRef.current || JSON.stringify(next) !== JSON.stringify(baseMetadataRef.current);
    setMetadataDraftState(next);
  }, []);

  const replace = useCallback((source: ApiNoteSource, preserveDraft = false) => {
    const nextMetadata = cloneMetadata(source.frontmatter);
    localRevision.current = 0;
    if (pendingDraftFrame.current !== undefined) cancelAnimationFrame(pendingDraftFrame.current);
    pendingDraftFrame.current = undefined;
    draftRef.current = source.body;
    metadataDraftRef.current = nextMetadata;
    baseRef.current = source.body;
    baseMetadataRef.current = cloneMetadata(nextMetadata);
    isDirtyRef.current = false;
    setBase(source.body);
    setBaseMetadata(cloneMetadata(nextMetadata));
    if (!preserveDraft) {
      setDraftState(source.body);
      setMetadataDraftState(nextMetadata);
    }
  }, []);

  const acknowledge = useCallback((source: ApiNoteSource, keepNewerDraft: boolean) => {
    const nextMetadata = cloneMetadata(source.frontmatter);
    draftRef.current = keepNewerDraft ? draftRef.current : source.body;
    metadataDraftRef.current = keepNewerDraft ? metadataDraftRef.current : nextMetadata;
    baseRef.current = source.body;
    baseMetadataRef.current = cloneMetadata(nextMetadata);
    isDirtyRef.current = keepNewerDraft && (draftRef.current !== baseRef.current || JSON.stringify(metadataDraftRef.current) !== JSON.stringify(baseMetadataRef.current));
    setBase(source.body);
    setBaseMetadata(cloneMetadata(nextMetadata));
    if (!keepNewerDraft) {
      localRevision.current = 0;
      setDraftState(source.body);
      setMetadataDraftState(nextMetadata);
    }
  }, []);

  const isDirty = useMemo(
    () => draft !== base || JSON.stringify(metadataDraft) !== JSON.stringify(baseMetadata),
    [base, baseMetadata, draft, metadataDraft],
  );

  return {
    draft,
    base,
    metadataDraft,
    baseMetadata,
    draftRef,
    metadataDraftRef,
    isDirtyRef,
    isDirty,
    localRevision,
    updateDraft,
    updateMetadata,
    replace,
    acknowledge,
  };
}
