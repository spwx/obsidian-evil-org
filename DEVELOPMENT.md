# Development

For how to use the plugin, see the [README](README.md).

## How the plugin operates

Obsidian does not have a public API for its Vim mode. Thus, the plugin changes the Vim engine at `window.CodeMirrorAdapter.Vim`. The plugin makes these changes:

- **`expandToLine`**: The plugin changes this motion. The motion then includes folded lines.
- **`findPosV`**: The plugin wraps this method of the Vim adapter class that the editor uses. In Obsidian, this class is `window.CodeMirrorAdapter`. When a different plugin bundles a Vim engine, such as Vim Motions, it is the class of that engine. With this change, `j` moves past a closed fold in one step. Without it, the first `j` on a folded heading puts the cursor at the end of the heading.
- **Key maps**: The plugin maps `o`, `O`, `p`, `P`, `d`, `>`, `<`, `<A-j>`, `<A-k>`, `ar`, `ir`, `ae`, `ie`, `gh`, `<C-d>`, and `<C-u>`. In visual mode, it also maps `x`, `X`, and `D`. For the moves of `Alt-h`, `Alt-j`, `Alt-k`, and `Alt-l`, it maps four keys that no key gives, such as `<OrgMoveSubtreeDown>` and `<OrgTableMoveColumnLeft>` (see `ALT_VIM_KEYS`). Only the plugin sends these keys to Vim. Thus, off a table, Vim does not take `Alt-h` and `Alt-l` from the editor and the Obsidian hotkeys.
- **`Alt-j` and `Alt-k`**: In Vim normal mode, the plugin gets these keys before the editor and the Obsidian hotkeys. It does this in the main window and in pop-out windows. The plugin finds the key by its letter. If the key gives no letter, the plugin uses the key code. On macOS, the Vim mode of Obsidian can lose the Alt modifier. For example, `Option-j` gives `∆`. It sends Vim `<OrgMoveSubtreeDown>` or `<OrgMoveSubtreeUp>`. On a table row, it also gets `Alt-h` and `Alt-l`, and sends Vim `<OrgTableMoveColumnLeft>` or `<OrgTableMoveColumnRight>` (`moveTableColumn`). `moveSubtree` moves a table row within its table (`moveTableRow`). In the editor of a Live Preview table cell, the plugin gets the four keys before the Vim of the cell and runs Obsidian's table commands, such as `editor:table-row-down` (see `CELL_MOVE_COMMANDS`). Those commands work only in a cell editor, so the main editor uses the plugin's own moves.
- **`Tab` and `Shift-Tab`**: The plugin adds a key binding to the editor for these keys. It operates only in Vim normal mode. Obsidian gives the editor extensions of the plugin to the cell editors of a Live Preview table too. There, the binding leaves the keys to Obsidian, which moves between cells.
- **`Enter`**: On a link and in a list item with a checkbox, in Vim normal mode, the plugin gets this key before Vim, in the same way as `Alt-j`. Vim maps `Enter` to `j^` before the key bindings of the editor see it. The plugin gets the key only when the main editor has the focus, not a cell editor of a Live Preview table.
- **Table cells in Live Preview**: Live Preview shows a table as a widget, with an editor for each cell. Each cell editor has a Vim of its own, over the text of the cell only. In Vim normal mode in a cell editor, the plugin gets the keys of `CELL_NOTE_KEYS`, such as `gg`, `n`, and `Ctrl-o`, before that Vim (`handleCellEscape`). It moves the cursor of the main editor to the same place, gives the main editor the focus, and sends Vim there the keys that are pending in the cell and then the key. The cell editor has its own marks and search, and Obsidian makes a new cell editor when it draws the table again. Thus, the keys use the marks, the search, and the jump list of the main editor. For `m` and a letter, the plugin sets the mark in the main editor, as Vim's `m` does (`vim.marks`, `setBookmark`), and the focus stays in the cell. `Ctrl-d` and `Ctrl-u` find the rows of a table widget from its DOM (`tableWidgetAt`), because CodeMirror puts every position in the widget at the top of the table.
- **Search highlights in tables**: Vim highlights the matches of its search with decorations of the main editor. These do not reach the cells of a Live Preview table widget, which are rendered HTML. The plugin highlights the matches in the cells with the CSS Custom Highlight API (`::highlight(evil-org-search)`, `tableSearchHighlight`). It reads the query from Vim (`vim.searchState_`), and shows the matches only while Vim shows its own (`getOverlay()`).
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
