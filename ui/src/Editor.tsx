import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AtomicCodeMirrorEditor,
  wikiLinks,
  type AtomicCodeMirrorEditorHandle,
} from "@atomic-editor/editor";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { LanguageDescription } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  ViewPlugin,
} from "@codemirror/view";
import type { NoteLinkSuggestion, NoteSummary } from "./api";
import type { ApiSection } from "../../src/api/contracts";
import { SectionOutline } from "./components/section-outline";
import { markdownBackquoteKey } from "./markdown-input";
import { hasRichMarkdownBlock, MarkdownReader } from "./MarkdownReader";
import { nextBottomPinnedState } from "./scroll-state";

// Only the vault's actually-used fence languages get a grammar; matches
// @atomic-editor/editor's own code-languages.ts entries so more can be
// added later the same way (install `@codemirror/lang-<name>`, append here).
const CODE_LANGUAGES = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "jsx"],
    extensions: ["js", "mjs", "cjs", "jsx"],
    load: () =>
      import("@codemirror/lang-javascript").then((module) =>
        module.javascript({ jsx: true }),
      ),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "tsx"],
    extensions: ["ts", "mts", "cts", "tsx"],
    load: () =>
      import("@codemirror/lang-javascript").then((module) =>
        module.javascript({ typescript: true, jsx: true }),
      ),
  }),
];

const sourceTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
  },
  ".cm-content": { padding: "24px 28px 120px" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--muted-foreground)",
    paddingLeft: "10px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--primary) 6%, transparent)",
  },
});

// Atomic Editor's task widget normally maps its replacement DOM node back to
// the source range with `posAtDOM`. A replaced widget can lose that mapping
// after a virtualized long document is laid out, leaving a click visually
// inert even though the checkbox is present. Capture the click before the
// widget's own listener and resolve the owning Markdown line from screen
// coordinates. The source remains canonical, and the normal update listener
// still reports the resulting transaction to App.tsx.
const taskCheckboxFallback = ViewPlugin.fromClass(class {
  private readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    view.dom.addEventListener("click", this.handleClick, true);
  }

  private readonly handleClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches(".cm-atomic-task-checkbox")) return;

    const rect = target.getBoundingClientRect();
    const position = this.view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, false);
    const line = this.view.state.doc.lineAt(position);
    const match = line.text.match(/^(\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
    if (!match) return;

    const markerFrom = line.from + match[1].length;
    const next = /\[x\]/i.test(match[2]) ? "[ ]" : "[x]";
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.view.dispatch({
      changes: { from: markerFrom, to: markerFrom + 3, insert: next },
      userEvent: "input.type",
    });
  };

  destroy() {
    this.view.dom.removeEventListener("click", this.handleClick, true);
  }
});

