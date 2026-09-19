# Evil Org

Org-mode headline editing for Obsidian's Vim mode, in the spirit of Emacs [evil-org-mode](https://github.com/Somelauw/evil-org-mode).

Markdown headings act like org headlines. Tab cycles folding the way it does in org, and a folded heading behaves like a single line, so Vim commands move, copy and promote/demote whole subtrees.

## Requirements

This is mostly a set of Vim keys, so turn on **Settings → Editor → Vim key bindings**. Every key in the table below works only in Vim normal or visual mode, and leaves insert mode and ordinary editing untouched. The four [commands](#commands) are the exception: they run in any mode, with or without Vim.

## Keys

| Key | Does |
| --- | --- |
| `Tab` | Cycle the heading under the cursor: folded → children → subtree (`TAB` in org-mode). On a folded non-heading block it toggles that fold. |
| `Shift-Tab` | Cycle the whole note: overview → contents → show all (`S-TAB` in org-mode). |
| `V` | Selecting a folded heading selects its whole subtree. |
| `dd`, `yy`, `cc`, `3dd`, … | A folded heading counts as one line, so these act on the whole subtree. |
| `u` | Undoing a delete brings back folded headings still folded. |
| `p` / `P` | Put a yanked subtree after or before a folded heading, not inside it. Pasted subtrees arrive folded (org-mode's `org-yank-folded-subtrees`). |
| `>>` / `<<` | On a heading, demote/promote by adding/removing a `#` instead of indenting. Folded, the whole subtree shifts (`M-S-→` in org-mode). Open, only the heading shifts (`M-→` in org-mode). Levels stay between 1 and 6. Body lines are left alone. |
| `3>>`, `V>`, `.` | Every heading in the range shifts. Repeatable and undoable in one step. |
| `Alt-j` / `Alt-k` | On a heading, swap its subtree with the next or previous sibling (`M-↓`/`M-↑` in org-mode). It won't cross the parent's boundary. Blank lines between subtrees stay put, and folded subtrees stay folded. A count moves past that many siblings; `.` repeats and `u` undoes in one step. On other lines, move the line, stepping over a folded heading as one line. On macOS, Alt is Option. |
| `ar` / `ir` | Subtree text objects (evil-org `ar`/`ir`), folded or not. `ar` is the subtree the cursor is in plus trailing blank lines; `ir` is its body, without the heading or surrounding blank lines. Use them with any operator (`dar`, `yar`, `cir`, `>ar`) or in visual mode. A count (`d2ar`), or `ar` again in visual mode, takes in the parent subtree. |

On lines that aren't headings, `>` and `<` indent as usual. Lines starting with `#` inside fenced code blocks or front matter never count as headings.

## Commands

Four of the actions above are also Obsidian commands, bindable under **Settings → Hotkeys**:

- **Cycle fold under cursor (TAB in org-mode)** — what `Tab` does
- **Cycle global fold overview (S-TAB in org-mode)** — what `Shift-Tab` does
- **Move subtree down (M-↓ in org-mode)** — what `Alt-j` does
- **Move subtree up (M-↑ in org-mode)** — what `Alt-k` does

None has a default hotkey — bind them yourself. Unlike the keys above, they also work in insert mode and with Vim mode turned off.

## Installation

From Obsidian: **Settings → Community plugins → Browse**, search for "Evil Org".

Manually: download `main.js` and `manifest.json` from the [latest release](https://github.com/spwx/obsidian-evil-org/releases/latest) into `<vault>/.obsidian/plugins/evil-org/`, then enable the plugin under **Settings → Community plugins**.

## How it works, and a caveat

Obsidian has no public API for its Vim mode, so the plugin changes the Vim engine that Obsidian exposes at `window.CodeMirrorAdapter.Vim`. It redefines the `expandToLine` motion so it is fold-aware, and it maps `p`, `P`, `d`, `>`, `<`, `<A-j>`, `<A-k>`, `ar` and `ir` (plus `x`, `X` and `D` in visual mode). Obsidian's Vim can lose the Alt modifier on macOS, where Option-j arrives as `∆`, so the plugin catches Alt-j/Alt-k by key code in Vim normal mode before the editor sees them. It also reads the CodeMirror 6 view through `editor.cm`. None of this is documented, so an Obsidian update could break the plugin. Unloading the plugin restores stock Vim behaviour.

## Development

`main.js` is the source; `npm run build` only syntax-checks it, so the released file is byte-for-byte the one in the repo. The end-to-end tests run it against a real CodeMirror 6 editor with [codemirror-vim](https://github.com/replit/codemirror-vim) in jsdom:

```sh
npm install
npm test
```

To release, run the release script with the new version (no `v`):

```sh
npm run release -- 1.1.3          # bump, test, commit, tag
npm run release -- 1.1.3 --push   # ...and push main and the tag
```

It bumps `version` in `manifest.json`, adds the same version to `versions.json` (mapped to the manifest's `minAppVersion`, which tells older Obsidian installs which build still runs for them), runs the build and tests, then commits and tags. The commit message opens in `$EDITOR` prefilled with `Bump to <version>` so the body can describe what changed; `--no-edit` keeps just that line. It refuses to run on a dirty tree, off `main`, when `main` and `origin/main` have diverged, or when the version is not newer than the current one.

Pushing the tag starts the Release workflow, which runs the tests, checks the tag against both files, attests `main.js` and `manifest.json`, and publishes the GitHub release.

## License

[MIT](LICENSE)
