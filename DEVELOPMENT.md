# Development

For how to use the plugin, see the [README](README.md).

## How the plugin operates

Obsidian does not have a public API for its Vim mode. Thus, the plugin changes the Vim engine at `window.CodeMirrorAdapter.Vim`. The plugin makes these changes:

- **`expandToLine`**: The plugin changes this motion. The motion then includes folded lines. On a table row, a count stops at the last row of the table.
- **`findPosV`**: The plugin wraps this method of the Vim adapter class that the editor uses. In Obsidian, this class is `window.CodeMirrorAdapter`. When a different plugin bundles a Vim engine, such as Vim Motions, it is the class of that engine. With this change, `j` moves past a closed fold in one step. Without it, the first `j` on a folded heading puts the cursor at the end of the heading.
- **Key maps**: The plugin maps `o`, `O`, `p`, `P`, `d`, `>`, `<`, `<A-j>`, `<A-k>`, `ar`, `ir`, `ae`, `ie`, `a|`, `i|`, and `gh`. In visual mode, it also maps `x`, `X`, and `D`. For the table edits, it maps six keys that no key gives, such as `<OrgTableMoveColumnLeft>` (see `TABLE_KEYS`). Only the plugin sends these keys to Vim. Thus, off a table, Vim does not take `Alt-h` or `Alt-Left` from the editor and the Obsidian hotkeys.
- **`Alt-j` and `Alt-k`**: In Vim normal mode, the plugin gets these keys before the editor and the Obsidian hotkeys. It does this in the main window and in pop-out windows. The plugin finds the key by its letter. If the key gives no letter, the plugin uses the key code. On macOS, the Vim mode of Obsidian can lose the Alt modifier. For example, `Option-j` gives `∆`. On a table row, the plugin also gets `Alt` with `h`, `l`, an arrow key, and the `Shift` forms, but only when the main editor has the focus. It sends Vim `<A-j>`, `<A-k>`, or a table key. The action of `<A-j>` and `<A-k>` moves the table row on a table row.
- **`Tab` and `Shift-Tab`**: The plugin adds a key binding to the editor for these keys. In a table, the binding moves between cells in Vim normal mode and insert mode. Elsewhere, it operates only in Vim normal mode.
- **`Enter`**: In a table, in Vim normal mode, the plugin gets this key before Vim, in the same way as `Alt-j`. Vim maps `Enter` to `j^` before the key bindings of the editor see it. The plugin gets the key only when the main editor has the focus, not a cell editor of the Live Preview table. In insert mode, Vim does not use `Enter`, so a key binding of the editor moves to the next row.
- **Tables**: The table helpers are together in `main.js`, after `tableRowRange`. `tableAt` parses the table at a line into rows of cells. `tableCellAt` finds the cell at a position. `tableModel` copies the cells into a model that a command can change. `replaceTable` writes the model back, aligned by `formatTable`, and puts the cursor in a cell, in one undo step. `TABLE_EDITS` has the structure edits. Each edit changes the model for one cell and gives the cell for the cursor, or `null` if it cannot make the change. `tableEdit` does an edit with a count and writes the table back. `tableDeleteRows` deletes rows for the `d` operator, with the rules of `TABLE_EDITS.deleteRow`. `tablePaste` puts the table rows of a register into a table for `p` and `P`. `tableBlock` finds the cells of a visual block. `tableClearBlock` makes them empty for the `d` operator, and `tablePasteCells` puts copied cells into a table for `p` and `P`. `tableClip` keeps the most recent copied cells, so that a paste can find them.
- **Tables in Live Preview**: Live Preview shows a table as a widget, with an editor for each cell. Those editors have no Vim. Obsidian shows a table as text when one of its search highlights touches the table, and it has no other way to show a table as text. Thus, while the cursor or a selection end of Vim is in a table, the plugin puts a search highlight on the line break after the table. At the end of the note, it uses the line break before the table. A line break has no characters, so the highlight shows nothing. The plugin adds and removes the highlight in the transaction that moves the cursor (`showTablesAsText`, a transaction extender). Thus, Obsidian never shows the widget with the cursor in it, which would move the focus into a cell. Obsidian does not export the mark of the highlight or the effects that add and remove highlights. `probeSearchHighlight` gets them: it calls `editor.addHighlights` and keeps the transaction that the method dispatches, without dispatching it. When Obsidian clears its search highlights, the plugin puts its highlight back in the same transaction. A click on a cell of the widget is caught on `pointerdown`, before the widget opens a cell editor, and moves the cursor of Vim to the cell (`handleTableClick`). A click on a link or another control in a cell, or on a drag handle, is left to Obsidian. On unload, the plugin removes its highlights.
- **`pushText`**: The plugin wraps this method of the class of the register controller (`Vim.getRegisterController()`). The yank operator of Vim calls it. In visual block mode in a table, the wrapper changes the text to the text of the cells. The plugin does not replace the yank operator, because Vim does not expose it. Thus, what a Vim engine does around a yank stays the same, such as the yank highlight of Vim Motions.
- **Heading folds**: The plugin gives headings the same fold range as Obsidian. The range goes to the next heading of the same or a higher level, and includes the blank lines before it. This range has priority over the fold ranges of other plugins. For example, Vim Motions ends a heading fold at the last line that is not blank.
- **Code block folds**: Obsidian does not fold fenced code blocks. The plugin adds a fold range for them. The range goes from the end of the opening fence to the end of the closing fence. It is the same range that the CodeMirror Markdown mode gives. Thus, the tests, which use that mode, do not need the plugin's range.
- **Editor view**: The plugin gets the CodeMirror 6 view from `editor.cm`.

CAUTION: Test the plugin after each Obsidian update. Obsidian does not document these interfaces, and an update can stop the plugin.

When the plugin unloads, it must put Vim back to its standard behavior.

## Build and test

The source file is `main.js`. The command `npm run build` only does a syntax check of this file. The build does not change the file. Thus, the released file is identical to the file in the repository.

The end-to-end tests run `main.js` in jsdom, with a real CodeMirror 6 editor and [codemirror-vim](https://github.com/replit/codemirror-vim). To run the tests, use these commands:

```sh
npm install
npm test
```

The tests do not load the CSS or the editor extensions of Obsidian. Thus, do a check of visual and editor changes in Obsidian.

## Release

To make a release, run the release script with the new version number. Do not put a `v` before the number.

```sh
npm run release -- 1.1.3          # test, change the version, commit, and tag
npm run release -- 1.1.3 --push   # do the same steps, then push main and the tag
```

The script stops if one of these conditions is true:

- The working tree has changes that are not committed.
- The current branch is not `main`.
- `main` and `origin/main` have diverged.
- The new version is not more recent than the current version.

The script does these steps:

1. It runs the build and the tests. If they fail, the script stops before it changes a file.
2. It changes `version` in `manifest.json` to the new version.
3. It adds the new version to `versions.json`, with the `minAppVersion` value from `manifest.json`.
4. It makes a commit and a tag.

The commit message opens in `$EDITOR`. The first line is `Bump to <version>`. Add a body that describes the changes. To keep only the first line, add `--no-edit`.

When you push the tag, the Release workflow starts. The workflow does these steps:

1. It runs the tests.
2. It compares the tag with the version in `manifest.json` and in `versions.json`.
3. It makes attestations for `main.js` and `manifest.json`.
4. It publishes the GitHub release.
