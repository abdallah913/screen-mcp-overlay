# Screen MCP Overlay

A desktop overlay that lets Claude Code — or any MCP client — **see the windows you share and draw on
your screen**.

Ask *"how do I export this?"* and the agent looks at the window you shared, then circles the button and
numbers the steps directly on your real desktop. **Nothing is visible to the agent until you share it**:
a window you have not shared does not exist as far as it can tell. The overlay is click-through, so you keep working
underneath it, and it hides itself from screen capture, so its own drawings never end up in the next
screenshot.

**It does not control your mouse or keyboard.** It sees and it points; you stay in control.

```
   Claude Code CLI ─┐
VS Code extension ──┼─── http://127.0.0.1:7777/mcp ───► OVERLAY APP ───► your screen
    Cursor / Codex ─┤                                    (Electron)
    built-in panel ─┘
```

Windows 10 (2004+) or Windows 11.

---

## 1. Install

### [⬇ Download the latest release](https://github.com/abdallah913/screen-mcp-overlay/releases/latest)

Grab one of the two files on that page — no build tools, no Node, nothing to set up:

| File | Use |
|---|---|
| `ScreenMcpOverlay-Setup-<version>.exe` | **Recommended.** Installer, with Start-menu and desktop shortcuts |
| `ScreenMcpOverlay-Portable-<version>.exe` | One self-contained file. Run it from anywhere, installs nothing |

Run it and the app appears in your **system tray**. Right-click the tray icon to start it
automatically at login.

> The build is unsigned, so Windows SmartScreen warns on first run — click **More info → Run anyway**.

