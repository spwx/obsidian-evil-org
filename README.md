# Evil Org

Evil Org adds org-mode headline editing to the Vim mode of Obsidian. It uses the same concepts as Emacs [evil-org-mode](https://github.com/Somelauw/evil-org-mode).

The plugin uses Markdown headings as org headlines. The `Tab` key changes the fold state of a heading, as in org-mode. When a heading is folded, the plugin counts it as one line. Vim commands then move, copy, promote, and demote the full subtree.

## Requirements

The plugin is primarily a set of Vim keys. You must set **Settings → Editor → Vim key bindings** to on.

The keys in the table that follows operate only in Vim normal mode and Vim visual mode. They do not change insert mode or usual editing. The nine [commands](#commands) are different. They operate in all modes, with or without Vim.

## Keys

| Key | Function |
| --- | --- |
| `Tab` | Changes the fold state of the heading at the cursor in this sequence: folded → children → subtree (`TAB` in org-mode). On a folded block that is not a heading, it opens or closes that fold. In a table, `Tab` aligns the table and moves the cursor to the start of the next cell (`TAB` in an org-mode table). After the last cell of a row, it goes to the first cell of the next row. It skips the delimiter row. In the last cell of the table, it opens a new empty row below the table. |
| `Shift-Tab` | Changes the fold state of all of the note in this sequence: overview → contents → show all (`S-TAB` in org-mode). In a table, `Shift-Tab` aligns the table and moves the cursor to the start of the previous cell. In the first cell, the cursor stays. |
| `V` | When you select a folded heading, the selection includes all of its subtree. |
| `dd`, `yy`, `cc`, `3dd`, … | The plugin counts a folded heading as one line. Thus, these commands operate on all of the subtree. |
| `u` | When you undo a delete, the plugin restores the folded headings in their folded state. |
| `p` / `P` | Puts a yanked subtree after or before a folded heading, not in it. Pasted subtrees stay folded (`org-yank-folded-subtrees` in org-mode). |
| `>>` / `<<` | On a heading, these keys demote or promote the heading. They add or remove one `#`. They do not indent the line. If the heading is folded, all of the subtree changes level (`M-S-→` in org-mode). If the heading is open, only the heading changes level (`M-→` in org-mode). The level stays between 1 and 6. The plugin does not change body lines. On a list item, these keys indent or outdent the item with its body and sub-items (`M-S-→`/`M-S-←` in org-mode). `>>` puts the item under the item above it. The item gets the indent of the sub-items of that item. If that item has no sub-items, the indent is one tab if the lists of the note use tabs, or else spaces up to the text of that item. `<<` makes the item a sibling of its parent. On an item without a parent, `<<` does nothing. Folded items stay folded. In a numbered list, the plugin renumbers the items. |
| `3>>`, `V>`, `.` | All headings in the range change level. If the range starts on a list item, all items in the range move with their sub-items. You can repeat the change with `.`. One `u` undoes all of the change. |
| `Alt-j` / `Alt-k` | On a heading, these keys exchange its subtree with the next or previous sibling (`M-↓`/`M-↑` in org-mode). The subtree does not move out of its parent. Blank lines between subtrees do not move. Folded subtrees stay folded. With a count, the subtree moves past that number of siblings. `.` repeats the move, and one `u` undoes it. In a list, these keys exchange the item at the cursor, with its body and sub-items, with the next or previous item (`M-↓`/`M-↑` in org-mode). The item does not move out of its parent item or its list. Blank lines, folds, counts, `.`, and `u` operate as for subtrees. In a numbered list, the plugin renumbers the items. In a table, these keys exchange the row at the cursor with the next or previous row (`M-↓`/`M-↑` in an org-mode table). A row does not move above the delimiter row, and the header row and the delimiter row do not move. Counts, `.`, and `u` operate as for subtrees. On other lines, these keys move the line. They move over a folded heading as one line. On macOS, the Alt key is the Option key. |
| `Alt-h` / `Alt-l` | In a table, these keys move the column at the cursor to the left or to the right (`M-←`/`M-→` in an org-mode table). The alignment colons of the column move with it, and the plugin aligns the table. The cursor stays in its cell. With a count, the column moves past that number of columns. `.` repeats the move, and one `u` undoes it. At the first or last column, these keys do nothing. Outside tables, the plugin does not change these keys. |
| `o` / `O` | In a list, these keys open a new item below or above the item at the cursor (`evil-org-open-below`/`-above`). The new item has the same indent and bullet. In a numbered list, it gets the next number, and the plugin renumbers the items after it. If the item has a checkbox, the new item gets an empty checkbox. `o` opens the new item after the sub-items of the item, as in org-mode. In a table, `o` and `O` open an empty row below or above the row at the cursor, with the same cells. Each cell keeps its width, so an aligned table stays aligned. The cursor goes in the first cell. On the header row, `o` opens the first row below the delimiter row, and `O` opens a usual line above the table. On a heading, `o` and `O` open a usual line. To open a new heading, use the **Insert heading** command. On a folded heading, item, or block, `o` opens the line below the fold, not in it. A count (`3o`) and `.` open more items or rows. |
| `ar` / `ir` | Text objects for a subtree (evil-org `ar`/`ir`). They operate on folded and open subtrees. `ar` is the subtree that contains the cursor, plus the blank lines after it. `ir` is the body of that subtree. It does not include the heading or the blank lines around it. You can use them with all operators (`dar`, `yar`, `cir`, `>ar`) and in visual mode. With a count (`d2ar`), or when you type `ar` again in visual mode, the selection includes the parent subtree. |
| `ae` / `ie` | Text objects for the Markdown element at the cursor (evil-org `ae`/`ie`). The element can be a list item with its sub-items, a list, a table, a fenced code block, front matter, a block quote or callout, a paragraph, or a heading line. A paragraph in the body of a list item is an element in that item. `ae` is the element, plus the blank lines after it. On a blank line, `ae` is the element above it. `ie` is the inside of the element. For a list item or a heading, it is the text after the bullet, number, checkbox, or `#` characters. For a code block or front matter, it is the lines between the fences. For a table, it is the rows below the delimiter row, so the header stays. For a callout, it is the lines after the title line. For other elements, it is the lines without the blank lines after them. You can use them with all operators (`dae`, `yae`, `cie`, `>ae`) and in visual mode. With a count (`d2ae`), or when you type `ae` again in visual mode, the selection includes the next element that contains it: from a paragraph in an item, the item; from a sub-item, its list, then the parent item, then the subtrees around it, as with `ar`. A folded heading or item counts as one line, so `dae` on a folded heading deletes all of the subtree. |

On lines that are not headings or list items, `>` and `<` indent the line as in standard Vim. In fenced code blocks and front matter, a line that starts with `#` is not a heading.

When the plugin aligns a table (`C-c C-c` in org-mode), it pads each cell with spaces to the width of the widest cell in its column. Cells go to the left, the right, or the center, as the colons in the delimiter row tell. The plugin makes the delimiter row again with dashes to the width of the column, and keeps its colons. A row with fewer cells than the other rows gets empty cells. A row with more cells adds columns to the table. Each row gets pipes at the start and at the end, and the indent of the header row. The plugin does not split a cell at `\|` or at a `|` in inline code, so the text in code does not change. The plugin counts East Asian wide characters and emoji as two characters wide. This is only an estimate. The columns align correctly only in a monospace font that shows these characters at two widths. The default font of Obsidian is not monospace.

## Commands

Nine actions are also Obsidian commands. You can set hotkeys for them in **Settings → Hotkeys**:

- **Cycle fold under cursor (TAB in org-mode)**: same function as `Tab` outside tables
- **Cycle global fold overview (S-TAB in org-mode)**: same function as `Shift-Tab` outside tables
- **Move subtree down (M-↓ in org-mode)**: same function as `Alt-j`. It moves the subtree, the list item, the table row, or the line at the cursor down.
- **Move subtree up (M-↑ in org-mode)**: same function as `Alt-k`. It moves the subtree, the list item, the table row, or the line at the cursor up.
- **Insert heading (M-RET in org-mode)**: opens a new heading after the subtree that contains the cursor. The new heading has the same level as the heading of that subtree. If the cursor is not under a heading, the new heading has level 1.
- **Insert subheading**: opens a new heading at the end of the subtree that contains the cursor. The new heading has one more `#` than the heading of that subtree, to a maximum of 6.
- **Align table**: aligns the table at the cursor. The cursor stays in its cell.
- **Move table column left**: same function as `Alt-h`
- **Move table column right**: same function as `Alt-l`

These commands do not have default hotkeys. You must set the hotkeys yourself. Different from the keys in the table, these commands also operate in insert mode and when Vim mode is off. In Vim normal mode, the insert commands go to insert mode.

### Use Alt-Enter to insert a heading

In org-mode, `M-RET` inserts a heading. To use `Alt-Enter` for **Insert heading**, do these steps:

1. Open **Settings → Hotkeys**.
2. Type "Follow link under cursor" in the search field. In Obsidian, `Alt-Enter` is the default hotkey of this command. Remove this hotkey. If you want to follow links from the keyboard, set a different hotkey for this command.
3. Type "Insert heading" in the search field.
4. Set the hotkey of **Insert heading (M-RET in org-mode)** to `Alt-Enter`.

If you do not remove the hotkey of **Follow link under cursor**, `Alt-Enter` does not insert a heading.

You cannot map `Alt-Enter` in a vimrc file. Obsidian gets its hotkeys before Vim does, so Vim does not get `Alt-Enter`.

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
- It maps `o`, `O`, `p`, `P`, `d`, `>`, `<`, `<A-j>`, `<A-k>`, `<A-h>`, `<A-l>`, `ar`, `ir`, `ae`, and `ie`. In visual mode, it also maps `x`, `X`, and `D`.
- It gets `Alt-j` and `Alt-k` by their key codes in Vim normal mode, before the editor gets them. On macOS, the Vim mode of Obsidian can lose the Alt modifier. For example, `Option-j` gives `∆`. It gets `Alt-h` and `Alt-l` in the same way, but only when the cursor is in a table.
- It adds a `Tab` and `Shift-Tab` key binding to the editor. The binding operates only in Vim normal mode.
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
