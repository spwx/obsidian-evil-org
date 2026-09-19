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
| `u` | Undoing a delete brings back folded headings still folded. |
| `p` / `P` | Put a yanked subtree after or before a folded heading, not inside it. Pasted subtrees arrive folded (org `org-yank-folded-subtrees`). |
| `>>` / `<<` | On a heading, demote/promote by adding/removing a `#` instead of indenting. Folded, the whole subtree shifts (org `M-S-→`). Open, only the heading shifts (org `M-→`). Levels stay between 1 and 6. Body lines are left alone. |
| `3>>`, `V>`, `.` | Every heading in the range shifts. Repeatable and undoable in one step. |
| `Alt-j` / `Alt-k` | On a heading, swap its subtree with the next or previous sibling (org `M-↓`/`M-↑`). It won't cross the parent's boundary. Blank lines between subtrees stay put, and folded subtrees stay folded. A count moves past that many siblings; `.` repeats and `u` undoes in one step. On other lines, move the line, stepping over a folded heading as one line. On macOS, Alt is Option. |
| `ar` / `ir` | Subtree text objects (evil-org `ar`/`ir`), folded or not. `ar` is the subtree the cursor is in plus trailing blank lines; `ir` is its body, without the heading or surrounding blank lines. Use them with any operator (`dar`, `yar`, `cir`, `>ar`) or in visual mode. A count (`d2ar`), or `ar` again in visual mode, takes in the parent subtree. |

On lines that aren't headings, `>` and `<` indent as usual.

Alt-j and Alt-k never reach Obsidian if another app claims them system-wide. Window managers like AeroSpace bind them by default. Either free them in that app, or bind the move commands below to other keys.

## Commands

- **Cycle fold under cursor (org TAB)**
- **Cycle global fold overview (org S-TAB)**
- **Move subtree down (org M-↓)**
- **Move subtree up (org M-↑)**

None of these has a default hotkey. The move commands also work without Vim mode. The `Tab`/`Shift-Tab` bindings above come from an editor keymap that is only active in Vim normal mode.

## Installation

From Obsidian: **Settings → Community plugins → Browse**, search for "Evil Org".

Manually: download `main.js` and `manifest.json` from the [latest release](https://github.com/spwx/obsidian-evil-org/releases/latest) into `<vault>/.obsidian/plugins/evil-org/`, then enable the plugin under **Settings → Community plugins**.

## How it works, and a caveat

Obsidian has no public API for its Vim mode, so the plugin changes the Vim engine that Obsidian exposes at `window.CodeMirrorAdapter.Vim`. It redefines the `expandToLine` motion so it is fold-aware, and it maps `p`, `P`, `d`, `>`, `<`, `<A-j>`, `<A-k>`, `ar` and `ir` (plus `x`, `X` and `D` in visual mode). Obsidian's Vim reads Option-j on macOS as plain `j`, so the plugin also catches Alt-j/Alt-k key presses in Vim normal mode before the editor does. It also reads the CodeMirror 6 view through `editor.cm`. None of this is documented, so an Obsidian update could break the plugin. Unloading the plugin restores stock Vim behaviour.

## Development

`main.js` is the source; `npm run build` only syntax-checks it, so the released file is byte-for-byte the one in the repo. The end-to-end tests run it against a real CodeMirror 6 editor with [codemirror-vim](https://github.com/replit/codemirror-vim) in jsdom:

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
