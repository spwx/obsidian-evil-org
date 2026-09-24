# Evil Org

Evil Org adds org-mode headline editing to the Vim mode of Obsidian. It uses the same concepts as Emacs [evil-org-mode](https://github.com/Somelauw/evil-org-mode).

The plugin uses Markdown headings as org headlines. The `Tab` key changes the fold state of a heading, as in org-mode. When a heading is folded, the plugin counts it as one line. Vim commands then move, copy, promote, and demote the full subtree.

## Requirements

The plugin is primarily a set of Vim keys. You must set **Settings → Editor → Vim key bindings** to on.

The keys in the table that follows operate only in Vim normal mode and Vim visual mode. They do not change insert mode or usual editing. The four [commands](#commands) are different. They operate in all modes, with or without Vim.

## Keys

| Key | Function |
| --- | --- |
| `Tab` | Changes the fold state of the heading at the cursor in this sequence: folded → children → subtree (`TAB` in org-mode). On a folded block that is not a heading, it opens or closes that fold. |
| `Shift-Tab` | Changes the fold state of all of the note in this sequence: overview → contents → show all (`S-TAB` in org-mode). |
| `V` | When you select a folded heading, the selection includes all of its subtree. |
| `dd`, `yy`, `cc`, `3dd`, … | The plugin counts a folded heading as one line. Thus, these commands operate on all of the subtree. |
| `u` | When you undo a delete, the plugin restores the folded headings in their folded state. |
| `p` / `P` | Puts a yanked subtree after or before a folded heading, not in it. Pasted subtrees stay folded (`org-yank-folded-subtrees` in org-mode). |
| `>>` / `<<` | On a heading, these keys demote or promote the heading. They add or remove one `#`. They do not indent the line. If the heading is folded, all of the subtree changes level (`M-S-→` in org-mode). If the heading is open, only the heading changes level (`M-→` in org-mode). The level stays between 1 and 6. The plugin does not change body lines. |
| `3>>`, `V>`, `.` | All headings in the range change level. You can repeat the change with `.`. One `u` undoes all of the change. |
| `Alt-j` / `Alt-k` | On a heading, these keys exchange its subtree with the next or previous sibling (`M-↓`/`M-↑` in org-mode). The subtree does not move out of its parent. Blank lines between subtrees do not move. Folded subtrees stay folded. With a count, the subtree moves past that number of siblings. `.` repeats the move, and one `u` undoes it. On other lines, these keys move the line. They move over a folded heading as one line. On macOS, the Alt key is the Option key. |
| `ar` / `ir` | Text objects for a subtree (evil-org `ar`/`ir`). They operate on folded and open subtrees. `ar` is the subtree that contains the cursor, plus the blank lines after it. `ir` is the body of that subtree. It does not include the heading or the blank lines around it. You can use them with all operators (`dar`, `yar`, `cir`, `>ar`) and in visual mode. With a count (`d2ar`), or when you type `ar` again in visual mode, the selection includes the parent subtree. |

On lines that are not headings, `>` and `<` indent the line as in standard Vim. In fenced code blocks and front matter, a line that starts with `#` is not a heading.

## Commands

Four of the actions in the table are also Obsidian commands. You can set hotkeys for them in **Settings → Hotkeys**:

- **Cycle fold under cursor (TAB in org-mode)**: same function as `Tab`
- **Cycle global fold overview (S-TAB in org-mode)**: same function as `Shift-Tab`
- **Move subtree down (M-↓ in org-mode)**: same function as `Alt-j`
- **Move subtree up (M-↑ in org-mode)**: same function as `Alt-k`

These commands do not have default hotkeys. You must set the hotkeys yourself. Different from the keys in the table, these commands also operate in insert mode and when Vim mode is off.

## Installation

To install the plugin from Obsidian:

1. Open **Settings → Community plugins → Browse**.
2. Type "Evil Org" in the search field.
3. Select the plugin.
4. Select **Install**, then select **Enable**.

To install the plugin manually:

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/spwx/obsidian-evil-org/releases/latest).
2. Put the two files in `<vault>/.obsidian/plugins/evil-org/`.
3. Open **Settings → Community plugins** and set **Evil Org** to on.

## How the plugin operates

Obsidian does not have a public API for its Vim mode. For this reason, the plugin changes the Vim engine that Obsidian makes available at `window.CodeMirrorAdapter.Vim`. The plugin makes these changes:

- It changes the `expandToLine` motion so that the motion includes folded lines.
- It maps `p`, `P`, `d`, `>`, `<`, `<A-j>`, `<A-k>`, `ar`, and `ir`. In visual mode, it also maps `x`, `X`, and `D`.
- It gets `Alt-j` and `Alt-k` by their key codes in Vim normal mode, before the editor gets them. On macOS, the Vim mode of Obsidian can lose the Alt modifier. For example, `Option-j` gives `∆`.
- It gets the CodeMirror 6 view from `editor.cm`.

**Caution:** Obsidian does not document these interfaces. An Obsidian update can cause the plugin to stop operating. When you unload the plugin, Vim goes back to its standard behavior.

## Development

The source file is `main.js`. The command `npm run build` only does a syntax check of this file. The build does not change the file. Thus, the released file is identical to the file in the repository, byte for byte.

The end-to-end tests run `main.js` in jsdom, with a real CodeMirror 6 editor and [codemirror-vim](https://github.com/replit/codemirror-vim). To run the tests, use these commands:

```sh
npm install
npm test
```

To make a release, run the release script with the new version number. Do not put a `v` before the number.

```sh
npm run release -- 1.1.3          # change the version, test, commit, and tag
npm run release -- 1.1.3 --push   # do the same steps, then push main and the tag
```

The script does these steps:

1. It changes `version` in `manifest.json` to the new version.
2. It adds the new version to `versions.json`, with the `minAppVersion` value from `manifest.json`. This value tells older Obsidian installations which build they can use.
3. It runs the build and the tests.
4. It makes a commit and a tag.

The commit message opens in `$EDITOR`. The first line is `Bump to <version>`. Add a body that describes the changes. To keep only the first line, add `--no-edit`.

The script stops if one of these conditions is true:

- The working tree has changes that are not committed.
- The current branch is not `main`.
- `main` and `origin/main` have diverged.
- The new version is not more recent than the current version.

When you push the tag, the Release workflow starts. The workflow does these steps:

1. It runs the tests.
2. It compares the tag with the version in `manifest.json` and in `versions.json`.
3. It makes attestations for `main.js` and `manifest.json`.
4. It publishes the GitHub release.

## License

[MIT](LICENSE)
