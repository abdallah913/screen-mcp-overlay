# Screen MCP Overlay

A desktop overlay that lets Claude Code — or any MCP client — **see your screen and draw on it**.

Ask *"how do I export this?"* and the agent looks at your screen, then circles the button and
numbers the steps directly on your real desktop. The overlay is click-through, so you keep working
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

Just ask, in whatever agent you connected:

- *"Look at my screen and circle what's wrong."*
- *"Walk me through exporting this as a PNG — highlight each button before I click it."*
- *"I'm lost in these settings. Point at the one that controls autosave."*

The agent draws on your screen and waits for you between steps.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+O` | Show / hide the chat panel |
| `Ctrl+Shift+X` | Clear everything drawn on screen |
| `Escape` | Cancel a pending click request |

There's also a **built-in chat panel** (bottom-right, draggable) if you'd rather not switch to a
terminal, which can **follow** a Claude Code conversation you already have open in VS Code so you see
it live on your screen. The panel needs the Claude Agent SDK, which is not bundled with the
installer — run the app from source to use it (see *Or build it yourself* above). Everything else
works the same either way.

---

## The tools

| Tool | What it does |
|---|---|
| `list_windows` | Windows and monitors: refs, titles, rects. The starting point |
| `describe_window` | A window's controls as a text tree. ~3.6x cheaper than a screenshot |
| `capture_screen` | Screenshot to disk. Renders a single window correctly even when covered |
| `annotate` | Draw `box`, `highlight`, `circle`, `arrow`, `label`, `step`, `spotlight` |
| `clear_annotations` | Remove some or all drawings |
| `wait_for_user_click` | Ask the user to point at something, get the coordinates back |
| `wait_for_element` | Block until a control appears, disappears or becomes enabled |
| `find_ui_elements` | Search a window's tree by name, role or AutomationId |
| `read_text` | OCR a window or region, with per-line rectangles |
| `speak` | Say a line out loud, for hands-free guidance |
| `focus_window` | Bring a window to the front. Does not click or type |
| `scroll_window` | Scroll a window to reveal content |
| `highlight_and_wait` | Point at a control and wait for the user to click it, in one call |
| `show_message` | Post a line into the overlay panel |

Drawings can be **anchored** to a window or a control, so they follow their target when it moves.

## Documentation

- **[docs/DESIGN.md](docs/DESIGN.md)** — how it works and why: the coordinate contract, anchored
  annotations, token costs, configuration, packaging and development.
- **[docs/RESEARCH.md](docs/RESEARCH.md)** — the prior-art survey that shaped the design.
- **[Known limitations](docs/DESIGN.md#status)** — what isn't done yet.

## Privacy

Everything stays on your machine.

- Screenshots are written to a temporary folder and deleted when the app exits. They are never
  uploaded anywhere.
- There is **no telemetry**, no analytics and no crash reporting.
- The MCP server listens on loopback only (`127.0.0.1`) and requires an access token. It sends no CORS
  headers, refuses any request carrying an `Origin`, and enables DNS-rebinding protection — so a web
  page you happen to be visiting cannot reach it and read your screen.
- Every capture posts a line into the overlay panel. A screen read is never silent.
- The overlay does not control your mouse or keyboard. It can bring a window to the front and scroll
  one, and that is the extent of it.

The agent you connect, of course, sends what it captures to whatever service that agent uses. That
part is between you and your agent.

## License

[Apache-2.0](LICENSE). Third-party components and their licences are listed in [NOTICE](NOTICE).

The built-in chat panel uses your own local Claude Code installation and your own credentials — this
project never sees, stores or proxies them, and the proprietary Claude Agent SDK is not distributed
with the installer.

Claude and Claude Code are trademarks of Anthropic PBC. This project is not affiliated with, endorsed
by, or sponsored by Anthropic.