// GitHub-style heading slug, used to resolve same-document `[text](#anchor)`
// links against `sections` — Cortex's own wikilink model has no heading-anchor
// syntax (see WIKILINK_RE in src/core/markdown.ts), so this only covers plain
// Markdown anchor links, not `[[Note#Heading]]`.
function slugifyHeading(heading: string): string {
  return heading
    .toLocaleLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function normalizeHeadingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type EditorProps = {
  value: string;
  mode: "source" | "reading" | "live";
  onChange: (value: string) => void;
  linkTargets?: string[];
  notePath?: string;
  notes?: NoteSummary[];
  suggestNoteLinks?: (query: string) => Promise<{ matches: NoteLinkSuggestion[]; truncated: boolean }>;
  onOpenNote?: (path: string) => void;
  sections?: ApiSection[];
  // Bumped by the caller whenever `value` was replaced by something other
  // than this editor's own onChange (external reload, reconcile, conflict
  // resolution, revision restore). AtomicCodeMirrorEditor's `markdownSource`
  // is mount-time only, so those cases need a `documentId` change to force
  // the reading pane to pick up the new content instead of going stale.
  contentRevision?: number;
  // Set by the right rail's Outline tab to jump the reading/live pane to a
  // heading from outside this component. The nonce lets the same section be
  // requested twice in a row (bumped on every click, even if the section is
  // unchanged).
  jumpRequest?: { section: ApiSection; nonce: number };
  disabled?: boolean;
  focusRequest?: { path: string; nonce: number };
  onFocusComplete?: (request: { path: string; nonce: number }) => void;
};

const EMPTY_LINK_TARGETS: string[] = [];
const EMPTY_NOTES: NoteSummary[] = [];
const EMPTY_SECTIONS: ApiSection[] = [];

export const Editor = memo(function Editor({
  value,
  mode,
  onChange,
  linkTargets = EMPTY_LINK_TARGETS,
  notePath,
  notes = EMPTY_NOTES,
  suggestNoteLinks,
  onOpenNote,
  sections = EMPTY_SECTIONS,
  contentRevision = 0,
  jumpRequest,
  disabled = false,
  focusRequest,
  onFocusComplete,
}: EditorProps) {
  const view = useRef<EditorView | null>(null);
  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  const readingHostRef = useRef<HTMLDivElement | null>(null);
  const readingViewRef = useRef<EditorView | null>(null);
  const scheduleActiveSectionRef = useRef<() => void>(() => undefined);
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);
  const [readerJumpRequest, setReaderJumpRequest] = useState<{ section: ApiSection; nonce: number }>();
  const disabledRef = useRef(disabled);
  const onFocusCompleteRef = useRef(onFocusComplete);
  disabledRef.current = disabled;
  onFocusCompleteRef.current = onFocusComplete;

  const outlineSections = useMemo(
    () =>
      sections
        .filter((section) => section.level <= 2)
        .sort((a, b) => a.startLine - b.startLine),
    [sections],
  );
  const outlineSectionLines = useMemo(() => {
    const bodyLines = value.split(/\r?\n/);
    const bodyHeadings = bodyLines.flatMap((line, index) => {
      const match = line.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
      return match
        ? [{ level: match[1].length, heading: normalizeHeadingText(match[2]), line: index + 1 }]
        : [];
    });
    let cursor = 0;
    return outlineSections.map((section, sectionIndex) => {
      const matchIndex = bodyHeadings.findIndex((heading, index) => (
        index >= cursor
        && heading.level === section.level
        && heading.heading === normalizeHeadingText(section.heading)
      ));
      if (matchIndex >= 0) {
        cursor = matchIndex + 1;
        return bodyHeadings[matchIndex].line;
      }
      // Keep tracking useful while a heading is being renamed in Live mode:
      // its ordinal is more accurate than the API's file-absolute startLine,
      // which includes frontmatter that is not present in the editor body.
      const ordinalMatch = bodyHeadings[sectionIndex];
      if (ordinalMatch) {
        cursor = Math.max(cursor, sectionIndex + 1);
        return ordinalMatch.line;
      }
      return Math.max(1, Math.min(section.startLine, bodyLines.length));
    });
  }, [outlineSections, value]);
  const outlineSectionsRef = useRef<ApiSection[]>([]);
  const outlineSectionLinesRef = useRef<number[]>([]);
  const modeRef = useRef(mode);
  useEffect(() => {
    outlineSectionsRef.current = outlineSections;
    outlineSectionLinesRef.current = outlineSectionLines;
    modeRef.current = mode;
  }, [mode, outlineSectionLines, outlineSections]);
  const onChangeRef = useRef(onChange);
  const linkTargetsRef = useRef(linkTargets);
  const notesRef = useRef(notes);
  const onOpenNoteRef = useRef(onOpenNote);
  const suggestNoteLinksRef = useRef(suggestNoteLinks);
  // attachSourceHost is a useCallback with empty deps, memoized once for the
  // Editor instance's whole lifetime — its closure over `value` would
  // otherwise be frozen from whichever render first created it, so every
  // later mount of the source EditorView (one happens on every switch into
  // Source mode, since that's a separate conditional JSX branch) would seed
  // the doc with a stale note's content instead of the current one.
  const valueRef = useRef(value);
  const internalSourceValueRef = useRef<string | undefined>(undefined);
  const sourceContentRevisionRef = useRef(contentRevision);
  const synchronizingSourceRef = useRef(false);
  onChangeRef.current = onChange;
  linkTargetsRef.current = linkTargets;
  valueRef.current = value;
  notesRef.current = notes;
  onOpenNoteRef.current = onOpenNote;
  useEffect(() => {
    suggestNoteLinksRef.current = suggestNoteLinks;
  }, [suggestNoteLinks]);

  function wikilinkCompletions(
    context: CompletionContext,
  ): CompletionResult | null {
    const before = context.state.sliceDoc(
      Math.max(0, context.pos - 80),
      context.pos,
    );
    const match = before.match(/\[\[([^\]\n]*)$/);
    if (!match) return null;
    const query = match[1].toLocaleLowerCase();
    const from = context.pos - match[1].length;
    const options = linkTargetsRef.current
      .filter((title) => title.toLocaleLowerCase().includes(query))
      .slice(0, 20)
      .map((title) => ({ label: title, type: "text", apply: title + "]]" }));
    return { from, options };
  }

  const attachSourceHost = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      view.current?.destroy();
      view.current = null;
      return;
    }
    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        markdownBackquoteKey,
        lineNumbers(),
        highlightSpecialChars(),
        drawSelection(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        markdown(),
        autocompletion({ override: [wikilinkCompletions] }),
        EditorView.lineWrapping,
        EditorView.editable.of(!disabledRef.current),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          if (!synchronizingSourceRef.current) internalSourceValueRef.current = next;
          onChangeRef.current(next);
        }),
        sourceTheme,
      ],
    });
    view.current = new EditorView({ state, parent: node });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (sourceContentRevisionRef.current !== contentRevision) {
      sourceContentRevisionRef.current = contentRevision;
      internalSourceValueRef.current = undefined;
    }
    const current = view.current;
    if (!current) return;
    const currentDocument = current.state.doc.toString();
    if (currentDocument === value) {
      internalSourceValueRef.current = undefined;
      return;
    }
    // App's document session intentionally publishes keystrokes on the next
    // animation frame. Until that frame lands, `value` may still be the old
    // prop even though CodeMirror already owns the newer local document.
    // Never replace that local document with the stale prop snapshot.
    if (internalSourceValueRef.current === currentDocument) return;
    synchronizingSourceRef.current = true;
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: value },
    });
    synchronizingSourceRef.current = false;
    internalSourceValueRef.current = undefined;
  }, [contentRevision, value]);

  useEffect(() => {
    if (!focusRequest || focusRequest.path !== notePath) return;
    const frame = requestAnimationFrame(() => {
      editorHandleRef.current?.focus();
      view.current?.focus();
      onFocusCompleteRef.current?.(focusRequest);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, notePath, mode]);

  function findNoteByTitle(title: string): NoteSummary | undefined {
    const lowered = title.toLocaleLowerCase();
    return notesRef.current.find(
      (note) => note.title.toLocaleLowerCase() === lowered
        || note.aliases.some((alias) => alias.toLocaleLowerCase() === lowered)
        || note.path.replace(/\.md$/i, "").split("/").at(-1)?.toLocaleLowerCase() === lowered,
    );
  }

  const remoteLinkMatchesRef = useRef(new Map<string, NoteLinkSuggestion>());

  const readingExtensions = useMemo(
    () => [
      taskCheckboxFallback,
      markdownBackquoteKey,
      // Keep a direct reference to the reading view. Section tracking uses
      // CM6's line blocks (including estimated off-screen positions), which
      // remain stable across virtualization and preserve duplicate-heading
      // identity through the section's source line.
      ViewPlugin.define((editorView) => {
        readingViewRef.current = editorView;
        const initialFrame = requestAnimationFrame(() => scheduleActiveSectionRef.current());
        return {
          update(update) {
            if (update.docChanged || update.viewportChanged || update.geometryChanged) {
              scheduleActiveSectionRef.current();
            }
          },
          destroy() {
            cancelAnimationFrame(initialFrame);
            if (readingViewRef.current === editorView) readingViewRef.current = null;
          },
        };
      }),
      wikiLinks({
        suggest: async (query) => {
          const lowered = query.toLocaleLowerCase();
          const local = notesRef.current
            .filter((note) => note.title.toLocaleLowerCase().includes(lowered))
            .slice(0, 20)
            .map((note) => ({ target: note.title, label: note.title }));
          const remote = suggestNoteLinksRef.current ? await suggestNoteLinksRef.current(query) : undefined;
          remote?.matches.forEach((note) => {
            remoteLinkMatchesRef.current.set(note.title.toLocaleLowerCase(), note);
            note.aliases.forEach((alias) => remoteLinkMatchesRef.current.set(alias.toLocaleLowerCase(), note));
            remoteLinkMatchesRef.current.set(note.path.replace(/\.md$/i, "").split("/").at(-1)?.toLocaleLowerCase() ?? note.path.toLocaleLowerCase(), note);
          });
          if (!remote) return local;
          return remote.matches.map((note) => ({ target: note.title, label: note.title }));
        },
        resolve: async (target) => {
          const note = findNoteByTitle(target);
          if (note) return { target, label: note.title, status: "resolved" as const };
          const lowered = target.toLocaleLowerCase();
          const cached = remoteLinkMatchesRef.current.get(lowered);
          if (cached) return { target, label: cached.title, status: "resolved" as const };
          if (suggestNoteLinksRef.current) {
            const remote = await suggestNoteLinksRef.current(target);
            const exact = remote.matches.find((candidate) => candidate.title.toLocaleLowerCase() === lowered || candidate.aliases.some((alias) => alias.toLocaleLowerCase() === lowered) || candidate.path.replace(/\.md$/i, "").split("/").at(-1)?.toLocaleLowerCase() === lowered);
            if (exact) {
              remoteLinkMatchesRef.current.set(lowered, exact);
              return { target, label: exact.title, status: "resolved" as const };
            }
          }
          return { target, label: target, status: "missing" as const };
        },
        onOpen: (target) => {
          const note = findNoteByTitle(target);
          const remote = remoteLinkMatchesRef.current.get(target.toLocaleLowerCase());
          if (note) onOpenNoteRef.current?.(note.path);
          else if (remote) onOpenNoteRef.current?.(remote.path);
        },
        openOnClick: true,
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
    [],
  );

  useEffect(() => {
    setActiveSectionIndex(0);
    if (mode === "source" || outlineSections.length < 2) return;
    const hostElement = readingHostRef.current;
    if (!hostElement) return;
    const viewportElement = hostElement.closest<HTMLElement>(".note-document-scroll");
    if (!viewportElement) return;
    const viewport: HTMLElement = viewportElement;

    let bottomPinned = false;
    let lastMaxScroll = 0;
    let lastScrollTop = 0;

    function bottomTolerance() {
      return Math.max(2, Math.min(160, viewport.clientHeight * 0.25));
    }

    function updateActive() {
      const editorView = readingViewRef.current;
      if (!editorView || modeRef.current === "source") return;
      const currentSections = outlineSectionsRef.current;
      if (currentSections.length < 2) return;

      const scroller = editorView.scrollDOM;
      const scrollerRect = scroller.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const visibleTop = Math.max(scrollerRect.top, viewportRect.top);
      const visibleBottom = Math.min(scrollerRect.bottom, viewportRect.bottom);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      const activationLine = visibleTop + Math.min(160, visibleHeight * 0.3);
      const maxScroll = viewport.scrollHeight - viewport.clientHeight;
      // CodeMirror can refine its virtualized document height for a frame as
      // the last lines are mounted. Treat the final viewport-sized sliver as
      // the document end so the rail does not stay on the previous heading
      // while that estimate settles.
      const endTolerance = bottomTolerance();

      // The final heading can remain below the activation line when the
      // document has reached its scroll limit. Clamp to the final section so
      // the rail does not leave the previous heading active at the bottom.
      if (maxScroll <= 0 || bottomPinned || viewport.scrollTop >= maxScroll - endTolerance) {
        bottomPinned = true;
        const lastSection = currentSections.length - 1;
        setActiveSectionIndex((current) => current === lastSection ? current : lastSection);
        return;
      }

      let next = 0;
      for (let index = 0; index < currentSections.length; index += 1) {
        const lineNumber = Math.max(1, Math.min(
          outlineSectionLinesRef.current[index] ?? currentSections[index].startLine,
          editorView.state.doc.lines,
        ));
        const block = editorView.lineBlockAt(editorView.state.doc.line(lineNumber).from);
        const headingTop = scrollerRect.top - scroller.scrollTop + block.top;
        if (headingTop <= activationLine) next = index;
        else break;
      }
      setActiveSectionIndex((current) => current === next ? current : next);
    }

    let frame = 0;
    function scheduleUpdate() {
      const maxScroll = viewport.scrollHeight - viewport.clientHeight;
      const tolerance = bottomTolerance();
      // A ResizeObserver callback can see the newly measured height before a
      // scroll event reaches this handler. Remember whether the previous
      // layout was already at its end so a growing virtualized document is
      // still treated as the same bottom visit.
      bottomPinned = nextBottomPinnedState({
        bottomPinned,
        lastMaxScroll,
        lastScrollTop,
        maxScroll,
        scrollTop: viewport.scrollTop,
        tolerance,
      });
      // The live-preview editor refines its height as virtualized blocks are
      // measured. If the user reached the end before that refinement, keep
      // the outer document viewport pinned to the newly discovered end so
      // the final section can become active instead of leaving a stale
      // bottom slice below the current scroll position.
      if (bottomPinned && maxScroll > 0 && viewport.scrollTop < maxScroll) {
        viewport.scrollTop = maxScroll;
      }
      lastMaxScroll = maxScroll;
      lastScrollTop = viewport.scrollTop;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateActive();
      });
    }

    scheduleActiveSectionRef.current = scheduleUpdate;
    viewport.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(viewport);
    resizeObserver.observe(hostElement);
    scheduleUpdate();
    return () => {
      scheduleActiveSectionRef.current = () => undefined;
      viewport.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [mode, outlineSections]);

  // Plain heading text collides with any earlier prose that happens to
  // repeat it (e.g. a link labeled the same as its own target heading), so
  // revealText's first-match search needs the "## " marker to disambiguate
  // from body text — confirmed via a real reveal-jumping-to-the-wrong-spot
  // failure while stress-testing a note whose intro links to its own
  // "Jump Target" heading using that exact phrase.
  function revealQueryFor(section: ApiSection): string {
    return "#".repeat(section.level) + " " + section.heading;
  }

  const jumpToSection = useCallback((section: ApiSection, index: number) => {
    setActiveSectionIndex(index);
    setReaderJumpRequest((current) => ({ section, nonce: (current?.nonce ?? 0) + 1 }));
    editorHandleRef.current?.revealText(revealQueryFor(section));
  }, []);

  useEffect(() => {
    if (!jumpRequest) return;
    const index = outlineSections.findIndex((section) => section.startLine === jumpRequest.section.startLine);
    if (index >= 0) setActiveSectionIndex(index);
    setReaderJumpRequest(jumpRequest);
    editorHandleRef.current?.revealText(revealQueryFor(jumpRequest.section));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest]);

  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  const handleLinkClick = useCallback((url: string) => {
    if (url.startsWith("#")) {
      const anchor = url.slice(1);
      const target = sectionsRef.current.find((section) => slugifyHeading(section.heading) === anchor);
      if (target) {
        editorHandleRef.current?.revealText(revealQueryFor(target));
        return;
      }
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  if (mode !== "source") {
    const useRichReader = mode === "reading" && hasRichMarkdownBlock(value);
    return (
      <div className="relative flex min-h-[440px] min-w-0 w-full max-[700px]:min-h-[420px]">
        <div
          ref={readingHostRef}
          className={(useRichReader ? "markdown-reader-host " : "atomic-editor-host ") + "min-h-[440px] min-w-0 flex-1 overflow-visible max-[700px]:min-h-[420px]"}
          aria-label="Markdown editor"
        >
          {useRichReader ? <MarkdownReader value={value} sections={sections} jumpRequest={readerJumpRequest} notes={notes} onChange={onChange} onOpenNote={onOpenNote} /> : <AtomicCodeMirrorEditor
              documentId={notePath ? notePath + ":" + contentRevision : notePath}
              markdownSource={value}
              readOnly={mode === "reading" || disabled}
              codeLanguages={CODE_LANGUAGES}
              onMarkdownChange={onChange}
              onLinkClick={handleLinkClick}
              extensions={readingExtensions}
              editorHandleRef={editorHandleRef}
            />}
        </div>
        <SectionOutline
          sections={outlineSections}
          activeIndex={activeSectionIndex}
          onJump={jumpToSection}
        />
      </div>
    );
  }

  return (
    <div
      className="h-full min-h-[440px] max-[700px]:min-h-[420px]"
      ref={attachSourceHost}
      aria-label="Markdown editor"
    />
  );
});
