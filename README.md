# pi-cometix-footer

A single-line, [CCometixLine](https://github.com/Haleclipse/CCometixLine) "cometix"-style footer for [pi](https://pi.dev).

```
  π  GLM-5.2 • xhigh   |    ~/path   |    master ✓   |    4% 13k/272k   |    ↑26k ↓2.1k CH96.8%
```

Segments (left to right, ` | ` separators, bold colored, Nerd Font icons):

| Segment | Source | Color |
|---|---|---|
| Model `• thinking` | `ctx.model.name` + `pi.getThinkingLevel()` (pi thinking palette) | cyan (+ level color) |
| Directory | `ctx.sessionManager.getCwd()` (`~`-relative) | yellow icon / green text |
| Git `branch ✓/●/⚠ ↑n/↓n` | `footerData.getGitBranch()` + `git status -b --porcelain=v1` | blue |
| Context `pct tokens/window` | `ctx.getContextUsage()` | magenta (>70 yellow, >90 red) |
| Tokens `↑in ↓out CH%` | cumulative `usage` across session; cache hit rate from last assistant msg | cyan |

> Looks are borrowed from CCometixLine (MIT, Haleclipse). This package is an independent pi extension; code is its own.

## Install

From a local path:

```bash
pi install ./cometix-footer
```

From git (push this folder to a repo first):

```bash
pi install git:github.com/<you>/pi-cometix-footer
```

From npm (publish first):

```bash
pi install npm:pi-cometix-footer
```

Then `/reload` in pi. Toggle on/off with the `/cometix-footer` command.

> If you previously kept the loose file at `~/.pi/agent/extensions/cometix-footer.ts`, remove it before installing the package to avoid double-loading.

## Customize

Edit `extensions/cometix-footer.ts`, then `/reload`. Notable knobs at the top:

- `ICON_MODE: "nerd" | "emoji"` — switch icon set if your terminal has no Nerd Font.
- `ICONS.nerd.*` — per-segment Nerd Font codepoints (see <https://www.nerdfonts.com/cheat-sheet>).
- `C.*` — 16-color SGR codes per segment.
- `GIT_TTL` — git status refresh interval (ms).

## Requirements

- pi (provides `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` at runtime; listed as peerDependencies).
- A Nerd Font in your terminal for icons (or set `ICON_MODE = "emoji"`).
