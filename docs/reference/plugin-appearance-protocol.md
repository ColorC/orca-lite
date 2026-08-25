# Plugin Appearance Protocol

Appearance plugins change presentation without changing Orca behavior, labels, command routing, permissions, DOM structure, or interaction semantics. The host parses every artifact and applies only public semantic slots; plugins cannot inject CSS, selectors, HTML, or scripts.

## Manifest contributions

```json
{
  "contributes": {
    "themes": [{ "id": "square", "label": "Square", "path": "themes/square.json" }],
    "iconThemes": [{ "id": "minimal", "label": "Minimal", "path": "icons/theme.json" }],
    "terminalThemes": [{ "id": "console", "label": "Console", "path": "terminal/console.json" }]
  }
}
```

Contribution IDs are plugin-local. The host exposes them as `plugin:<publisher>.<plugin>/<contribution>` and ignores contributions from disabled, unapproved, invalid, or revoked plugins.

## Application theme artifact

Schema version 1 is compatible with upstream Orca and accepts color tokens only. Schema version 2 adds region, geometry, component-state, shadow, and motion tokens.

```json
{
  "schemaVersion": 2,
  "base": "dark",
  "tokens": {
    "--background": "#101010",
    "--right-sidebar": "#181818",
    "--appearance-control-radius": "0px",
    "--appearance-shadow-control": "3px 3px 0 0 #000000",
    "--appearance-control-active-offset": "2px",
    "--appearance-state-selected": "#304050",
    "--appearance-state-selected-foreground": "#ffffff",
    "--motion-enter": "260ms",
    "--motion-ease-out": "cubic-bezier(0.2, 1.4, 0.4, 1)"
  }
}
```

The exact public allowlist is `PLUGIN_APP_THEME_TOKENS` in `src/shared/plugins/plugin-theme-artifact.ts`. It covers:

- semantic shadcn colors and editor/settings surfaces;
- left, worktree, and right sidebar surfaces, foregrounds, accents, borders, and focus rings;
- hover, selected, and current component background/foreground states;
- control, panel, overlay, and pill radius, plus border widths and shadows;
- bounded control hover/press offsets and base, hover, and active control shadows;
- fast/base/enter/exit/spinner durations, movement distance and scale, and easing curves.

If a plugin omits right-sidebar slots but supplies matching sidebar slots, the renderer uses those sidebar values as the right-sidebar fallback. Missing tokens otherwise retain host defaults. Selecting a plugin theme disables the imported custom-theme selection; uninstalling or disabling it falls back safely.

`--orca-security-*` is private. Marketplace provenance, installation, consent, and permission surfaces reset appearance values to host-owned defaults.

### Bundled Neo Brutalism pack

LiTeWork includes `stablyai.orca-neobrutalism-theme` as an enabled, declarative reference pack.
It adapts the MIT-licensed [NeoBrutalism](https://github.com/neobrutalism/neobrutalism)
palette, square geometry, hard shadows, and press interaction into schema version 2. The pack contributes
separate light and dark application themes plus matching terminal themes; it carries no executable entry
point or capabilities. Application themes are selected under Settings → Appearance → Appearance Plugin,
while terminal themes remain explicit in the terminal light/dark selectors so the pack never overwrites a
user's terminal preference implicitly.

## Icon theme artifact

```json
{
  "schemaVersion": 1,
  "icons": {
    "file": "file.svg",
    "folder": "folder.svg",
    "folder-open": "folder-open.svg",
    "sidebar.search": "search.svg"
  },
  "fileNames": { "readme.md": "readme.svg" },
  "fileExtensions": { "tsx": "react.svg" }
}
```

The host supports the bounded slots in `PLUGIN_ICON_THEME_SLOTS`. File-name matching wins over extension matching, then the `file` slot is used. SVG files are size-bounded, contained within the plugin directory, stripped of comments, and rejected if they contain active content, external references, event handlers, inline styles, or unsupported elements. Sanitized SVG is transported as data, never inserted as markup.

## Terminal theme artifact

```json
{
  "schemaVersion": 1,
  "mode": "dark",
  "terminal": {
    "background": "#101010",
    "foreground": "#f0f0f0",
    "black": "#000000",
    "red": "#ff5555"
  }
}
```

Only normalized xterm color slots are accepted. A terminal theme must include background, foreground, and at least one ANSI color. Plugin terminal themes join the built-in and imported catalogs and are selected independently for light and dark terminal modes.

## Runtime and compatibility

Desktop IPC and paired-host RPC expose the same read-only registries. Paired clients call additive `plugins.listThemes`, `plugins.listIconThemes`, `plugins.loadIconTheme`, and `plugins.listTerminalThemes` methods. Clients treat an unknown method from an older host as an empty registry, so mixed versions keep the built-in appearance.

Theme and icon selection values are optional settings fields. Unknown or malformed IDs normalize to empty selections. No appearance contribution changes workspace data or requires a git worktree, so folder workspaces and SSH-backed workspaces use the same renderer contract.
