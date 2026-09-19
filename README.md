# Evil Org

Org-mode headline editing for Obsidian's Vim mode, in the spirit of Emacs [evil-org-mode](https://github.com/Somelauw/evil-org-mode).

Markdown headings act like org headlines. Tab cycles folding the way it does in org, and a folded heading behaves like a single line, so Vim commands move, copy and promote/demote whole subtrees.

## Requirements

Turn on **Settings → Editor → Vim key bindings**. Every key below works only in Vim normal (or visual-line) mode. Insert mode and non-Vim editing are unaffected.

## Keys

| Key | Does |
| --- | --- |
| `Tab` | Cycle the heading under the cursor: folded → children → subtree (org `TAB`). On a folded non-heading block it toggles that fold. |
| `Shift-Tab` | Cycle the whole note: overview → contents → show all (org `S-TAB`). |
| `V` | Selecting a folded heading selects its whole subtree. |
| `dd`, `yy`, `cc`, `3dd`, … | A folded heading counts as one line, so these act on the whole subtree. |
| `p` / `P` | Put a yanked subtree after or before a folded heading, not inside it. Pasted subtrees arrive folded (org `org-yank-folded-subtrees`). |
| `>>` / `<<` | On a heading, demote/promote by adding/removing a `#` instead of indenting. Folded, the whole subtree shifts (org `M-S-→`). Open, only the heading shifts (org `M-→`). Levels stay between 1 and 6. Body lines are left alone. |
| `3>>`, `V>`, `.` | Every heading in the range shifts. Repeatable and undoable in one step. |

On lines that aren't headings, `>` and `<` indent as usual.

## Commands

- **Cycle fold under cursor (org TAB)**
- **Cycle global fold overview (org S-TAB)**

Neither has a default hotkey. The `Tab`/`Shift-Tab` bindings above come from an editor keymap that is only active in Vim normal mode.

## Installation

From Obsidian: **Settings → Community plugins → Browse**, search for "Evil Org".

Manually: download `main.js` and `manifest.json` from the [latest release](https://github.com/spwx/obsidian-evil-org/releases/latest) into `<vault>/.obsidian/plugins/evil-org/`, then enable the plugin under **Settings → Community plugins**.

## How it works, and a caveat

Obsidian has no public API for its Vim mode, so the plugin changes the Vim engine that Obsidian exposes at `window.CodeMirrorAdapter.Vim`. It redefines the `expandToLine` motion so it is fold-aware, and it maps `p`, `P`, `>` and `<`. It also reads the CodeMirror 6 view through `editor.cm`. Both are undocumented, so an Obsidian update could break the plugin. Unloading the plugin restores stock Vim behaviour.

## Development

`main.js` is the source; there is no build step. The end-to-end tests run it against a real CodeMirror 6 editor with [codemirror-vim](https://github.com/replit/codemirror-vim) in jsdom:

```sh
npm install
npm test
```

To release, bump `version` in `manifest.json`, commit, then push a tag with the same version (no `v`). The Release workflow runs the tests, attests `main.js` and `manifest.json`, and publishes the GitHub release.

```sh
git tag 1.0.1 && git push origin 1.0.1
```

## License

[MIT](LICENSE)
