# Evil Org

Evil Org adds org-mode headline editing to the Vim mode of Obsidian. It uses the same concepts as Emacs [evil-org-mode](https://github.com/Somelauw/evil-org-mode).

The plugin uses Markdown headings as org headlines. The `Tab` key changes the fold state of a heading, as in org-mode. When a heading is folded, the plugin counts it as one line. Vim commands then move, copy, promote, and demote the full subtree.

## Requirements

The plugin is primarily a set of Vim keys. You must set **Settings → Editor → Vim key bindings** to on.

The keys in the table that follows operate only in Vim normal mode and Vim visual mode. They do not change insert mode or usual editing. The [commands](#commands) and [indent mode](#indent-mode) are different. They operate in all modes, with or without Vim.

## Keys

| Key | Function |
| --- | --- |
| `Tab` | Changes the fold state of the heading at the cursor, as `TAB` (`org-cycle`) does in org-mode. On a folded heading, it shows the text of the heading and its subheadings, folded (children). If the heading has no subheadings, it shows all of the subtree. When you push `Tab` again immediately after children, it shows all of the subtree (subtree). At all other times, it folds the subtree (folded). Thus, the sequence is folded → children → subtree → folded. Folded list items and code blocks in the subtree stay folded. On a block that is not a heading, it opens or closes the fold of that block. |
| `Shift-Tab` | Changes the fold state of all of the note, as `S-TAB` (`org-global-cycle`) does in org-mode. It shows the overview: the first heading, and the headings after it that are not deeper, with all of their text folded. When you push `Shift-Tab` again immediately after the overview, it shows the contents: all headings, with only the text of each heading folded. When you push it again immediately after the contents, it shows all of the note. At all other times, it shows the overview. Thus, the sequence is overview → contents → show all → overview. Text before the first heading does not change. If the cursor is in text that becomes folded, the cursor goes to the visible line above it. |
| `V` | When you select a folded heading, the selection includes all of its subtree. |
| `dd`, `yy`, `cc`, `3dd`, … | The plugin counts a folded heading as one line. Thus, these commands operate on all of the subtree. |
| `u` | When you undo a delete, the plugin restores the folded headings in their folded state. |
| `p` / `P` | Puts a yanked subtree after or before a folded heading, not in it. Pasted subtrees stay folded (`org-yank-folded-subtrees` in org-mode). |
| `>>` / `<<` | On a heading, these keys demote or promote the heading. They add or remove one `#`. They do not indent the line. If the heading is folded, all of the subtree changes level (`M-S-→` in org-mode). If the heading is open, only the heading changes level (`M-→` in org-mode). The level stays between 1 and 6. If a heading in the range would go past level 1 or level 6, no heading changes, as in org-mode. The plugin does not change body lines. On a list item, these keys indent or outdent the item with its body and sub-items (`M-S-→`/`M-S-←` in org-mode). `>>` puts the item under the item above it. The item gets the indent of the sub-items of that item. If that item has no sub-items, the indent is one tab if the lists of the note use tabs, or else spaces up to the text of that item. `<<` makes the item a sibling of its parent. On an item without a parent, `<<` does nothing. Folded items stay folded. In a numbered list, the plugin renumbers the items. |
| `3>>`, `V>`, `.` | All headings in the range change level, also when the range starts on a body line. If the range starts on a list item, all items in the range move with their sub-items. You can repeat the change with `.`. One `u` undoes all of the change. |
| `Alt-j` / `Alt-k` | On a heading, these keys exchange its subtree with the next or previous sibling (`M-↓`/`M-↑` in org-mode). The subtree does not move out of its parent. Blank lines between subtrees do not move. Folded subtrees stay folded. With a count, the subtree moves past that number of siblings. `.` repeats the move, and one `u` undoes it. In a list, these keys exchange the item at the cursor, with its body and sub-items, with the next or previous item (`M-↓`/`M-↑` in org-mode). The item does not move out of its parent item or its list. Blank lines, folds, counts, `.`, and `u` operate as for subtrees. In a numbered list, the plugin renumbers the items. On other lines, these keys move the line. They move over a folded heading as one line. On macOS, the Alt key is the Option key. |
| `o` / `O` | In a list, these keys open a new item below or above the item at the cursor (`evil-org-open-below`/`-above`). The new item has the same indent and bullet. In a numbered list, it gets the next number, and the plugin renumbers the items after it. If the item has a checkbox, the new item gets an empty checkbox. `o` opens the new item after the sub-items of the item, as in org-mode. On a heading, `o` and `O` open a usual line. To open a new heading, use the **Insert heading** command. On a folded heading, item, or block, `o` opens the line below the fold, not in it. A count (`3o`) and `.` open more items. |
| `ar` / `ir` | Text objects for a subtree (evil-org `ar`/`ir`). They operate on folded and open subtrees. `ar` is the subtree that contains the cursor, plus the blank lines after it. `ir` is the body of that subtree. It does not include the heading or the blank lines around it. You can use them with all operators (`dar`, `yar`, `cir`, `>ar`) and in visual mode. With a count (`d2ar`), or when you type `ar` again in visual mode, the selection includes the parent subtree. On a Markdown table row, `ar` is the row and `ir` is the text between its first and last `|`, as in Vim Motions. There, a count of 2 or typing `ar` again in visual mode selects the subtree. |
| `ae` / `ie` | Text objects for the Markdown element at the cursor (evil-org `ae`/`ie`). The element can be a list item with its sub-items, a list, a fenced code block, front matter, a block quote or callout, a paragraph, or a heading line. A paragraph in the body of a list item is an element in that item. `ae` is the element, plus the blank lines after it. On a blank line, `ae` is the element above it. `ie` is the inside of the element. For a list item or a heading, it is the text after the bullet, number, checkbox, or `#` characters. For a code block or front matter, it is the lines between the fences. For a callout, it is the lines after the title line. For other elements, it is the lines without the blank lines after them. You can use them with all operators (`dae`, `yae`, `cie`, `>ae`) and in visual mode. With a count (`d2ae`), or when you type `ae` again in visual mode, the selection includes the next element that contains it: from a paragraph in an item, the item; from a sub-item, its list, then the parent item, then the subtrees around it, as with `ar`. A folded heading or item counts as one line, so `dae` on a folded heading deletes all of the subtree. |
| `gh` | Moves the cursor to the heading of the line it is on (evil-org `gh`, `org-up-element`). On a heading, it moves to the parent heading, so typing `gh` again goes up the outline. With a count (`2gh`), it goes up that many levels. On a top-level heading, or before the first heading, the cursor does not move. It is linewise with operators (`dgh` deletes from the heading to the cursor line), and `Ctrl-o` goes back. |

If a range has no headings and does not start on a list item, `>` and `<` indent its lines as in standard Vim. In fenced code blocks and front matter, a line that starts with `#` is not a heading.

## Commands

Eight actions are also Obsidian commands. You can set hotkeys for them in **Settings → Hotkeys**:

- **Cycle fold under cursor (TAB in org-mode)**: same function as `Tab`
- **Cycle global fold overview (S-TAB in org-mode)**: same function as `Shift-Tab`
- **Move subtree down (M-↓ in org-mode)**: same function as `Alt-j`. It moves the subtree, the list item, or the line at the cursor down.
- **Move subtree up (M-↑ in org-mode)**: same function as `Alt-k`. It moves the subtree, the list item, or the line at the cursor up.
- **Insert heading (M-RET in org-mode)**: opens a new heading after the subtree that contains the cursor. The new heading has the same level as the heading of that subtree. If the cursor is not under a heading, the new heading has level 1.
- **Insert subheading**: opens a new heading at the end of the subtree that contains the cursor. The new heading has one more `#` than the heading of that subtree, to a maximum of 6.
- **Go to heading of this line (org-up-element)**: same function as `gh`. It moves the cursor to the heading of the line it is on, or from a heading to its parent heading.
- **Toggle indent mode (org-indent-mode)**: sets [indent mode](#indent-mode) to on or off.

These commands do not have default hotkeys. You must set the hotkeys yourself. Different from the keys in the table, these commands also operate in insert mode and when Vim mode is off. In Vim normal mode, the insert commands go to insert mode.

### Use Alt-Enter to insert a heading

In org-mode, `M-RET` inserts a heading. To use `Alt-Enter` for **Insert heading**, do these steps:

1. Open **Settings → Hotkeys**.
2. Type "Follow link under cursor" in the search field. In Obsidian, `Alt-Enter` is the default hotkey of this command. Remove this hotkey. If you want to follow links from the keyboard, set a different hotkey for this command.
3. Type "Insert heading" in the search field.
4. Set the hotkey of **Insert heading (M-RET in org-mode)** to `Alt-Enter`.

If you do not remove the hotkey of **Follow link under cursor**, `Alt-Enter` does not insert a heading.

You cannot map `Alt-Enter` in a vimrc file. Obsidian gets its hotkeys before Vim does, so Vim does not get `Alt-Enter`.

## Indent mode

Indent mode indents the text of a note by the outline, as `org-indent-mode` does in org-mode. Obsidian does not have this function. The plugin does not change the text of the note. It changes only how the editor shows the lines.

A heading of level 1 is not indented. A heading of level 2 is indented one step, a heading of level 3 two steps, and so on. The lines under a heading are indented one step more than the heading. Thus, a heading starts at the same position as the text of its parent, as the star of a heading does in org-mode. Text before the first heading is not indented. Wrapped lines align with the first line, and list items keep their indent. In Live Preview, tables, callouts, and embeds are indented with the text around them.

In Live Preview, indent mode also shows a bullet in place of the `#` characters of a heading, as [org-bullets](https://github.com/sabof/org-bullets) does in org-mode. The bullet is `◉` for level 1, `○` for level 2, `✸` for level 3, and `✿` for level 4, then the sequence starts again. The bullet is one step wide, so the text of a heading aligns with the lines under it. When the cursor is on a heading, Obsidian shows the `#` characters, and the bullet goes away. Source mode does not show bullets.

To set indent mode to on or off, use the **Toggle indent mode (org-indent-mode)** command, or **Settings → Evil Org → Indent mode**. The setting applies to all notes and stays after you restart Obsidian. Indent mode operates with or without Vim.

One step is 1.5 times the font size of the editor. To change it, set the `--evil-org-indent` CSS variable in a [CSS snippet](https://help.obsidian.md/snippets). For example:

```css
.markdown-source-view { --evil-org-indent: 2ch; }
```

Indent mode operates only in the editor, not in reading view.

### Compact headings

Obsidian puts space above each heading. Thus, the headings of a folded outline are farther apart than lines of text. When you set **Settings → Evil Org → Compact headings** to on, the editor does not show this space or the blank lines between a heading and the next heading. Thus, the headings are on consecutive lines, as in org-mode. Blank lines before or after body text still show. When the cursor is on a hidden blank line, the line shows. The text of the note does not change. You can use this setting with or without indent mode.

### Uniform heading size

Obsidian shows headings in larger fonts than body text, and a higher level has a larger font. When you set **Settings → Evil Org → Uniform heading size** to on, the editor shows all headings at the font size and line height of body text, as in org-mode. Headings keep their color and weight. You can use this setting with or without indent mode.

### Hide heading fold arrows

When you set **Settings → Evil Org → Hide heading fold arrows** to on, the editor does not show the fold arrows of headings, as org-mode shows none. With indent mode, the bullets mark the headings. To fold and unfold headings, use `Tab` and `Shift-Tab`. A folded heading still shows the number of lines in its fold. List items keep their fold arrows.

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
- It wraps the `findPosV` method of the Vim adapter class that the editor uses (`window.CodeMirrorAdapter` in Obsidian, or the class of a Vim engine that another plugin, such as Vim Motions, bundles) so that `j` moves past a closed fold in one step. Without this change, the first `j` on a folded heading puts the cursor at the end of the heading.
- It maps `o`, `O`, `p`, `P`, `d`, `>`, `<`, `<A-j>`, `<A-k>`, `ar`, `ir`, `ae`, `ie`, and `gh`. In visual mode, it also maps `x`, `X`, and `D`.
- It gets `Alt-j` and `Alt-k` in Vim normal mode, in the main window and in pop-out windows, before the editor and Obsidian's hotkeys get them. Thus, in Vim normal mode, an Obsidian hotkey that you set to `Alt-j` or `Alt-k` does not operate. The plugin gets the keys by the letter that you type. If the key does not give a letter, the plugin uses the key code. On macOS, the Vim mode of Obsidian can lose the Alt modifier. For example, `Option-j` gives `∆`.
- It adds a `Tab` and `Shift-Tab` key binding to the editor. The binding operates only in Vim normal mode.
- It gives headings the same fold range as Obsidian: up to the next heading of the same or a higher level, including the blank lines before it. This range has priority over the fold ranges of other plugins. For example, Vim Motions ends a heading fold at the last line that is not blank, so a blank line shows under each folded heading.
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
npm run release -- 1.1.3          # test, change the version, commit, and tag
npm run release -- 1.1.3 --push   # do the same steps, then push main and the tag
```

The script does these steps:

1. It runs the build and the tests. If they fail, the script stops before it changes a file.
2. It changes `version` in `manifest.json` to the new version.
3. It adds the new version to `versions.json`, with the `minAppVersion` value from `manifest.json`. This value tells older Obsidian installations which build they can use.
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
