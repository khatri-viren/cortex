# Hyperframes Composition Brief: Cortex

## Objective

Create a short launch-style brag video for Cortex, a local-first, Git-backed notes system that makes the living relationship between Markdown, code, repositories, Git history, and agent context visible.

## Output

- Composition directory: `brag-output-2026-09-17-233513/composition/`
- Rendered video: `brag-output-2026-09-17-233513/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20.8 seconds

## Source Material

- Project root: `/Users/khatri_viren/Developer/Projects/cortex`
- Primary files read: `README.md`, `package.json`, `ui/index.html`, `ui/src/App.tsx`, `ui/src/MarkdownReader.tsx`, `ui/src/index.css`, `ui/src/components/inspector-drawer.tsx`
- Product name: Cortex
- Tagline / strongest claim: “Markdown files are the source of truth” and “Notes aren't a side channel next to the code graph — they're part of it.”
- Key UI or visual moment to recreate: the current three-pane desktop shell with search/tree, rendered note surface, and Context/Outline/Git/Diagnostics rail; followed by the full graph view
- Copy that must appear verbatim:
  - Cortex
  - Project Spec
  - Source / Reading / Live
  - Context
  - Markdown source of truth
  - Rebuildable SQLite index
  - Strict MCP tools

## Creative Direction

- Tone preset: polished
- Creative direction: a quiet product film for the moment notes become infrastructure
- Interpretation: dark, compact, serious, and specific; let the UI relationship do the bragging
- Angle: Notes are not the context. Cortex is the layer that keeps a note attached to the work it explains.
- Hook: “Notes are not the context. Cortex is.” over the first two seconds
- Outro / punchline: “Cortex — Context that stays attached.”
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unrelated visual redesign
  - Claims not present in the repository or vault plan

## Visual Identity

- Background: `oklch(0.145 0 0)` translated to a near-black neutral `#111312`
- Reading surface: `oklch(0.22 0 0)` translated to `#242625`
- Text: near-white `#f5f7f4`
- Accent: Cortex lime `oklch(0.768 0.233 130.85)` translated to `#b8f05a`
- Muted surface: `#2d302e`
- Border: `rgba(245,247,244,0.14)`
- Typography: system sans fallback for deterministic local rendering; monospace metadata for paths and graph labels
- Design language: quiet dark macOS-style shell, wide reading column, thin borders, clear node-kind color, minimal shadows

## Audio

- Track: `assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`
- Volume: 0.28
- Cue preset: `assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json`
- Strong cues used as timing guidance: 8.74s shell reveal, 13.11s graph lock, 17.47s outro
- No narration (`--voice` was not supplied)
- No individual SFX assets were available in the bundled skill directory; use restrained visual accents and the music bed

## Composition Guidance

Build one standalone 1920x1080 composition with four timed scenes and one paused GSAP root timeline. Use the actual copy and architecture of Cortex in the visual mockup. All copy must hold long enough to read. The window and graph are the product evidence; decorative lines/glows should support hierarchy rather than become generic motion graphics.

### Scene timings

- 0.0–3.2s: context problem hook
- 3.2–8.7s: desktop shell reveal
- 8.7–14.7s: note-to-code graph relationship
- 14.7–20.8s: source-of-truth promises and outro

### Motion

Use readable slide/fade/assemble motion with 0.35–0.7s entrances, asymmetry between panes, and no infinite loops. The graph nodes and edges are the most important motion; the final line must hold in a settled frame.

### Validation and delivery

Run `npx hyperframes check` inside the composition directory before preview/render. Capture snapshots at 2.1s, 6.5s, 11.9s, 16.7s, and 19.4s. Render the final MP4, extract the settled graph or outro frame as the poster, bake that poster into frame 0, and write `share-copy.txt`.
