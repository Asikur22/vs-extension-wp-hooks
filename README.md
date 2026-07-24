# WP Hooks

Navigate WordPress **actions** and **filters** in VS Code and Cursor — jump between `do_action` / `apply_filters` and `add_action` / `add_filter`, hover for docs and occurrences, autocomplete hook names, and search hooks with **Cmd/Ctrl+T**.

## Install

### From a VSIX file

1. Open the Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`).
2. Open the `…` menu → **Install from VSIX…**.
3. Select the `.vsix` file and reload if prompted.

Or from a terminal:

```bash
code --install-extension path/to/wp-hooks-x.y.z.vsix
# Cursor:
cursor --install-extension path/to/wp-hooks-x.y.z.vsix
```

### Requirements

- VS Code or Cursor **1.85+**
- A workspace with PHP files (the extension activates for PHP and after startup)

## Quick start

1. Open a WordPress theme, plugin, or full site folder.
2. Wait for the status bar: `WP Hooks: Scanning…` → `WP Hooks: N hooks`.
3. Put the cursor on a **hook name** string inside a hook API call.
4. Press **F12** (Go to Definition), hover for details, or use **Cmd/Ctrl+T** to find hooks by name.

## Features

### Workspace hook index

On open, WP Hooks scans PHP files in the workspace and shows the **number of unique hooks** in the status bar (for example `WP Hooks: 12,345`).

- Progress appears as `Scanning…` while indexing.
- Click the status bar item (or run **WP Hooks: Rescan Workspace**) to rebuild after large changes.
- When a PHP file is saved or deleted, only that file is reindexed.

`vendor/` and `node_modules/` are always skipped.

### Go to Definition

**F12** or **Cmd/Ctrl+Click** on a hook name:

| From | To |
|------|-----|
| `add_action` / `add_filter` | `do_action` / `apply_filters` |
| `do_action` / `apply_filters` | Matching `add_*` and related APIs |

Also works with:

- `remove_action` / `remove_filter`
- `has_action` / `has_filter`
- `doing_action` / `doing_filter`
- `did_action` / `did_filter`
- Variants such as `do_action_ref_array`, `apply_filters_deprecated`, and similar

Commented-out code is ignored. Slash-style names (for example Elementor `elementor/...`) are supported.

### Hover

Hover a hook name to see:

- **Type** — WordPress Core Hook, Theme Hook, Plugin Hook, or Custom Hook (from where it is defined)
- **Kind** — Action or Filter, and how this call is used (definition, registration, …)
- **Short description** and **@since** version when a PHPDoc block sits above the definition
- **Docs link** — `View on developer.wordpress.org →` for WordPress core hooks
- Workspace occurrences with clickable `file:line` links and a short code snippet

### Callback navigation

From the callback argument of `add_*` / `remove_*`, jump to the function or method:

- Plain and namespaced functions
- `Class::method` and `['Class', 'method']` (including FQCN with `\`)
- `[$this, 'method']` and `[$obj, 'method']`
- PHP 8.1 first-class callables: `MyClass::method(...)`, `$this->method(...)`
- Closures and arrow functions (jumps to the `function` / `fn` site)

Use **F12** on the callback, or right-click → **WP Hooks: Go to Callback Function**.

### Autocomplete

Inside the first string argument of supported hook APIs, get suggestions for hook names found in the workspace (and optional external paths).

### Workspace symbols

**Cmd+T** / **Ctrl+T** → type a hook name (for example `wp_head`) → jump to it. Definition sites are preferred when available.

## Commands

| Command | Description |
|---------|-------------|
| **WP Hooks: Go to Hook Definition** | Jump between definition and registration |
| **WP Hooks: Go to Callback Function** | Jump to the callback of `add_*` / `remove_*` |
| **WP Hooks: Rescan Workspace** | Rebuild the full hook index and refresh the status-bar count |

The first two also appear in the editor context menu on PHP files. Rescan is available from the status bar click as well.

## Settings

### `wpHooks.externalPaths`

Folders **outside** your open workspace that WP Hooks should also scan for hooks.

**When you need it:** you open only a plugin or theme folder, but WordPress core (or another plugin) lives somewhere else on disk. Without this, Go to Definition / hover won’t find core hooks like `init` or `wp_head`.

**When you can skip it:** you already opened a full site root that includes `wp-includes`, `wp-admin`, themes, and plugins.

Example `settings.json`:

```json
{
  "wpHooks.externalPaths": [
    "/path/to/wordpress/wp-includes",
    "/path/to/wordpress/wp-admin"
  ]
}
```

Those paths are included in the workspace index, autocomplete, and live search. Official WordPress docs links also apply when a hook is defined under a core-like path in these folders.

`vendor/` and `node_modules/` inside the workspace are always skipped.

## Tips

- Place the cursor on the **hook name** string (not only on the function name) for Go to Definition and hover.
- After pulling large updates or switching branches, use **WP Hooks: Rescan Workspace** if the count looks stale.
- For a full site checkout (theme + plugins + core), open the site root so one index covers everything.

## Limitations

- Dynamic hook names (built with `$variables`) cannot always be resolved exactly; a warning may appear.
- Parsing is regex-based; unusual formatting can miss some call sites.
- Multi-line calls are supported within a limited window.
- Resolving `$obj` callbacks is best-effort (type hints / `new Class` in the same file when possible).
- **DEVSENSE PHP** (and similar tools like Intelephense) also provide hover and Go to Definition — VS Code merges them with WP Hooks, so Cmd/Ctrl+Click or hover may show extra/conflicting results. Use **F12** on the hook name or the hover **Go to Hook Definition** link for WP Hooks-only navigation.

## Author

**Asiqur Rahman** — [asiq.webdev@gmail.com](mailto:asiq.webdev@gmail.com)

## License

[GPL-2.0-only](LICENSE) — GNU General Public License v2.0.

## Links

- Source: [github.com/Asikur22/vs-extension-wp-hooks](https://github.com/Asikur22/vs-extension-wp-hooks)
