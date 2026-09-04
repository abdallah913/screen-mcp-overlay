# Prior art survey — agent-driven screen overlay (2026-09-02)

## A. Closest to the end goal (agent sees screen AND draws on it)

| Project | Stack | License | Verdict |
|---|---|---|---|
| [RyansOpenSourceRice/overlay-companion-mcp](https://github.com/RyansOpenSourceRice/overlay-companion-mcp) | C# MCP server, Podman containers, KasmVNC | GPL-3.0 | **Concept match, wrong substrate.** Overlays render inside a browser VNC session of a *remote/VM* desktop, not on your real Windows desktop. Self-described "prefunctional development." GPL-3.0 also forces our licensing. Steal the tool taxonomy, not the code. |
| [screenannotations.com](https://screenannotations.com/) | closed source, commercial | proprietary | Ships the exact feature (Claude Code / Cursor / Codex draw on live screen). Proof the idea works. Nothing to reuse. |
| [aamar-shahzad/mcp-screenshot-server](https://github.com/aamar-shahzad/mcp-screenshot-server) | Python + MCP SDK + Pillow | MIT | **Best reusable asset.** Excellent annotation vocabulary: `annotate`, `precise_annotate`, `batch_annotate`, `label_regions`, `add_box/line/arrow/text/circle/highlight/numbered_callout/border`, anchor+offset positioning, auto-clamp to bounds, `undo`. Full Windows support. **But it draws into saved PNG files, not a live overlay.** Port the schema + geometry logic; replace the Pillow renderer with a canvas overlay. |

## B. Capture-only MCP servers (agent sees, cannot draw)
- [kmoulder/screen-capture-mcp](https://github.com/kmoulder/screen-capture-mcp) — Windows, fully local
- [lfzds4399-cpu/claude-screen-mcp](https://github.com/lfzds4399-cpu/claude-screen-mcp) — Win/macOS/Linux, zero native runtime deps
- [chunlea/screenshot-mcp](https://github.com/chunlea/screenshot-mcp) — cross-platform, built for native-app testing
- Fast capture backends if we outgrow Electron's `desktopCapturer`: [DXcam](https://github.com/ra1nty/dxcam) (Py), [rusty-duplication](https://github.com/DiscreteTom/rusty-duplication) / [dxgi-capture-rs](https://github.com/RobbyV2/dxgi-capture-rs) (Rust)

## C. Overlay/annotation apps (draw, no agent)
- [ifer47/markeron](https://github.com/ifer47/markeron) — **Tauri v2 + Vue3 + Canvas, MIT, Win/macOS, ~1.5MB.** 11 tools (pen, highlighter, laser, arrow, rect, ellipse, line, eraser, text, stamp, select), click-through toggle (Ctrl+Shift+X). Best reference for the drawing layer. No IPC/API surface — we'd add one.
- ppInk, FlowInk, DrawPen, [AndreaGriffiths11/annotation-overlay](https://github.com/AndreaGriffiths11/annotation-overlay)

## D. Overlay AI assistants (agent + overlay, but no drawing, no MCP)
[pluely](https://github.com/iamsrikanthnani/pluely) (Tauri, 10MB), [OpenCluely](https://github.com/TechyCSR/OpenCluely), [cue](https://github.com/Blueturboguy07/cue), pickle-com/glass, Natively.
Reusable *UX* patterns: always-on-top translucent HUD, global hotkeys, screenshot→LLM round trip, capture-invisibility.

## E. Conclusion
No open-source project combines (1) live desktop overlay on Windows, (2) MCP-driven drawing, (3) agent-initiated screen capture, (4) human-in-the-loop pointing. Category A is the only overlap and it's Linux/VNC-only and unfinished.

**Build the overlay + MCP server; borrow the annotation schema (C-tier: MIT) and the drawing-layer patterns (markeron: MIT).**

---

# Technical findings that dictate the design

1. **Claude Code CLI supports MCP elicitation** (`elicitation/create`, client 2.1.74+; Claude Desktop does *not*). The server can pause mid-tool and ask the user a structured question. This makes real human-in-the-loop possible: "I highlighted 3 candidates — which one?"
   - refs: [claude-code#7108](https://github.com/anthropics/claude-code/issues/7108), [#41110](https://github.com/anthropics/claude-code/issues/41110), [MCP 2025-11-25 spec](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)

2. **`setContentProtection(true)` solves overlay-in-its-own-screenshot.** On Windows 10 2004+ Electron maps this to `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`; DWM renders the window on the physical display but omits it from *every* capture pipeline. No hide→capture→show race, no frame timing hacks. Must be a toggle (the user may want to screen-share the annotations).
   - ref: [electron#24274](https://github.com/electron/electron/pull/24274)

3. **Do not return base64 images from MCP tools by default.** Known Claude Code issue: MCP `ImageContent` is passed through as *text*, ~15–25k tokens per screenshot vs ~1.6k for a native image block. Mitigation: write the PNG to disk, return the **path**, and let the agent's own `Read` tool ingest it natively. Offer base64 as an opt-in for clients that handle it correctly.
   - ref: [claude-code#31208](https://github.com/anthropics/claude-code/issues/31208)

4. **The coordinate contract is the make-or-break detail.** Windows per-monitor DPI means Electron DIPs != capture pixels. Every capture result must carry `{displayId, physicalBounds, scaleFactor, origin}`; every draw tool must name its coordinate space (`physical` | `dip` | `normalized`). Get this wrong and every arrow lands in the wrong place on a 150%-scaled laptop + 100% external monitor.

5. **Transport should be streamable HTTP on 127.0.0.1, not stdio.** The overlay is a long-lived GUI process. stdio would make Claude Code own its lifecycle (dies with the session, one client only). HTTP gives: overlay survives across sessions, multiple agents connect at once, and Cursor / Codex / Cline / Continue work with the same server — which is what "any agent of my choosing" requires.

6. **Agents are unreliable at raw pixel coordinates.** Two mitigations worth building in:
   - Optional labeled grid burned into captures (cheap, big accuracy win).
   - Windows UI Automation element enumeration ([uiautomation crate](https://crates.io/crates/uiautomation), or a small C# helper) so the agent can say "highlight the Save button" and we resolve the rect. Phase 3.
