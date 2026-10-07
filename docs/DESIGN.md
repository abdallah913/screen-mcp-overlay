# Design notes

Why this works the way it does. The [README](../README.md) covers installing and using it; this file
is the reasoning, the measurements and the things that turned out to be harder than they looked.

## Contents

- [Cheap first, screenshots on escalation](#cheap-first-screenshots-on-escalation)
- [Driving a walkthrough](#driving-a-walkthrough)
- [Anchored annotations](#anchored-annotations--drawings-that-follow-their-target)
- [Coordinates](#coordinates--the-part-that-usually-breaks)
- [How it works](#how-it-works)
- [The built-in chat panel](#the-built-in-chat-panel)
- [Configuration](#configuration)
- [Packaging notes](#packaging-notes)
- [Development](#development)
- [Prior art](#prior-art)
- [Performance](#performance)
- [Status and limitations](#status)

---

## Cheap first, screenshots on escalation

`describe_window` renders a window's controls as an indented tree — name, role, value, disabled
state, and an anchorable ref per line:

```
Export Dialog [window]  800x600@420,300
  Format [combobox] "PNG"  el_3
  Quality [slider] "80"  el_4
  Export [button] disabled  el_5
  Cancel [button]  el_6
```

Measured on a full Chrome window: **512 tokens versus 1844 for a screenshot of the same window, 3.6x
cheaper** — and more actionable, because every line can be pointed at directly. A focused dialog does
better than 3.6x; a browser window is close to the worst case, since most of its tree is chrome. (Both
sides have shrunk since: screenshots now default to ~1.5k tokens, see [Coordinates](#coordinates--the-part-that-usually-breaks),
and trees drop echo rows, below.)

Chromium, Electron and WinUI put a `text` child inside nearly every button, link and list item, carrying
the same label as its parent: `Save [button]` followed by `Save [text]`. That child is a row and a ref
that say nothing new, in exactly the toolkits whose trees are biggest, so it is dropped. Only `text`
echoes go, never one with a value or an AutomationId, and never a direct child of the window (Chromium's
title-repeating wrapper is what the diagnosis below keys on). A value equal to its own name is not
printed twice either.

Search hits from `find_ui_elements` and `wait_for_element` use the same row shape plus a rectangle —
`Export [button] disabled id=ExportBtn  80x24@250,150  el_2` — so there is one format to read, and every
tool prints rectangles as `WxH@x,y`.

When a tree comes back thin, `describe_window` says **why**. The two failure modes need different
fallbacks and look identical from the node list alone: no accessibility provider attached at all,
versus a provider that answers for the title bar but not the content. The latter is what Chromium and
Electron do until accessibility is enabled (`--force-renderer-accessibility`), and what Qt/QML does
unless the app ships the accessibility plugin and its controls set `Accessible.name`. Either way it
points at `read_text`.

A wrapper element that merely repeats the window's own title counts as frame, not content — Chromium
nests one, and treating it as real content was enough to stop the diagnosis firing on exactly the
tree it was written for.

The escalation ladder is three rungs, cheapest first:

1. **`describe_window`** — the tree as text. Answers most questions.
2. **`read_text`** — OCR, when the tree is empty (canvas, games, remote desktop). Returns per-line
   rectangles, so results stay anchorable rather than being an undifferentiated blob. It captures at
   native resolution on purpose: downscaling is how a *screenshot* saves tokens, but OCR returns text
   rather than pixels, so shrinking only costs accuracy — measured as badly garbled output on a
   1568px-wide full-screen shot versus clean recognition at native size.
3. **`capture_screen`** — when you must actually see it: colours, layout, charts, a rendering bug, or
   a confused user. Pass `window` and it renders that window; measured at **1.8x more detail per
   token** for a window covering ~55% of the screen, and the gain grows as the window shrinks.

### Window capture is z-order aware

`capture_screen(window)` renders the window itself via `PrintWindow`, so the image is that window's
content whether or not anything is covering it. This started as a real bug: it used to crop a screen
grab to the window's rectangle, which returns whatever is *drawn* there. Ask for the window behind
and you got the window in front — under the right name, so it looked correct and got annotated over
confidently. Verified by deliberately covering a window 72% and capturing it: the render shows the
target, and the covering window does not appear at all.

`asRendered: true` gives the old behaviour when you genuinely want what the user sees, occlusions
included. It reports how much is covered and by what:

```
WARNING: about 72% of this window is covered by Xelqore-ml studio — Visual Studio Code.
Those pixels belong to the covering window, not this one. Drop asRendered, or call focus_window first.
```

The overlay's own windows are excluded from that calculation — they span the whole screen, so
counting them would report every window as fully covered, always.

### Deltas

Every call returns a `snapshotId`. Pass it back as `since=` and you get only what changed:

```
11 change(s) since snap_2:
~ Text editor [document] "hello" enabled -> "hello overlay" enabled  el_64
+ Line 1, Column 40 [text] enabled  el_83
- *hello - Notepad [window]
snapshotId: snap_3
```

Measured on Notepad: a full tree is ~291 tokens, an unchanged re-check is **12**, and a real edit is
~173. The baseline is client-supplied rather than server-held because the MCP layer is stateless and
shared by several clients at once — there is no session identity to hang it on, and the agent already
has the previous response in its context. Same reasoning as `captureId`.

An unknown or evicted `since` returns the **full tree with a note**, never an error: trading tokens
for fragility would defeat the point. So does a baseline taken of a different window. And when the
diff would be longer than the tree — after a navigation, or a dialog opening — the full tree is
returned instead.

**The subtlety is the diff key.** Element refs are allocated per query: two identical `describe_window`
calls share none of them (measured: 0 of 12 identical), so a ref-keyed diff reports the whole tree as
changed. Keys are structural instead — but the ancestor path uses **role and sibling position only,
never names**. Including ancestor names is the obvious design and is measurably worse: Notepad puts
document state in its title, so an edit renames the root, which re-keys every descendant. Before that
fix the diff for typing one word came out *longer than the full tree*. A node's own name still
identifies it, so a rename costs one row rather than a subtree.

Indentation follows the retained ancestor chain rather than raw UIA depth. Chromium buries content
about 19 levels down, and pruning unnamed containers leaves gaps, so indenting by raw depth wastes
forty columns — while ranking depths globally (the first thing tried here) gives siblings different
indents and misrepresents the structure.

### Naming windows

Every `window` parameter takes a ref, a title substring, or `"foreground"`. Before that, the first move
of almost every task was `list_windows`: a whole round trip, plus a response that grows by a line per open
window, just to learn a number to pass to the next call. Now an agent goes straight to
`describe_window {window: "Notepad"}`.

Matching is in [src/shared/windows.ts](../src/shared/windows.ts): an exact title beats a substring, and
among several matches the foreground window wins, then the frontmost (the list arrives in z-order). It
guesses rather than reporting "ambiguous" because the chosen window's title is in every response, so a
wrong guess is visible and cheap to correct. No match is an error that lists the open windows, so the
agent can correct itself without a separate `list_windows`. A numeric ref skips the window list entirely.

Anchors store the resolved ref, not the title — a title like Notepad's changes the moment the document
is edited.

### Tool surface

The tool list is resent on every turn of every conversation, so it is kept terse and the prose lives
here instead. Measured as the model sees it (name, description and input schema per tool, serialised):

| | Tools | Characters | ~Tokens per turn |
|---|---|---|---|
| Early trim | 9 | 7,670 | 2,073 |
| Before this pass | 14 | 12,673 | 3,425 |
| Now | 13 | **10,153** | **2,744** |

That is with `until`, `automationId` on waits and title matching all *added*. `npm test` pins it with a
budget (`TOOL_LIST_BUDGET` in [test/tools.test.mjs](../test/tools.test.mjs)), so growth is a deliberate
choice rather than drift. Where it came from:

- **Schema noise.** The SDK's zod conversion puts a `$schema` URI on every tool and `±9007199254740991`
  bounds on every unbounded integer. Neither tells the model anything; together they were ~700
  characters a turn. [server.ts](../src/main/mcp/server.ts) strips them, and builds the list once
  rather than re-converting every schema on every request.
- **Descriptions versus responses.** A description is paid on every turn; a response only when the tool
  runs. So descriptions say what a tool does and when to reach for it, and caveats that only matter in
  the moment — an occluded window, an unscoped search, an app that ignores wheel messages — moved into
  the responses that trigger them.
- **Inference over parameters.** An anchor's `kind` and a shape's `fit` are inferred (a name means a
  control, a ref means that element, otherwise a window; an anchored shape without a size fits its
  target). Both still work if sent. `speak` became `show_message {speak: true}`, and `wait_for_element`
  lost `pollMs`, which cost CPU, never tokens.
- **Nested selectors go undescribed.** `name`, `automationId` and `role` are described once per tool;
  the copies inside `until` are not.

Responses were tightened the same way: `list_windows` is one line per window (`ref WxH@x,y title`)
instead of three with the window class, and `capture_screen`, `annotate` and `find_ui_elements` dropped
the boilerplate that repeated their own descriptions.

### Resources and prompts

`screen://windows` exposes the window list as an MCP resource, so a client that supports resources
can hold it as ambient context instead of calling `list_windows`. The `guide_me_through` prompt
carries the walkthrough loop so it does not have to be rediscovered each time. Clients that support
neither simply ignore them; the same data is available through tools.

## Driving a walkthrough

`focus_window(ref)` brings the target application forward, which is the first move of most
walkthroughs and makes the rest scriptable. Windows refuses `SetForegroundWindow` from a process that
does not already own the foreground, so this attaches to the foreground thread's input queue first —
the documented way round it. When Windows still refuses (another app locking focus, or a drag in
progress) it says so rather than silently doing nothing.

It changes which window is in front. It does not click or type; the overlay still never touches the
mouse or keyboard.

`scroll_window(ref, notches)` posts wheel messages straight to a window, so long panels can be walked
through rather than only their visible part. The pointer does not move. Re-read with
`describe_window` afterwards: refs and rectangles change once content scrolls.

`highlight_and_wait` is the basic walkthrough step — circle a control with the instruction, wait until
the user has done it, clear the circle — in one call where it used to take three:

```jsonc
{
  "window": "Paint", "name": "Export", "prompt": "Click Export",
  "until": { "condition": "appears", "role": "window", "name": "Save as" }
}
```

With `until`, the overlay stays click-through: the user operates the application normally, and the call
returns once the UI reaches that state (searched in the step's window unless `until.window` says
otherwise; `role: "window"` alone watches for a new top-level window). Without `until`, it waits for a
confirming click instead — and **that click is captured by the overlay, so the application never
receives it**. The original version only had that mode, which made it a poor walkthrough step: the user
clicked Export, nothing happened in the app, and the agent moved on to a dialog that never opened. In
click mode the response says whether the click landed on the target, measured against the circle's live
position.

Either way it clears only its own circle, rather than everything on screen.

### Sequencing with `wait_for_element`

The primitive walkthroughs need. Draw step 3, then call it — the agent pays for one request no matter
how long the app takes:

```jsonc
{ "condition": "appears", "name": "Export complete", "window": "330312", "timeoutMs": 120000 }
```

Conditions are `appears`, `disappears` (a spinner finishing, a dialog closing) and `enabled`, matched by
`name`, `role` or `automationId`. On success it returns the matching control's row, ready to anchor to.
On timeout it returns `NOT met` rather than erroring, so the agent can decide what to do next.

Searches see disabled controls. They used not to: the helper's base condition was `IsEnabled=true`, so
a button greying out counted as `disappears` and a disabled one could never `appear`. An `enabled` wait
on a role alone also used to stop at the first match, which could be a disabled control while an
enabled one existed.

`timeoutMs: 0` checks once and returns immediately — that is the assertion form, answering
"is Export disabled?" in a few tokens rather than returning a tree to reason over. It is the same
tool rather than a separate `check_state` because the machinery is identical and one denser tool
beats two thin ones.

**Always pass `window`.** An unscoped control search walks every window on the desktop — measured at
~7 s per check, which also lets the timeout overshoot. Scoped, it is ~95 ms; waiting on a top-level
window skips the accessibility tree entirely and uses the window list, measured at ~300 ms detection
latency. The tool says so in its result when you forget.

Polling happens in the Electron process, not the helper: the helper is single-threaded, and blocking
it would freeze the anchor tracker so annotations would stop following their targets. This costs CPU,
never tokens.

## Anchored annotations — drawings that follow their target

Fixed coordinates go stale the moment a window moves. Pass an `anchor` and they stop being fixed:

```jsonc
{
  "anchor": { "window": "Notepad", "name": "Save" },
  "shapes": [{ "type": "circle", "pad": 10, "text": "click here" }]
}
```

A rectangle shape with no size snaps to the target's own rectangle, grown by `pad`. Given a size,
`x`/`y`/`width`/`height` are offsets from the target's top-left in physical pixels. Either way a background tracker re-reads the
target's rectangle every 120 ms and moves the drawing with it, across monitors if need be. If the
target closes or is minimised the annotation hides itself, and reappears if the target comes back.

Three anchor forms, increasing in robustness. The kind is inferred from what is given (an explicit
`kind` is still accepted):

| Anchor | Survives | Use when |
|---|---|---|
| `{window}` | the window moving | pointing at a region of an app |
| `{ref}` (a ref from `describe_window` or `find_ui_elements`) | moving, resizing **and** relayout | pointing at a specific control |
| `{window, name}` (or `automationId`, `role`) | all of the above, **plus the control being recreated** | almost always |

Prefer `automationId` over `name` when the app sets one: it is the app's own handle, so it survives
relabelling and translation where a name match does not. `describe_window` and `find_ui_elements`
show `id=...` on rows that have one — on VS Code, 12 of 92 rows do.

A `{window, name}` anchor resolves the selector and draws in **one call**, replacing the
find_ui_elements-read-result-then-annotate round trip. It also stores the selector, so when the ref
stops resolving the tracker re-finds the control by name (throttled to every 2 s, since that costs a
tree search). That is what lets an anchored drawing survive a helper restart, and it is the first
half of cross-run durability.

Element anchoring removes the guesswork entirely: instead of estimating a button's position from a
screenshot, ask for it by name and get its exact rectangle. Coverage is good for native Windows apps
and surprisingly good for Electron ones (VS Code exposes ~2800 nodes), thinner for browser *page*
content, and absent for canvas and game UIs — so reading coordinates off a screenshot remains the
fallback, not a deprecated path.

Roles are the short names of all 41 UIA control types (`button`, `slider`, `menu`, `dataitem`, …, plus
aliases such as `textbox` and `dialog`). The helper used to name twenty, and the gaps failed silently in
both directions: a slider came back as `[other]`, and filtering by an unlisted role dropped the filter
and matched every control with the right name. An unknown role is now an error that lists the real ones,
so the agent learns the vocabulary from the one call that needed it rather than from every tool
description.

## Coordinates — the part that usually breaks

Agents read pixel coordinates off a screenshot. That screenshot is downscaled, and the display it
came from may be DPI-scaled. Naive implementations lose an arrow by 30% on a 150%-scaled laptop.

Here the agent never converts anything. It passes back the **image pixel coordinates it just read**,
tagged with the `captureId`:

```jsonc
{
  "space": "image",          // default whenever a screenshot exists
  "captureId": "cap_3",
  "shapes": [
    { "type": "circle", "x": 812, "y": 344, "width": 120, "height": 120, "text": "this button" }
  ]
}
```

`space` also accepts `physical` (display pixels), `dip` (scaled logical pixels) and `normalized`
(0..1 fractions). All conversion lives in [src/shared/geometry.ts](../src/shared/geometry.ts) — if a
shape lands in the wrong place, the bug is in that one file.

Verified working on a 2560×1440 display at 1.25× scaling captured down to 1200×675.

### The default capture size

The contract only holds if the model sees the image at the size it was written. A model API that
receives an image over its limit shrinks it first, and the model then reads coordinates in the shrunken
image while `space:"image"` interprets them in ours. Claude models before the high-resolution generation
rescale anything over **1568px on the long edge or ~1.15 megapixels**; the old default capped only the
edge, and a 16:9 frame at 1568px wide is 1.38MP, so on those models every coordinate came back 7-9%
short.

The default now fits both limits — a 1920×1080 display captures at 1430×804 — which also cuts a
screenshot from ~1.8k to ~1.5k tokens. High-resolution models (Opus 4.7 and later, Sonnet 5 and later)
accept up to 2576px with 1:1 coordinates; pass `maxDimension` to use that, and the area cap no longer
applies. A downscaled capture says so in its response, since that is the usual reason small text is
unreadable.

---

## How it works

| Concern | Approach | Why |
|---|---|---|
| Access control | Bearer token (header or `?key=`), no CORS headers at all, browsers refused outright, DNS-rebinding protection on | An earlier version sent `Access-Control-Allow-Origin: *` on an unauthenticated endpoint that reads the screen — meaning any web page you visited could `fetch()` it. Private Network Access restrictions would mitigate that but are not universally enforced. Local MCP clients never send `Origin` and never need CORS, so refusing anything that does costs nothing. |
| Audit | Every capture posts a line into the panel | A screen read should never be silent. |
| Transport | Streamable HTTP on loopback, stateless | stdio would tie the overlay's lifetime to one Claude Code session and spawn a second copy of the app per client. HTTP lets many clients share one long-lived overlay. |
| Server state | None. Everything lives in [`store`](../src/main/store.ts) | Lets the MCP layer be stateless and still have every client see the same screen. |
| Overlay windows | One transparent, click-through, always-on-top window per display, sized in DIPs | The canvas coordinate space *is* display-local DIPs, so the renderer needs no further mapping. |
| Not appearing in its own screenshots | `setContentProtection(true)` → `WDA_EXCLUDEFROMCAPTURE` | DWM draws the overlay on the physical display but omits it from every capture pipeline. No hide → capture → show race. Win10 2004+. |
| Screenshots to the agent | A **file path**, not base64 | Claude Code renders inline MCP images as *text* — 15–25k tokens versus ~1.6k for a native image block ([#31208](https://github.com/anthropics/claude-code/issues/31208)). The agent's own Read tool ingests the path natively. `returnImage: true` opts back in. |
| Human-in-the-loop | `wait_for_user_click` as a blocking tool call | MCP elicitation is form/URL-shaped and unsupported by several clients; a long-running tool call works everywhere. |
| Anchored annotations | A 186 KB Rust helper (`native/uia-helper`) speaking JSON lines over stdio | One long-lived process: the tracker re-reads rectangles ~8x a second, and a process spawn per query would cost more than the query. It **must** call `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` — without it Windows silently returns DPI-virtualised rectangles. |
| Physical -> display-local coords | `screen.screenToDipPoint`, never division by a scale factor | With two monitors at different scaling the DIP layout is not a uniform scaling of the physical layout; arithmetic that assumes it is puts annotations on the wrong screen. |
| Following an editor session | Tail the transcript JSONL; never write to it | The only supported direction. Injecting into a live session would need the undocumented peer-messaging protocol, which would break on updates. |
| Z-order vs the chat panel | Re-raise overlays when the panel is focused | Windows collapses every `alwaysOnTop` level into one topmost band, so activation order decides. Click-through means the panel underneath stays usable. |

## The built-in chat panel

A translucent panel (bottom-right, draggable) lets you talk to the agent without leaving your
screen. It runs Claude through the Claude Agent SDK, wired to this same MCP server.

**The SDK is an optional dependency and is not shipped in the packaged app.** It is proprietary
("(c) Anthropic PBC. All rights reserved"), so bundling it would put the download under Anthropic's
terms instead of this project's Apache-2.0 licence, for a feature that is a convenience rather than
the product. A source build installs it from npm and the panel works; a release build does not have
it and [sdk.ts](../src/main/agent/sdk.ts) turns the load failure into an explanation rather than a
module-resolution error. Nothing else depends on it — the MCP server, the tools and every agent that
connects over HTTP behave identically.

The panel never handles credentials. It has no API-key, OAuth or login code at all; the SDK resolves
authentication from the user's own Claude Code installation on their own machine, so usage bills to
them and this project never sees, stores or proxies a credential.

It is deliberately restricted: it may use the overlay tools plus `Read`, `Glob` and `Grep`.
`Bash`, `Write`, `Edit` and everything else are refused by `canUseTool` in
[src/main/agent/claude.ts](../src/main/agent/claude.ts). The panel is for guiding you around your
screen, not for editing your machine.

The overlay half of that allow-list is `TOOL_NAMES` from [tools.ts](../src/main/mcp/tools.ts), not a
copy. The copy it replaced had drifted: it named `list_displays`, which no longer existed, and left out
nine tools that did, so the panel was refused `describe_window` and every other cheap way to read the
screen — while its system prompt told it to start every task with a screenshot. The panel's prompt now
carries only what is specific to the panel and defers to the MCP server's instructions for the rest, so
there is one place that describes how to use the tools.

## Following a session from your editor

Click **Follow** in the panel header and pick a Claude Code conversation you already have open in
VS Code. The panel lists every folder currently open in an editor (read from the lock files in
`~/.claude/ide`, filtered to live processes) with its recent sessions.

The panel then becomes a **live, read-only view** of that conversation. Everything you send and
everything the agent replies shows up as it happens, tool calls included. Type in your editor; the
overlay follows along, and the agent can still draw on your screen because that session already has
this server's MCP tools. Press **Stop following** to turn the panel back into its own conversation.

Implemented by reading the transcript with the SDK's session APIs and then tailing the JSONL at
`~/.claude/projects/<slug>/<sessionId>.jsonl` (polled via `watchFile`, which is more reliable than
filesystem events for a file another process is appending to on Windows).

### Why it is one-way

Sending *from* the panel into a running editor session has no supported path. Everything was checked:

| Avenue | Result |
|---|---|
| `claude-vscode.*` commands | 26 of them, none sends a prompt — and VS Code commands cannot be invoked from an external process anyway |
| URI handler (`vscode://…`) | The extension registers none |
| IDE socket on `~/.claude/ide/<port>.lock` | An MCP server, but its 12 tools are editor context only (`openFile`, `getCurrentSelection`, `getDiagnostics`, …) |
| `claude` CLI | No subcommand messages a running interactive session |
| Peer messaging pipe | Every session registers `messagingSocketPath: \.\pipe\LOCAL\cc-msg-<hash>` plus a `peerToken`. This *is* the channel Claude Code uses between sessions — but the protocol lives in the compiled CLI, and reverse-engineering it would make the feature break silently on any update |

Resuming the same session id from the overlay does not work either: the extension holds its
conversation in memory and never re-reads the transcript, and two writers on one JSONL risks
corrupting it.

**Other agents:** implement [`AgentProvider`](../src/main/agent/types.ts) (four methods) and register it
in [host.ts](../src/main/agent/host.ts). Note that you do not need this to use a different agent — any
MCP-capable agent already drives the overlay from outside over HTTP. The interface exists only for
typing into the panel directly.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SCREEN_OVERLAY_PORT` | `7777` | MCP server port |
| `SCREEN_OVERLAY_MODEL` | `claude-opus-5` | Model for the built-in panel |
| `SCREEN_OVERLAY_CWD` | your home dir | Working directory for the panel's agent |
| `SCREEN_OVERLAY_SHOW_IN_CAPTURE` | unset | Set to `1` to make annotations visible in screen recordings and shares |

Preferences set from the tray menu (start at login, capture visibility) persist in
`%APPDATA%\screen-mcp-overlay\settings.json`. An env var always wins for that run.

---

## Packaging notes

`npm run dist` sets **`win.signAndEditExecutable: false`**, and that is load-bearing rather than
cosmetic. electron-builder otherwise downloads its `winCodeSign` bundle to sign and rcedit the
executable. That archive contains macOS symlinks (`libcrypto.dylib`, `libssl.dylib`), and extracting
a symlink on Windows needs `SeCreateSymbolicLinkPrivilege` — Developer Mode or an elevated shell. On
a stock machine the extraction fails, retries four times, and the build dies:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
```

Turning the option off skips signing (there is no certificate anyway) and skips rcedit — so
[scripts/after-pack.cjs](../scripts/after-pack.cjs) runs rcedit itself, before the installer and
portable targets wrap the app up. The result builds cleanly as a normal user, with a proper icon and
version strings. Re-enable the option if you ever add real code signing.

The app icon is generated from code by [scripts/make-icon.mjs](../scripts/make-icon.mjs) — shapes are
rasterised from signed distance fields, PNG-encoded by hand and packed into a multi-resolution `.ico`
with no image dependencies, so it is reviewable in a diff rather than an opaque binary.

## Development

```bash
npm run dev            # esbuild watch
npm run typecheck
npm start              # build + launch
npm run icon           # regenerate build/icon.ico
npm run build:native   # cargo build the UI Automation helper (needs Rust)
npm run dist           # installer + portable exe
npm run dist:dir       # unpacked app only, for quick checks

node scripts/smoke.mjs         # end-to-end MCP client test against a running overlay
npm test                       # 71 tests: geometry, tree keys and diffing, window matching, and every
                               # MCP tool end to end against a fake helper (runs on any OS)
node scripts/anchor-check.mjs  # anchors a box to a window, moves it, checks the box follows
node scripts/describe-check.mjs # describe_window vs screenshot cost, selector anchors
node scripts/wait-check.mjs    # wait_for_element against a real app opening and closing
node scripts/delta-check.mjs   # describe_window deltas, including the degradation paths
node scripts/window-capture-check.mjs  # window capture vs full screen, AutomationId coverage
node scripts/occlusion-check.mjs      # covers a window, proves the render still shows the right one
node scripts/visual-check.mjs  # draw calibration markers, then re-capture to eyeball placement
                               # (run the overlay with SCREEN_OVERLAY_SHOW_IN_CAPTURE=1)
```

> **`npm start` exists to strip `ELECTRON_RUN_AS_NODE`.** VS Code sets that variable for child
> processes, and a terminal opened inside VS Code inherits it. If it leaks through, Electron boots as
> plain Node, `require('electron')` returns a path string, and the app dies on
> `app.requestSingleInstanceLock is not a function`. Launch via `npm start` or
> `node scripts/start.mjs`, not bare `electron .`.

### Layout

```
native/
  uia-helper/  Rust: window enumeration + UI Automation queries (JSON lines over stdio)
src/
  shared/      types, coordinate conversion, UI-tree keys and diffing, window matching (pure, tested)
  main/        Electron main: displays, capture, overlay windows, store, clicks
               uia.ts (helper client) + anchors.ts (the tracking loop)
    mcp/       HTTP MCP server + tool definitions
    agent/     provider interface + Claude Agent SDK provider + chat host
  preload/     context-isolated IPC bridges
  renderer/
    overlay/   canvas that draws the annotations
    hud/       chat panel
test/
  support/     Electron stub + harness that bundles the real MCP server for Node
```

`npm test` runs on any OS. The tool tests drive the real server and every handler; only the helper
process is replaced, through `useHelperTransport` in [uia.ts](../src/main/uia.ts), by canned responses.
The Rust helper's own tests (`cargo test`) need Windows; elsewhere,
`cargo check --tests --target x86_64-pc-windows-gnu` at least compiles them.

---

## Prior art

The survey that shaped this design is in [docs/RESEARCH.md](RESEARCH.md). Short version: no
open-source project combined a live Windows desktop overlay, MCP-driven drawing, agent-initiated
capture and human-in-the-loop pointing.
[overlay-companion-mcp](https://github.com/RyansOpenSourceRice/overlay-companion-mcp) is the closest
but renders into a browser VNC session of a remote desktop and is unfinished;
[mcp-screenshot-server](https://github.com/aamar-shahzad/mcp-screenshot-server) (MIT) has an
excellent annotation vocabulary that informed the `annotate` schema, but draws into saved PNG files
rather than onto the live screen; [markeron](https://github.com/ifer47/markeron) (MIT) is the best
reference for the live drawing layer but has no API surface.

## Performance

Two things were burning CPU for no benefit, and neither was where it looked:

| | Before | After |
|---|---|---|
| Idle, nothing drawn | 5.2% of a core | **1.7%** |
| Tracking one anchor | 12.8% of a core | **1.6%** |

The overlay renderer ran `requestAnimationFrame` unconditionally, repainting a blank canvas at the
display refresh rate forever; it now only loops while something is actually animating. The anchor
tracker polled at a fixed 120 ms whether or not anything moved; it now backs off to 600 ms after
eight quiet ticks and snaps straight back on any change, so drag latency stays imperceptible.

The helper's element cache was the third, slower leak. Every ref it hands out keeps a COM reference to
the element alive, which pins memory in the *target application's* accessibility provider as well as
in the helper, and nothing was ever evicted: a describe adds up to a thousand, and a fifteen-minute
`wait_for_element` adds a few on every poll. It is now capped at 5,000 with least-recently-used eviction.
The anchor tracker re-reads its refs on every tick, which counts as use, so a ref with a drawing on it is
never the one evicted.

Worth naming because the obvious fix was the wrong one: UIA event subscriptions
(`AddAutomationEventHandler`) were the planned answer, and would have meant COM apartment threading
in the helper. Measuring first showed the helper's own CPU was **unmeasurable — 0.00s over 10
seconds** even while tracking. All of the cost was in the renderer and the scheduler, both fixable
without touching COM.

## Status

v0.1. Working and verified end to end on Windows 11. Not yet done:

- **Signing** — the installer and portable exe are unsigned, so SmartScreen will warn on first run
  ("More info" -> "Run anyway"). This needs a purchased code-signing certificate; there is no code
  change that fixes it.
- **Auto-update** — electron-updater needs a release feed to point at. Worth adding alongside a
  publish target, inert without one.
- **Record by demonstration** — perform the flow once and have the overlay record selectors from UIA
  events. The most valuable thing left, and a genuinely new surface: event subscriptions, a recording
  session model, an editor for the captured steps, and a persisted format. Deliberately not started
  rather than half-built.
- **Size** — 190 MB, almost all Electron. Tauri would be ~10 MB but is a full rewrite of the overlay,
  the panel and the IPC; not worth it for the download size alone.
- **macOS / Linux** — the architecture is cross-platform and Electron handles most of it, but
  `WDA_EXCLUDEFROMCAPTURE` is Windows-only. macOS `setContentProtection` maps to
  `NSWindowSharingNone`; Linux has no equivalent and would need hide-then-capture.
- **Wider test coverage** — `npm test` covers the pure modules where the subtle bugs live and the whole
  MCP tool layer against a fake helper, including a budget on the size of the tool list. The scripts
  in `scripts/` are still manual, and the Rust helper's tests cover only its control-type table.
- **Qt/QML coverage is unverified.** The diagnosis distinguishes "no provider" from "frame only", but
  no Qt application has actually been tested against it. Worth checking before relying on a
  tree-driven walkthrough of one, rather than discovering it mid-walkthrough.
- **Port conflicts** — if a foreign process holds 7777 you get a panel message and nothing works.
  Falling back to an ephemeral port and rewriting the registered config would be better.
- **Cross-run anchors** — `{window, name}` selectors now survive a helper restart, but element refs
  still die with the app. Stable `AutomationId`s on your own controls would make selectors exact
  rather than fuzzy name matches, and immune to localisation and label edits. Persisting a *selector*
  (window title + control name + role) and re-resolving it on a later run would let a saved
  walkthrough survive an application restart.
