# Development

For how to use the plugin, see the [README](README.md).

## How the plugin operates

Obsidian does not have a public API for its Vim mode. Thus, the plugin changes the Vim engine at `window.CodeMirrorAdapter.Vim`. The plugin makes these changes:

- **`expandToLine`**: The plugin changes this motion. The motion then includes folded lines.
- **`findPosV`**: The plugin wraps this method of the Vim adapter class that the editor uses. In Obsidian, this class is `window.CodeMirrorAdapter`. When a different plugin bundles a Vim engine, such as Vim Motions, it is the class of that engine. With this change, `j` moves past a closed fold in one step. Without it, the first `j` on a folded heading puts the cursor at the end of the heading.
- **Key maps**: The plugin maps `o`, `O`, `p`, `P`, `d`, `>`, `<`, `<A-j>`, `<A-k>`, `ar`, `ir`, `ae`, `ie`, and `gh`. In visual mode, it also maps `x`, `X`, and `D`.
- **`Alt-j` and `Alt-k`**: In Vim normal mode, the plugin gets these keys before the editor and the Obsidian hotkeys. It does this in the main window and in pop-out windows. The plugin finds the key by its letter. If the key gives no letter, the plugin uses the key code. On macOS, the Vim mode of Obsidian can lose the Alt modifier. For example, `Option-j` gives `∆`.
- **`Tab` and `Shift-Tab`**: The plugin adds a key binding to the editor for these keys. The binding operates only in Vim normal mode.
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