**Updating:** there's no auto-updater yet, so check the
[releases page](https://github.com/abdallah913/screen-mcp-overlay/releases) now and then. Download
the new installer and run it over the top; your settings and MCP token are kept.

<details>
<summary>Or build it yourself</summary>

Needs [Node 20+](https://nodejs.org) and [Rust](https://rustup.rs) (for the UI Automation helper).

```bash
npm install
npm run dist     # writes the installer and portable exe to release/
```

Or run from source without packaging:

```bash
npm install
npm start
```

</details>

## 2. Connect it to an agent

The overlay always serves MCP at **`http://127.0.0.1:7777/mcp`**, wherever you launched it from.

It reads your screen, so the endpoint needs an access token. Right-click the tray icon and choose
**Copy MCP URL** to get the full URL with the token in it.

### Claude Code — CLI

```bash
claude mcp add --transport http screen-overlay "PASTE_THE_URL_HERE" --scope user
```

### Claude Code — VS Code extension

From the project folder you want to use it in:

```bash
node scripts/connect.mjs .
```

That writes the config for both the CLI and the extension. Then **reload the VS Code window**
(`Ctrl+Shift+P` → *Developer: Reload Window*) and approve the server by adding this to
`~/.claude/settings.json`:

```json
{ "enabledMcpjsonServers": ["screen-overlay"] }
```

### Cursor, Codex, or anything else that speaks MCP

Add it as a **streamable HTTP** server and paste the same URL. Connecting several agents at once is
fine — they all drive the same screen.

<details>
<summary>If it doesn't show up</summary>

- **`/mcp` says nothing is configured** — reload the editor window. The extension only reads its MCP
  registry at startup.
- **`claude: not recognized`** — if you only installed the VS Code extension there is no `claude` on
  your PATH. Add the bundled copy for this session:

  ```powershell
  $ext = Get-ChildItem "$env:USERPROFILE\.vscode\extensions" -Filter 'anthropic.claude-code-*' |
         Sort-Object Name | Select-Object -Last 1
  $env:Path += ";$($ext.FullName)\resources\native-binary"
  ```

- **Port 7777 is taken** — set `SCREEN_OVERLAY_PORT` before launching, and use the new port in the URL.

</details>

> **The URL contains a credential.** Don't commit `.mcp.json` to a public repo — this project's
> `.gitignore` excludes it for that reason.

## 3. Use it

First, share the window you want help with: **click into it and press `Ctrl+Shift+F8`**, then confirm
the window it names. Press it again in that window to stop. Or just ask, and the agent asks you to share one (see
[Privacy](#privacy)).

Then ask, in whatever agent you connected:

- *"Look at my screen and circle what's wrong."*
- *"Walk me through exporting this as a PNG — highlight each button before I click it."*
- *"I'm lost in these settings. Point at the one that controls autosave."*

The agent draws on your screen and waits for you between steps. You keep using your apps normally: the
circle shows where to click, and the agent notices when you've done it.

While a step is waiting for you, a small **step strip** on screen (and a card in the chat panel) shows
the instruction, how far along you are ("2 of 5") and three buttons, so you can answer the agent even
when it's running in a terminal you aren't looking at:

- **Done**: you did it. The agent checks, and moves on.
- **Can't find it**: the agent shows you where it is, or explains another way.
- **Skip**: move on without this step.

You can also type a reply in the panel while a step is waiting; it goes straight to the agent.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+F8` | Share the window you are in with the AI, or stop sharing it |
| `Ctrl+Shift+O` | Show / hide the chat panel |
| `Ctrl+Shift+X` | Clear everything drawn on screen and stop the current step |
| `Ctrl+Shift+F9` | Done (only while the agent is waiting for you to do a step) |
| `Ctrl+Shift+F10` | Can't find it (same) |
| `Escape` | Cancel, while the agent has asked you to click somewhere |

The step keys are registered only while a step is waiting, so they never take those keys from your other
apps, and can be changed or turned off (`""` or `null`) in
`%APPDATA%\screen-mcp-overlay\settings.json` (`stepKeys`). The share key is held while the app runs;
change or turn it off there too (`shareKey`). The panel's card also has **Show me**, which
points at the target again. The tray menu has **Read steps aloud** and **Sound cues**.

There's also a **built-in chat panel** (bottom-right, draggable) if you'd rather not switch to a
terminal, which can **follow** a Claude Code conversation you already have open in VS Code so you see
it live on your screen. The panel needs the Claude Agent SDK, which is not bundled with the
installer — run the app from source to use it (see *Or build it yourself* above). Everything else
works the same either way.

---

## The tools

| Tool | What it does |
|---|---|
| `list_windows` | The windows you shared, and monitors: refs, titles, rects. `ask` asks you to share one |
| `describe_window` | A window's controls as a text tree. ~3.6x cheaper than a screenshot |
| `find_ui_elements` | Search a window's tree by name, role or AutomationId |
| `read_text` | OCR a window or region, with per-line rectangles |
| `capture_screen` | Screenshot to disk. Renders a single window correctly even when covered |
| `annotate` | Draw `box`, `highlight`, `circle`, `arrow`, `label`, `step`, `spotlight` |
| `clear_annotations` | Remove some or all drawings |
| `highlight_and_wait` | One walkthrough step: circle a control, wait until the user has done it. Takes a whole plan too |
| `wait_for_element` | Block until a control appears, disappears or becomes enabled |
| `wait_for_user_click` | Ask the user to point at something, get the coordinates back |
| `focus_window` | Bring a window to the front. Does not click or type |
| `scroll_window` | Scroll a window, or bring a named control into view |
| `show_message` | Tell the user something, say it out loud, or ask a multiple-choice question |

Any `window` argument takes a ref, a **title substring** (`"Notepad"`) or `"foreground"` (the
frontmost shared window), matched against the windows you shared only, so an agent rarely needs
`list_windows` first. Drawings can be **anchored** to a window or a control
(`anchor: {window: "Notepad", name: "Save"}`), so they follow their target when it moves.

## Documentation

- **[docs/DESIGN.md](docs/DESIGN.md)** — how it works and why: the coordinate contract, anchored
  annotations, token costs, configuration, packaging and development.
- **[docs/RESEARCH.md](docs/RESEARCH.md)** — the prior-art survey that shaped the design.
- **[Known limitations](docs/DESIGN.md#status)** — what isn't done yet.

## Privacy

**Nothing on your screen is visible to an agent until you share it.** A window you have not shared
does not exist as far as any connected agent can tell: no title, no app name, no pixels, no text, no
controls, not even whether it is open. Asking for one gets exactly the answer a window that is not
open gets. Someone getting help in a spreadsheet while a video plays on the side does not have the
video reach the AI.

**How to share:**

- **The share key.** Click into a window and press `Ctrl+Shift+F8`. A dialog names the window and its
  app and asks you to confirm (*Don't share* is the default). Press the key again there to stop.
- **The agent asks.** When it needs a window you have not shared, the overlay (not the agent) asks you
  to click into it and press Done, then to confirm. The agent never names the window, so it cannot
  find out what is open by asking.
- **The tray menu.** *Shared with the AI* lists everything shared. Click an item to stop sharing it, or
  *Stop sharing everything*.

A shared window brings the windows it owns: its menus, its dialogs and the file picker it opens. It does
not bring the app's other windows. For most apps the overlay can share **all of the app's windows**
at once, and remembers that across restarts; it never offers that for browsers, Explorer and other
programs whose windows are unrelated things, so a second browser window stays private.

What to know:

- **Screenshots show shared windows only.** A screenshot is built from each shared window's own
  picture on a blank background, so nothing of any other window (its pixels, its outline, its shadow),
  the desktop, the taskbar or a notification is ever in it, and no text is read from them. Nothing is
  ever copied from the screen: a shared window that cannot draw its own picture (some games and video
  players) is left blank, and the agent is told so.
- **Nothing about other windows leaks through the wording either.** An agent is not told which window
  you are working in, whether something you have not shared covers what it pointed at, or that a window
  you stopped sharing has closed. A tool call during which you stop sharing something returns nothing
  it read.
- **The overlay's own questions carry its badge.** Asking you to share a window is done by the overlay,
  marked as such; an agent's message that tries to look like one is labelled as the agent's. The
  overlay never reads its own questions aloud, so anything spoken is the agent's, and the panel marks
  every line about what the agent is doing with **AI**.
- **A shared browser window shows its tab strip**, so the titles of its other tabs are visible, and
  switching that window to another tab shows that tab. Sharing is per window, not per tab: put what
  you want private in a separate browser window.
- **Stopping a share is not retroactive.** What an agent already saw stays in its conversation (and
  in its saved transcript). The overlay deletes its screenshots when you stop sharing something, and
  the panel's **New** button starts its own conversation afresh.
- **Sharing governs this overlay only.** An agent with its own shell or file access (Claude Code's
  Bash, Codex) can still read your screen or list your windows outside this server. The built-in panel
  has no shell and may read only the screenshots this server took.
- Every request for a window you have not shared shows a line in the overlay panel, so it is never
  silent. Agents never see those lines.

Everything stays on your machine:

- Screenshots are written to a temporary folder, deleted when you stop sharing something and when the
  app exits. They are never uploaded by the overlay.
- There is **no telemetry**, no analytics and no crash reporting.
- The MCP server listens on loopback only (`127.0.0.1`) and requires an access token. It sends no CORS
  headers, refuses any request carrying an `Origin`, and enables DNS-rebinding protection — so a web
  page you happen to be visiting cannot reach it and read your screen.
- The overlay does not control your mouse or keyboard. It can bring a shared window to the front and
  scroll one, and that is the extent of it.

The agent you connect, of course, sends what it sees of your shared windows to whatever service that
agent uses. That part is between you and your agent.

## License

[Apache-2.0](LICENSE). Third-party components and their licences are listed in [NOTICE](NOTICE).

The built-in chat panel uses your own local Claude Code installation and your own credentials — this
project never sees, stores or proxies them, and the proprietary Claude Agent SDK is not distributed
with the installer.

Claude and Claude Code are trademarks of Anthropic PBC. This project is not affiliated with, endorsed
by, or sponsored by Anthropic.
