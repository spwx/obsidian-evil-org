# Evil Org

Evil Org adds org-mode outline keys to the Vim mode of Obsidian. The keys operate as in the Emacs package [evil-org-mode](https://github.com/Somelauw/evil-org-mode).

The plugin uses Markdown headings as org-mode headlines. A subtree is a heading and all of the lines under it, to the next heading of the same or a higher level. The plugin counts a folded heading as one line. Thus, Vim commands move, copy, and delete the full subtree.

## Requirements

Set **Settings → Editor → Vim key bindings** to on.

The [keys](#keys) operate only in Vim normal mode and Vim visual mode. They do not change insert mode, except the [table keys](#tab-shift-tab-and-enter-in-a-table). The [commands](#commands) and [indent mode](#indent-mode) operate in all modes, also when Vim mode is off.

## Keys

In fenced code blocks and front matter, a line that starts with `#` is not a heading.

### `Tab`: Fold a heading

In a table, `Tab` moves to the next cell. See [Tab, Shift-Tab, and Enter in a table](#tab-shift-tab-and-enter-in-a-table).

`Tab` changes the fold state of the heading at the cursor (`org-cycle`). The fold states are:

- **Folded**: The editor shows only the heading.
- **Children**: The editor shows the text of the heading and its subheadings. The subheadings stay folded.
- **Subtree**: The editor shows all of the subtree.

`Tab` changes the state as follows:

1. On a folded heading, `Tab` shows the children. If the heading has no subheadings, `Tab` shows the subtree.
2. When you push `Tab` again immediately after the children, `Tab` shows the subtree.
3. At all other times, `Tab` folds the subtree.

Thus, the sequence is folded → children → subtree → folded.

Folded list items and code blocks in the subtree stay folded. On a block that is not a heading, such as a list item or the opening fence of a code block, `Tab` opens or closes the fold of that block.

### `Shift-Tab`: Fold the note

In a table, `Shift-Tab` moves to the previous cell.

`Shift-Tab` changes the fold state of all of the note (`org-global-cycle`). The fold states are:

- **Overview**: The editor shows the first heading and the headings after it that are not deeper. All of their text is folded.
- **Contents**: The editor shows all headings. Only the body text of each heading is folded.
- **Show all**: The editor shows all of the note.

`Shift-Tab` changes the state as follows:

1. When you push `Shift-Tab` immediately after the overview, `Shift-Tab` shows the contents.
2. When you push `Shift-Tab` immediately after the contents, `Shift-Tab` shows all of the note.
3. At all other times, `Shift-Tab` shows the overview.

Text before the first heading does not change. If the cursor is in text that becomes folded, the cursor moves to the visible line above it.

### `Tab`, `Shift-Tab`, and `Enter` in a table

In a Markdown table, these keys align the table and move the cursor between cells, as in the org-mode table editor:

- `Tab` moves to the next cell (`org-table-next-field`). In the last cell, `Tab` adds an empty row and moves to its first cell.
- `Shift-Tab` moves to the previous cell (`org-table-previous-field`). In the first cell, the cursor does not move.
- `Enter` moves to the same column in the next row (`org-table-next-row`). In the last row, `Enter` adds an empty row.

The cursor goes to the start of the text of the cell. The keys skip the delimiter row (`| --- | :-: |`).

A Markdown table needs a delimiter row, right below its first row. If the table does not have one, these keys add it. For example, type `| Name | Phone |` and push `Enter`: the delimiter row goes below the row, and the cursor goes to a new row below it. To set the alignment of a column, put colons in the delimiter row, as in `| :-: |`.

To align the table, the plugin pads each cell with spaces, so that the pipes line up:

- Each row gets all of the columns. A row without a closing `|` gets one.
- The cells of a column align left, right, or center, as the colons of the delimiter row set. A column without colons aligns left.
- The dashes of the delimiter row fill the width of the column. A column is at least three characters wide, the width of `---`.
- All rows get the indent of the first row.
- An escaped pipe (`\|`) is text in its cell.
- Chinese, Japanese, and Korean characters count as two characters wide.

These keys operate in Vim normal mode and in insert mode, as in evil-org. With a count, `Enter` moves down as in Vim. One `u` undoes one key.

A table is a block of lines that start with `|`. Lines in fenced code blocks are not tables. In Live Preview, the table shows as text when the cursor of Vim is in it (see [Tables in Live Preview](#tables-in-live-preview)).

### `Alt` with `h`, `j`, `k`, `l`, or an arrow: Change a table

In a Markdown table, in Vim normal mode, these keys move, delete, and insert rows and columns, as in the org-mode table editor and evil-org. On macOS, the Alt key is the Option key. To use `Ctrl` in place of `Alt`, see [Meta key](#meta-key). Each arrow key does the same as the letter in its direction:

| Key | Arrow key | Change | org-mode command |
| --- | --- | --- | --- |
| `Alt-h` | `Alt-←` | Move the column left | `org-table-move-column-left` |
| `Alt-l` | `Alt-→` | Move the column right | `org-table-move-column-right` |
| `Alt-k` | `Alt-↑` | Move the row up | `org-table-move-row-up` |
| `Alt-j` | `Alt-↓` | Move the row down | `org-table-move-row-down` |
| `Alt-Shift-h` | `Alt-Shift-←` | Delete the column | `org-table-delete-column` |
| `Alt-Shift-l` | `Alt-Shift-→` | Insert an empty column to the left of the column | `org-table-insert-column` |
| `Alt-Shift-k` | `Alt-Shift-↑` | Delete the row | `org-table-kill-row` |
| `Alt-Shift-j` | `Alt-Shift-↓` | Insert an empty row above the row | `org-table-insert-row` |

- The cursor stays in its cell, or goes to the new row or column. After a delete, it goes to the next row or column, or to the previous one at the end.
- The alignment colons of the delimiter row move and go with their column.
- A row does not move across the delimiter row. Thus, the header row does not move.
- The delimiter row does not move and is not deleted. The header row is not deleted, and the last row and last column are not deleted.
- In the header row and on the delimiter row, `Alt-Shift-j` inserts the row below the delimiter row, because Markdown has only one header row.
- With a count, the key does the change that number of times, or until it cannot do more.
- `.` repeats the change. One `u` undoes it. The plugin aligns the table, as `Tab` does.

Off a table, `Alt-j` and `Alt-k` move a subtree (see below), and the other keys do what they did before.

### `yy`, `dd`, `p`, and `P` on a table row

In a Markdown table, in Vim normal mode, these keys copy, delete, and paste table rows, and keep the table valid:

- `yy` copies the row as a line, as in Vim.
- `dd` deletes the row and aligns the table (`org-table-kill-row`). The row goes to the register as a line, as in Vim. The cursor stays in its column, in the row that takes the place of the deleted row, or in the row above at the end of the table.
- `p` and `P` put copied or deleted table rows below or above the row at the cursor, and align the table. The rows get the columns of the table. The cursor goes to the first cell of the first new row.
- With a count, `3yy` and `3dd` stop at the last row of the table, as a count stops at the end of the note. They do not copy or delete the text after the table. `3p` puts three copies of the rows.
- `dd` does nothing on the delimiter row and on the header row, because a Markdown table needs them. To delete the full table, use `dap` or `dip`, or a count that includes all of the table, such as `9dd` on the header row.
- `p` and `P` in the header row or on the delimiter row put the rows below the delimiter row.
- A copied delimiter row is pasted as a row of cells that hold its dashes, because only the first delimiter row is the delimiter row of the table. Its dashes do not fill the column, `Tab` moves into its cells, and `dd` deletes it. The same is true of a row such as `| - | - |` below the delimiter row.
- Other line deletes in the table, such as `dj`, `dk`, and `Vjd`, delete rows in the same way. If they include the delimiter row or the header row, but not all of the table, they do nothing. A delete that includes lines outside the table, such as `dj` on the last row, is the usual Vim delete.
- If the register has lines that are not table rows, or the cursor is not on a table row, `p` and `P` paste as usual.
- `.` repeats `dd`, `p`, and `P`. One `u` undoes each one.

### `i|`, `a|`, and `Ctrl-v` on table cells

In a Markdown table, you can select cells in Vim visual mode, and copy, cut, and paste them, as in the org-mode table editor.

The text objects `i|` and `a|` select the cell at the cursor:

- `i|` is the text of the cell, without the spaces around it.
- `a|` is the cell with its spaces and the `|` after it. Thus, `da|` deletes the cell from the row.
- You can use them with all operators (`ci|`, `di|`, `yi|`, `da|`) and in visual mode (`vi|`).
- On an empty cell, `ci|` starts insert mode in the cell. `di|` and `yi|` do nothing.
- With a count (`d2a|`), the selection includes that number of cells, from the cell at the cursor to the right.
- On a `|`, the cell is the cell that the `|` closes. A last cell without a closing `|` goes to the end of the line.
- Vim Motions has `i|` and `a|` also. The plugin's `i|` does not include the spaces around the text.

A visual block (`Ctrl-v`) in a table selects cells. The block selects all of each cell from the cell of one corner to the cell of the other corner, also when the block covers only part of a cell. Thus, the block selects the same cells in a table that is not aligned. The editor shows the block as Vim draws it, not as cells.

- `y` copies the cells (`org-table-copy-region`).
- `d` and `x` make the cells empty (`org-table-cut-region`), and align the table. They do not delete rows or columns. The cells go to the register, as with `y`.
- `D`, `X`, and `Y` do the same, but to the last column of the table.
- `p` and `P` in normal mode put copied cells into the table (`org-table-paste-rectangle`). The first cell goes into the cell at the cursor. The other cells go to the right and down. They replace the text of the cells there. If the cells go past the last row or column, the plugin adds rows or columns. Then the plugin aligns the table.
- The delimiter row is not copied, made empty, or pasted into. On the delimiter row, `p` and `P` paste into the row below it.
- The register gets the cells as text: one line for each row, with a tab between cells. Thus, outside a table, `p` pastes the cells as columns of text. You can also paste them into a spreadsheet.
- `p` and `P` paste cells only when the register has the text of the most recent cell copy or cut. If the register has other text, `p` and `P` paste as usual.
- `p` and `P` paste the cells from the Vim register, not from the system clipboard. With `clipboard=unnamed` (Vim Motions), text that you copy in a different app after the cells does not go into the table.
- One `u` undoes each change. `.` repeats `d` and `x`.
- If the block includes lines outside the table, the keys operate as usual in Vim. `c`, `>`, `<`, and `p` in visual mode also operate as usual.
- In visual mode (`v`), the keys operate on the text, as usual. For example, `vey` in a cell copies a word.

### Tables in Live Preview

In Live Preview, Obsidian shows a table in a table editor of its own. Vim does not operate in the cells of that editor: keys such as `u`, `gg`, or `V` are typed into the cell. Thus, when the cursor of Vim is in a table, the plugin shows the table as text, as in Source mode. Then all of the Vim keys operate in the table. When the cursor leaves the table, Obsidian shows its table editor again.

- When you move the cursor into a table, for example with `j`, `k`, `gg`, or a search, the table shows as text.
- When you click a cell, the cursor of Vim goes to the text of the cell, and the table shows as text. Obsidian's table editor does not open. The drag handles, the menus, and the `+` buttons of the table editor operate as usual, and so do links in a cell.
- A visual selection that starts or ends in a table shows the table as text.
- Without Vim, Obsidian's table editor operates as usual.

### Line commands: `V`, `dd`, `yy`, `cc`, `u`, `p`, `P`

- `V`: When you select a folded heading, the selection includes all of its subtree.
- `dd`, `yy`, `cc`, `3dd`: The plugin counts a folded heading as one line. Thus, these commands operate on all of the subtree. On a table row, see [yy, dd, p, and P on a table row](#yy-dd-p-and-p-on-a-table-row).
- `u`: When you undo a delete, the deleted headings come back folded.
- `p` / `P`: These keys put a yanked subtree after or before a folded heading, not in it. Pasted subtrees stay folded (`org-yank-folded-subtrees`).

### `>>` / `<<`: Change the level of a heading or list item

On a heading:

- `>>` adds one `#` to the heading. `<<` removes one `#`. These keys do not indent the line.
- If the heading is folded, all headings in the subtree change level (`M-S-→` / `M-S-←`).
- If the heading is open, only that heading changes level (`M-→` / `M-←`).
- The level stays between 1 and 6. If one heading in the range cannot change level, no heading changes.
- Body lines do not change.

On a list item:

- These keys indent or outdent the item with its body and sub-items (`M-S-→` / `M-S-←`).
- `>>` makes the item a sub-item of the item above it. The item gets the indent of the sub-items of that item.
- If the item above has no sub-items, the indent is one tab when the lists of the note use tabs. Else, the indent is spaces up to the text of the item above.
- `<<` makes the item a sibling of its parent. On an item that has no parent, `<<` does nothing.
- Folded items stay folded.
- In a numbered list, the plugin renumbers the items.

On a range (`3>>`, `V>`):

- All headings in the range change level, also when the range starts on a body line.
- If the range starts on a list item, all items in the range move with their sub-items.
- If the range has no headings and does not start on a list item, `>` and `<` indent the lines as in standard Vim.

`.` repeats the change. One `u` undoes all of the change.

### `Alt-j` / `Alt-k`: Move a subtree, list item, or line

On macOS, the Alt key is the Option key. To use `Ctrl-j` and `Ctrl-k` instead, see [Meta key](#meta-key). In a table, these keys move the table row. See [Change a table](#alt-with-h-j-k-l-or-an-arrow-change-a-table).

On a heading, these keys move the subtree down or up, past the next or previous sibling (`M-↓` / `M-↑`):

- The subtree does not move out of its parent.
- Blank lines between subtrees do not move.
- Folded subtrees stay folded.
- With a count, the subtree moves past that number of siblings.
- `.` repeats the move. One `u` undoes it.

In a list, these keys move the item at the cursor, with its body and sub-items, past the next or previous item (`M-↓` / `M-↑`):

- The item does not move out of its parent item or its list.
- Blank lines, folds, counts, `.`, and `u` operate as for subtrees.
- In a numbered list, the plugin renumbers the items.

On other lines, these keys move the line. A folded heading counts as one line.

### `o` / `O`: Open a list item or table row

In a list, these keys open a new item below or above the item at the cursor (`evil-org-open-below` / `evil-org-open-above`):

- The new item has the same indent and bullet.
- In a numbered list, the new item gets the next number. The plugin renumbers the items after it.
- If the item has a checkbox, the new item gets an empty checkbox.
- `o` opens the new item after the sub-items of the item.
- A count (`3o`) and `.` open more items.

In a Markdown table, `o` and `O` insert an empty row below or above the row at the cursor, as `evil-org-open-below` / `evil-org-open-above` do in an org table. The cursor goes to the new row, in the same column, in insert mode, and the plugin aligns the table. In the header row and on the delimiter row, they insert the row below the delimiter row.

On a heading, `o` and `O` open a usual line. To open a new heading, use the **Insert heading** command.

On a folded heading, item, or block, `o` opens the line below the fold.

### `ar` / `ir`: Select a subtree

These text objects select a subtree (evil-org `ar` / `ir`). They operate on folded and open subtrees.

- `ar` is the subtree that contains the cursor, plus the blank lines after it.
- `ir` is the body of that subtree. It does not include the heading or the blank lines around the body.
- You can use them with all operators (`dar`, `yar`, `cir`, `>ar`) and in visual mode.
- With a count (`d2ar`), the selection includes the parent subtree. When you type `ar` again in visual mode, the result is the same.

On a Markdown table row:

- `ar` is the row.
- `ir` is the text between the first `|` and the last `|` of the row.
- To select the subtree, use a count of 2, or type `ar` again in visual mode.

### `ae` / `ie`: Select a Markdown element

These text objects select the Markdown element at the cursor (evil-org `ae` / `ie`). The element can be one of these:

- A list item with its sub-items
- A list
- A fenced code block
- Front matter
- A block quote or callout
- A paragraph
- A heading line

A paragraph in the body of a list item is an element in that item.

`ae` is the element, plus the blank lines after it. On a blank line, `ae` is the element above it.

`ie` is the inside of the element:

- List item or heading: the text after the bullet, number, checkbox, or `#` characters.
- Code block or front matter: the lines between the fences.
- Callout: the lines after the title line.
- Other elements: the lines without the blank lines after them.

You can use them with all operators (`dae`, `yae`, `cie`, `>ae`) and in visual mode.

With a count (`d2ae`), the selection includes the next element that contains it. When you type `ae` again in visual mode, the result is the same. The sequence is:

1. From a paragraph in an item: the item.
2. From a sub-item: its list, then the parent item.
3. After that: the subtrees around it, as with `ar`.

A folded heading or item counts as one line. Thus, `dae` on a folded heading deletes all of the subtree.

### `gh`: Go to the heading

`gh` moves the cursor to the heading of the line (`org-up-element`).

- On a heading, `gh` moves the cursor to the parent heading. Thus, each `gh` moves one level up the outline.
- With a count (`2gh`), the cursor moves up that number of levels.
- On a top-level heading, or before the first heading, the cursor does not move.
- With an operator, `gh` is linewise. For example, `dgh` deletes the lines from the heading to the cursor line.
- `Ctrl-o` moves the cursor back.

## Commands

These actions are also Obsidian commands:

- **Cycle fold under cursor (TAB in org-mode)**: The same function as `Tab`.
- **Cycle global fold overview (S-TAB in org-mode)**: The same function as `Shift-Tab`.
- **Move subtree down (M-↓ in org-mode)**: The same function as `Alt-j`.
- **Move subtree up (M-↑ in org-mode)**: The same function as `Alt-k`.
- **Insert heading (M-RET in org-mode)**: Opens a new heading after the subtree that contains the cursor. The new heading has the same level as the heading of that subtree. If the cursor is not under a heading, the new heading has level 1.
- **Insert subheading**: Opens a new heading at the end of the subtree that contains the cursor. The new heading has one more `#` than the heading of that subtree, to a maximum of 6.
- **Go to heading of this line (org-up-element)**: The same function as `gh`.
- **Toggle indent mode (org-indent-mode)**: Sets [indent mode](#indent-mode) to on or off.

The commands have no default hotkeys. To set a hotkey, open **Settings → Hotkeys**.

The commands operate in all modes, also when Vim mode is off. In Vim normal mode, the insert commands start insert mode.

### Set `Alt-Enter` to insert a heading

In Obsidian, `Alt-Enter` is the default hotkey of **Follow link under cursor**. To use `Alt-Enter` for **Insert heading**, do these steps:

1. Open **Settings → Hotkeys**.
2. In the search field, type "Follow link under cursor".
3. Remove the `Alt-Enter` hotkey from this command.
4. In the search field, type "Insert heading".
5. Set the hotkey of **Insert heading (M-RET in org-mode)** to `Alt-Enter`.

NOTE: To follow links from the keyboard, set a different hotkey for **Follow link under cursor**.

You cannot map `Alt-Enter` in a vimrc file. Obsidian gets its hotkeys before Vim does.

## Indent mode

Indent mode indents the lines of a note by the outline (`org-indent-mode`). It changes only how the editor shows the lines. It does not change the text of the note.

- A heading of level 1 has no indent. A heading of level 2 has an indent of one step. A heading of level 3 has two steps, and so on.
- The lines under a heading have one step more indent than the heading.
- Text before the first heading has no indent.
- Wrapped lines align with the first line.
- List items keep their indent.
- In Live Preview, tables, callouts, and embeds have the same indent as the text around them.

In Live Preview, indent mode shows a bullet in place of the `#` characters of a heading. The bullets are:

| Level | Bullet |
| --- | --- |
| 1 | `◉` |
| 2 | `○` |
| 3 | `✸` |
| 4 | `✿` |

At level 5, the sequence starts again. The bullet is one step wide. Thus, the text of a heading aligns with the lines under it. When the cursor is on a heading, the editor shows the `#` characters in place of the bullet. Source mode does not show bullets.

To set indent mode to on or off, use one of these:

- The **Toggle indent mode (org-indent-mode)** command
- **Settings → Evil Org → Indent mode**

The setting applies to all notes. It stays after you restart Obsidian.

Indent mode operates only in the editor. It does not operate in reading view.

One step is 1.5 times the font size of the editor. To change the step, set the `--evil-org-indent` CSS variable in a [CSS snippet](https://help.obsidian.md/snippets). For example:

```css
.markdown-source-view { --evil-org-indent: 2ch; }
```

### Compact headings

Set **Settings → Evil Org → Compact headings** to on. The editor then shows the headings on consecutive lines, as in org-mode:

- The editor does not show the space above each heading.
- The editor does not show blank lines between a heading and the next heading.
- Blank lines before or after body text still show.
- When the cursor is on a hidden blank line, the line shows.

The text of the note does not change. You can use this setting with or without indent mode.

### Uniform heading size

Set **Settings → Evil Org → Uniform heading size** to on. The editor then shows all headings at the font size and line height of body text, as in org-mode. Headings keep their color and weight. You can use this setting with or without indent mode.

### Hide heading fold arrows

Set **Settings → Evil Org → Hide heading fold arrows** to on. The editor then does not show the fold arrows of headings, as in org-mode.

- To fold and unfold headings, use `Tab` and `Shift-Tab`.
- A folded heading still shows the number of lines in its fold.
- List items keep their fold arrows.

## Meta key

The keys that org-mode binds to Meta (`M-`) use `Alt` by default. To use `Ctrl` instead, set **Settings → Evil Org → Meta key** to **Ctrl**. This changes:

- `Alt-j` / `Alt-k`, which move a subtree, list item, or line, to `Ctrl-j` / `Ctrl-k`.
- `Alt` with `h`, `j`, `k`, `l`, or an arrow, which change a table, to `Ctrl` with the same keys.

The `Alt` keys then do what they did without the plugin. In Vim normal mode, the plugin gets the `Ctrl` keys before Vim and Obsidian do. Thus, Vim's `Ctrl-j` and an Obsidian hotkey on `Ctrl-k` do not operate in Vim normal mode, and in a table the same goes for `Ctrl-h`, `Ctrl-l`, and `Ctrl` with an arrow.

The Obsidian commands keep their names, such as **Move subtree down (M-↓ in org-mode)**.

## Installation

To install the plugin from Obsidian, do these steps:

1. Open **Settings → Community plugins → Browse**.
2. In the search field, type "Evil Org".
3. Select the plugin.
4. Select **Install**.
5. Select **Enable**.

To install the plugin manually, do these steps:

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/spwx/obsidian-evil-org/releases/latest).
2. Put the two files in `<vault>/.obsidian/plugins/evil-org/`.
3. Open **Settings → Community plugins**.
4. Set **Evil Org** to on.

## Compatibility

Obsidian does not have a public API for its Vim mode. Thus, the plugin uses interfaces that Obsidian does not document. An Obsidian update can stop the plugin. When you disable the plugin, Vim goes back to its standard behavior.

In Vim normal mode, the plugin gets `Alt-j` and `Alt-k` (or `Ctrl-j` and `Ctrl-k`, see [Meta key](#meta-key)) before Obsidian does. Thus, an Obsidian hotkey on `Alt-j` or `Alt-k` does not operate in Vim normal mode.

In a table, in Vim normal mode, the plugin gets `Enter`, and `Alt` with `h`, `l`, an arrow, or `Shift`, before Obsidian and Vim do.

In Live Preview, with Vim, the plugin gets a click on a cell of a table before Obsidian's table editor does (see [Tables in Live Preview](#tables-in-live-preview)).

## Development

To change, build, test, or release the plugin, see [DEVELOPMENT.md](DEVELOPMENT.md).

## License

[MIT](LICENSE)
