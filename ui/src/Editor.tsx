import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "@codemirror/view";
import type { NoteSummary } from "./api";
import type { ApiSection } from "../../src/api/contracts";
import { SectionOutline } from "./components/section-outline";

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

type EditorProps = {
  value: string;
  mode: "source" | "reading";
  onChange: (value: string) => void;
  linkTargets?: string[];
  notePath?: string;
  notes?: NoteSummary[];
  onOpenNote?: (path: string) => void;
  sections?: ApiSection[];
};

export function Editor({
  value,
  mode,
  onChange,
  linkTargets = [],
  notePath,
  notes = [],
  onOpenNote,
  sections = [],
}: EditorProps) {
  const view = useRef<EditorView | null>(null);
  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  const readingHostRef = useRef<HTMLDivElement | null>(null);
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);

  const outlineSections = useMemo(
    () =>
      sections
        .filter((section) => section.level <= 2)
        .sort((a, b) => a.startLine - b.startLine),
    [sections],
  );
  const onChangeRef = useRef(onChange);
  const linkTargetsRef = useRef(linkTargets);
  const notesRef = useRef(notes);
  const onOpenNoteRef = useRef(onOpenNote);
  onChangeRef.current = onChange;
  linkTargetsRef.current = linkTargets;
  notesRef.current = notes;
  onOpenNoteRef.current = onOpenNote;

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
      doc: value,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        drawSelection(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        markdown(),
        autocompletion({ override: [wikilinkCompletions] }),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged)
            onChangeRef.current(update.state.doc.toString());
        }),
        sourceTheme,
      ],
    });
    view.current = new EditorView({ state, parent: node });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === value) return;
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: value },
    });
  }, [value]);

  function findNoteByTitle(title: string): NoteSummary | undefined {
    const lowered = title.toLocaleLowerCase();
    return notesRef.current.find(
      (note) => note.title.toLocaleLowerCase() === lowered,
    );
  }

  const readingExtensions = useMemo(
    () => [
      wikiLinks({
        suggest: async (query) => {
          const lowered = query.toLocaleLowerCase();
          return notesRef.current
            .filter((note) => note.title.toLocaleLowerCase().includes(lowered))
            .slice(0, 20)
            .map((note) => ({ target: note.title, label: note.title }));
        },
        resolve: async (target) => {
          const note = findNoteByTitle(target);
          return note
            ? { target, label: note.title, status: "resolved" as const }
            : { target, label: target, status: "missing" as const };
        },
        onOpen: (target) => {
          const note = findNoteByTitle(target);
          if (note) onOpenNoteRef.current?.(note.path);
        },
        openOnClick: true,
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
    [],
  );

  useEffect(() => {
    setActiveSectionIndex(0);
    if (mode !== "reading" || outlineSections.length < 2) return;
    const host = readingHostRef.current;
    if (!host) return;
    const totalLines = value.split("\n").length;

    function updateActive(scroller: HTMLElement) {
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      const fraction = maxScroll > 0 ? scroller.scrollTop / maxScroll : 0;
      const approxLine = 1 + fraction * (totalLines - 1);
      let next = 0;
      for (let i = 0; i < outlineSections.length; i += 1) {
        if (outlineSections[i].startLine <= approxLine) next = i;
        else break;
      }
      setActiveSectionIndex(next);
    }

    let frame = 0;
    function onScroll(event: Event) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("cm-scroller")) return;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateActive(target);
      });
    }

    host.addEventListener("scroll", onScroll, true);
    return () => {
      host.removeEventListener("scroll", onScroll, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [mode, outlineSections, value]);

  const jumpToSection = useCallback((section: ApiSection, index: number) => {
    setActiveSectionIndex(index);
    editorHandleRef.current?.revealText(section.heading);
  }, []);

  if (mode === "reading") {
    return (
      <div className="flex h-full min-h-[440px] max-[700px]:min-h-[420px]">
        <div
          ref={readingHostRef}
          className="atomic-editor-host h-full min-w-0 flex-1 overflow-auto"
          aria-label="Markdown editor"
        >
          <AtomicCodeMirrorEditor
            documentId={notePath}
            markdownSource={value}
            readOnly
            codeLanguages={CODE_LANGUAGES}
            onMarkdownChange={onChange}
            extensions={readingExtensions}
            editorHandleRef={editorHandleRef}
          />
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
}
