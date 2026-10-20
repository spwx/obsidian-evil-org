"use strict";

const { Plugin, MarkdownView, PluginSettingTab, Setting, editorLivePreviewField } = require("obsidian");
const { Prec, EditorState, EditorSelection, ChangeSet, StateEffect, StateField } = require("@codemirror/state");
const { keymap, EditorView, ViewPlugin, Decoration, WidgetType } = require("@codemirror/view");
const { invertedEffects } = require("@codemirror/commands");
const { foldable, foldService, foldedRanges, foldEffect, unfoldEffect, indentUnit } = require("@codemirror/language");

// Markdown has six heading levels; a line of seven or more `#`s is body text.
const MAX_LEVEL = 6;
const HEADING_RE = new RegExp(`^(#{1,${MAX_LEVEL}})(\\s|$)`);

function activeEditorView(app) {
  const md = app.workspace.getActiveViewOfType(MarkdownView);
  return md && md.editor ? md.editor.cm : null;
}

// codemirror-vim keeps its CodeMirror 5 adapter at view.cm.
function getVimState(view) {
  const cm = view.cm;
  return (cm && cm.state.vim) || null;
}

// Vim is mid-command: a visual selection, or an operator or keys pending. With
// allowCount, a key buffer holding only digits (a pending count) doesn't count.
function busy(v, allowCount = false) {
  const keys = v.inputState.keyBuffer.join("");
  return !!(v.visualMode || v.inputState.operator || (allowCount ? /\D/.test(keys) : keys !== ""));
}

// Normal mode with nothing pending (but a count, with allowCount).
function normalMode(view, allowCount = false) {
  const v = getVimState(view);
  return !!v && !v.insertMode && !busy(v, allowCount);
}

// Insert mode, with vim.
function insertMode(view) {
  const v = getVimState(view);
  return !!v && !!v.insertMode;
}

// Vim isn't in the middle of anything. Insert mode counts as idle, and so does
// an editor without vim.
function vimIdle(view) {
  const v = getVimState(view);
  return !v || !busy(v);
}

// fn, logging instead of throwing: an exception escaping a keymap, command or
// vim action would abort the key half-way and surface as an Obsidian error.
function guarded(fn) {
  return function (...args) {
    try {
      return fn.apply(this, args);
    } catch (e) {
      console.error("Evil Org:", e);
      return false;
    }
  };
}

function allFolds(state) {
  const out = [];
  const it = foldedRanges(state).iter();
  while (it.value) {
    out.push({ from: it.from, to: it.to });
    it.next();
  }
  return out;
}

const sameRange = (a, b) => a.from === b.from && a.to === b.to;

function isFolded(folds, range) {
  return folds.some((f) => sameRange(f, range));
}

function headingLevel(text) {
  const m = text.match(HEADING_RE);
  return m ? m[1].length : 0;
}

const isBlank = (text) => text.trim() === "";

// One scan of the lines (index n for 1-based line n): `levels` holds each
// line's heading level, 0 for lines that aren't headings, and `code` is true
// for lines in front matter or fenced code blocks, where `#` lines aren't
// headings and `-` lines aren't list items. A fence may sit at any indent, as
// in a list item. As in Obsidian, a `---` on line 1 starts front matter only
// when a closing line follows; an unclosed fence runs to the end of the note.
// `blocks` lists those blocks as their first and last lines, and whether a
// closing line ends them. A Text never changes, so the scan is cached per doc:
// callers ask again freely instead of passing it around. The arrays are
// shared, hence frozen.
const scanCache = new WeakMap();

function scanLines(doc) {
  let scan = scanCache.get(doc);
  if (!scan) scanCache.set(doc, (scan = scanDoc(doc)));
  return scan;
}

function headingLevels(doc) {
  return scanLines(doc).levels;
}

function scanDoc(doc) {
  const levels = [0];
  const code = [false];
  const blocks = [];
  let close = null;
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (close) {
      const block = blocks[blocks.length - 1];
      block.last = i;
      if (close.test(text)) {
        close = null;
        block.closed = true;
      }
      levels.push(0);
      code.push(true);
      continue;
    }
    const fence = text.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fence) close = new RegExp(`^[ \\t]*${fence[1][0]}{${fence[1].length},}\\s*$`);
    else if (i === 1 && text === "---") {
      const end = /^(---|\.\.\.)\s*$/;
      for (let j = 2; j <= doc.lines && !close; j++) if (end.test(doc.line(j).text)) close = end;
    }
    if (close) blocks.push({ first: i, last: i, closed: false });
    levels.push(close ? 0 : headingLevel(text));
    code.push(!!close);
  }
  return { levels: Object.freeze(levels), code: Object.freeze(code), blocks: Object.freeze(blocks.map(Object.freeze)) };
}

// Line n is hidden: a closed fold covers its start.
function lineHidden(doc, folds, n) {
  const pos = doc.line(n).from;
  return folds.some((f) => f.from < pos && f.to >= pos);
}

// The headings org shows in an outline view of lines first..last: a heading
// is shown when it is no deeper than every heading before it, or than floor.
// Floor 0 gives org-overview (the first heading's level, then any shallower
// one), the parent's level + 1 gives org-show-children (the direct children,
// all of them even where the first child is deeper), and MAX_LEVEL gives
// org-content (every heading).
function outlineHeadings(doc, first, last, floor) {
  const levels = headingLevels(doc);
  const out = [];
  let min = Infinity;
  for (let n = first; n <= last; n++) {
    const level = levels[n];
    if (!level) continue;
    if (level <= Math.max(min, floor)) out.push(n);
    min = Math.min(min, level);
  }
  return out;
}

// Folds that hide the text after each shown heading up to the next shown
// heading, or through line last. Where the hidden text is a whole section the
// heading's own fold is used, blank lines before the next heading included;
// elsewhere those blank lines stay visible.
function outlineFolds(state, shown, last) {
  const doc = state.doc;
  const out = [];
  shown.forEach((n, i) => {
    const next = i + 1 < shown.length ? shown[i + 1] : last + 1;
    const line = doc.line(n);
    const section = foldable(state, line.from, line.to);
    if (section && doc.lineAt(section.to).number < next) {
      out.push(section);
      return;
    }
    let end = next - 1;
    while (end > n && isBlank(doc.line(end).text)) end--;
    if (end > n) out.push({ from: line.to, to: doc.line(end).to });
  });
  return out;
}

// Make ranges the heading folds of lines first..last. Other folds there, of
// list items and code blocks, stay as they are, as org's outline cycling
// leaves blocks alone.
function setOutlineFolds(view, first, last, ranges) {
  const doc = view.state.doc;
  const levels = headingLevels(doc);
  const from = doc.line(first).from;
  const to = doc.line(last).to;
  const old = allFolds(view.state).filter((f) => {
    const line = doc.lineAt(f.from);
    return f.from >= from && f.from <= to && levels[line.number] && f.from === line.to;
  });
  const effects = old.filter((f) => !isFolded(ranges, f)).map((f) => unfoldEffect.of(f))
    .concat(ranges.filter((r) => !isFolded(old, r)).map((r) => foldEffect.of(r)));
  if (effects.length > 0) view.dispatch({ effects });
}

// org-cycle and org-global-cycle go on to their next state only when the
// previous command was the same cycle (Emacs' last-command), and otherwise
// start over. A change to the text, the cursor or the folds in between
// counts as another command.
const lastCycles = new WeakMap();

function lastCycle(view, kind) {
  const last = lastCycles.get(view);
  lastCycles.delete(view);
  const state = view.state;
  const same = last && last.kind === kind && last.doc === state.doc
    && last.selection === state.selection && last.folded === foldedRanges(state);
  return same ? last.status : null;
}

function rememberCycle(view, kind, status) {
  const state = view.state;
  lastCycles.set(view, { kind, status, doc: state.doc, selection: state.selection, folded: foldedRanges(state) });
}

// org-cycle on a heading. A folded subtree shows its children, folded
// (CHILDREN), or, with no subheadings, all of it (SUBTREE). Right after
// CHILDREN, the next Tab shows all of the subtree (SUBTREE). Any other time,
// Tab folds the subtree (FOLDED).
function localCycle(view) {
  const state = view.state;
  const doc = state.doc;
  const head = state.selection.main.head;
  const line = doc.lineAt(head);
  const folds = allFolds(state);
  const level = headingLevels(doc)[line.number];
  const own = foldable(state, line.from, line.to);
  const last = lastCycle(view, "local");

  if (level === 0) {
    if (own) {
      const covering = folds.find((f) => f.from <= own.from && f.to >= own.to);
      if (covering) view.dispatch({ effects: [unfoldEffect.of(covering)] });
      else view.dispatch({ effects: [foldEffect.of(own)] });
      return true;
    }
    const covering = folds.find((f) => f.from <= head && f.to >= head);
    if (covering) {
      view.dispatch({ effects: [unfoldEffect.of(covering)] });
      return true;
    }
    return false;
  }

  const covering = folds.find((f) => f.from <= line.from && f.to >= line.to);
  if (covering && !(own && sameRange(covering, own))) {
    view.dispatch({ effects: [unfoldEffect.of(covering)] });
    return true;
  }
  // Nothing under the heading: org's EMPTY ENTRY.
  if (!own) return true;

  const first = line.number + 1;
  const end = doc.lineAt(own.to).number;
  let hidden = true;
  for (let n = first; n <= end && hidden; n++) {
    hidden = isBlank(doc.line(n).text) || lineHidden(doc, folds, n);
  }
  const children = outlineHeadings(doc, first, end, level + 1);
  let status;
  if (hidden && children.length > 0) {
    setOutlineFolds(view, line.number, end, outlineFolds(state, children, end));
    status = "children";
  } else if (hidden || last === "children") {
    setOutlineFolds(view, line.number, end, []);
    status = "subtree";
  } else {
    setOutlineFolds(view, line.number, end, [own]);
    status = "folded";
  }
  rememberCycle(view, "local", status);
  return true;
}

// org-global-cycle. Shift-Tab shows the overview: the first heading and the
// headings after it that are no deeper, each with all under it folded. Right
// after the overview, the next one shows the contents: every heading, with
// only its own text folded. Right after the contents, the next one shows all.
// Text before the first heading stays as it is.
function globalCycle(view) {
  const state = view.state;
  const doc = state.doc;
  const last = lastCycle(view, "global");
  const status = last === "overview" ? "contents" : last === "contents" ? "all" : "overview";
  const first = headingLevels(doc).findIndex((l) => l > 0);
  if (status === "all") {
    const folds = allFolds(state);
    if (folds.length > 0) view.dispatch({ effects: folds.map((f) => unfoldEffect.of(f)) });
  } else if (first > 0) {
    const floor = status === "contents" ? MAX_LEVEL : 0;
    setOutlineFolds(view, first, doc.lines, outlineFolds(state, outlineHeadings(doc, first, doc.lines, floor), doc.lines));
    // Like Emacs, put the cursor on the visible line whose fold hides it.
    const head = view.state.selection.main.head;
    const visible = foldedLineStart(doc, allFolds(view.state), head);
    if (visible !== head) view.dispatch({ selection: { anchor: visible } });
  }
  rememberCycle(view, "global", status);
  return true;
}

function visualLineMode(view) {
  const v = getVimState(view);
  return !!(v && v.visualMode && v.visualLine && !v.visualBlock);
}

// End of the line containing pos, pushed past any closed fold that starts on
// or overlaps it.
function foldedLineEnd(doc, folds, pos) {
  let end = doc.lineAt(pos).to;
  let moved = true;
  while (moved) {
    moved = false;
    for (const f of folds) {
      if (f.from <= end && f.to > end) {
        end = doc.lineAt(f.to).to;
        moved = true;
      }
    }
  }
  return end;
}

// Last line (1-based) of line n and any closed fold that starts on or
// overlaps it.
function foldedLastLine(doc, folds, n) {
  return doc.lineAt(foldedLineEnd(doc, folds, doc.line(n).from)).number;
}

// Start of the line where the outermost closed fold running over pos from
// before it starts; pos itself if there is none. Unlike foldedLineEnd this
// doesn't go to the line boundary on its own: a mouse selection in V mode can
// start mid-line, and orgDelete tests a line's end, not its start.
function foldedLineStart(doc, folds, pos) {
  let start = pos;
  for (const f of folds) if (f.from < pos && f.to >= pos) start = Math.min(start, doc.lineAt(f.from).from);
  return start;
}

// Vim-style V over closed folds: grow the linewise selection so that any fold
// touching its first or last line is selected in full. Taken from vim's own
// selection, not the editor's: some vim builds (Vim Motions') leave only a
// cursor on the head's line in V mode and draw the lines themselves. Null
// unless a fold grows it.
function foldExtendedSelection(view) {
  const vim = getVimState(view);
  if (!vim || !vim.sel) return null;
  const { anchor, head } = vim.sel;
  const doc = view.state.doc;
  const folds = allFolds(view.state);
  // Mid-command, as vim leaves V after a delete, vim.sel can be past the end.
  const line = (n) => doc.line(Math.min(n + 1, doc.lines));
  const first = line(Math.min(anchor.line, head.line));
  const last = line(Math.max(anchor.line, head.line));
  const top = foldedLineStart(doc, folds, first.from);
  const bottom = foldedLineEnd(doc, folds, last.from);
  if (top === first.from && bottom === last.to) return null;
  return head.line < anchor.line ? { anchor: bottom, head: top } : { anchor: top, head: bottom };
}

// codemirror-vim unfolds every fold its selection overlaps once a command
// finishes. In V mode, keep folds that lie entirely inside the selection closed.
function keepSelectedFoldsClosed(tr, app) {
  if (tr.docChanged || tr.selection) return tr;
  if (!tr.effects.some((e) => e.is(unfoldEffect))) return tr;
  const view = activeEditorView(app);
  if (!view || view.state !== tr.startState || !visualLineMode(view)) return tr;
  const sel = tr.startState.selection.main;
  const effects = tr.effects.filter(
    (e) => !(e.is(unfoldEffect) && e.value.from >= sel.from && e.value.to <= sel.to)
  );
  if (effects.length === tr.effects.length) return tr;
  return { effects };
}

// A change that deletes a fold's text drops the fold, and undo only brings
// back the text. Record the dropped folds with the change so undo (and undo
// after redo) re-closes them: `dd` on a folded heading, then `u`, restores it
// folded, as in vim and org.
function deletedFolds(tr) {
  if (!tr.docChanged) return [];
  return allFolds(tr.startState)
    .filter((f) => tr.changes.mapPos(f.from, 1) >= tr.changes.mapPos(f.to, -1))
    .map((f) => foldEffect.of(f));
}

// Last line of the section of the heading on line h: up to the next heading of
// the same or a higher level, with or without trailing blank lines.
function sectionEnd(doc, h, withBlank) {
  const levels = headingLevels(doc);
  let last = h;
  for (let i = h + 1; i <= doc.lines; i++) {
    if (levels[i] && levels[i] <= levels[h]) break;
    if (withBlank || !isBlank(doc.line(i).text)) last = i;
  }
  return last;
}

// A heading's fold, as Obsidian's own: from the end of the heading line to the
// last line before a heading of the same or a higher level, trailing blank
// lines included. Ahead of other fold services, since one that a plugin adds
// may end the fold at the last non-blank line (Vim Motions does), leaving a
// blank line showing under every closed heading.
const headingFolds = Prec.highest(foldService.of((state, from, to) => {
  const doc = state.doc;
  const n = doc.lineAt(from).number;
  if (!headingLevels(doc)[n]) return null;
  const end = doc.line(sectionEnd(doc, n, true)).to;
  return end > to ? { from: to, to: end } : null;
}));

// A fenced code block's fold, as CodeMirror's markdown mode gives it: from the
// end of the opening fence to the end of the block, its closing fence
// included. Obsidian's editor has none, so Tab on a fence would do nothing.
// Front matter is left to Obsidian's properties.
const codeBlockFolds = foldService.of((state, from, to) => {
  const doc = state.doc;
  const n = doc.lineAt(from).number;
  if (!scanLines(doc).code[n] || doc.line(n).text === "---") return null;
  const block = scanLines(doc).blocks.find((b) => b.first === n);
  if (!block || block.last === n) return null;
  const end = doc.line(block.last).to;
  return end > to ? { from: to, to: end } : null;
});

// Fold range for a heading's section: CodeMirror's (Obsidian's) own range,
// or, if that isn't available yet for freshly inserted text, the same range
// computed directly: to the last line before a heading of equal or higher level.
function sectionRange(state, line) {
  const r = foldable(state, line.from, line.to);
  if (r) return r;
  const doc = state.doc;
  if (!headingLevels(doc)[line.number]) return null;
  const end = doc.line(sectionEnd(doc, line.number, true)).to;
  return end > line.to ? { from: line.to, to: end } : null;
}

// org-yank-folded-subtrees: fold ranges for the top-level headings of pasted
// lines first..last (1-based). Like org, only when the paste starts with a
// heading and nothing in it is shallower. A fold may run past the pasted text
// over blank lines only, so a lone pasted heading never swallows the content
// that follows it.
function pastedSubtreeFolds(state, first, last) {
  const doc = state.doc;
  if (first < 1 || first > doc.lines) return [];
  last = Math.min(last, doc.lines);
  const levels = headingLevels(doc);
  const level = levels[first];
  if (!level) return [];
  for (let i = first; i <= last; i++) if (levels[i] && levels[i] < level) return [];
  const end = doc.line(last).to;
  const out = [];
  for (let i = first; i <= last; i++) {
    if (levels[i] !== level) continue;
    const r = sectionRange(state, doc.line(i));
    if (r && (r.to <= end || isBlank(doc.sliceString(end, r.to)))) out.push(r);
  }
  return out;
}

// Close the given ranges, skipping missing ones, ones already closed and ones
// past the end of the doc (a deferred caller's doc may have shrunk since).
function foldRanges(view, ranges) {
  const len = view.state.doc.length;
  const folds = allFolds(view.state);
  const effects = ranges
    .filter((r) => r && r.to <= len && !isFolded(folds, r))
    .sort((a, b) => a.from - b.from)
    .map((r) => foldEffect.of(r));
  if (effects.length > 0) view.dispatch({ effects });
}

// Run fn once codemirror-vim has finished the current command: at the end of
// a command vim applies its own selection and unfolds whatever that selection
// overlaps, which would undo a fold or selection set from inside it. Vim
// finishes synchronously, so a microtask is late enough; unlike setTimeout it
// also runs before the next paint and the next key. The view may be gone by
// then; `destroyed` is EditorView's own (untyped) flag.
function afterVim(view, fn) {
  queueMicrotask(() => {
    if (!view.destroyed) fn();
  });
}

// `dd`, `yy`, `cc`, `>>`, `Y` and counts like `3dd` all use the expandToLine
// motion. Vim treats a closed fold as one line, so a count steps over whole
// folds and the range runs to the end of the last fold it lands on.
// Vim can't hand back a motion it has defined, so this is the stock one,
// copied, for unfolded text and for unload.
const stockExpandToLine = (_cm, head, args) => new head.constructor(head.line + args.repeat - 1, Infinity);

// On a table row a count stops at the table's last row, as one stops at the
// end of the note: `5dd` deletes rows, not the text after the table.
function foldAwareExpandToLine(cm, head, args) {
  const view = cm && cm.cm6;
  const table = view && args.repeat > 1 ? tableAt(view.state.doc, head.line + 1) : null;
  if (table) return new head.constructor(Math.min(head.line + args.repeat, table.last) - 1, Infinity);
  const folds = view ? allFolds(view.state) : [];
  if (folds.length === 0) return stockExpandToLine(cm, head, args);
  const doc = view.state.doc;
  let line = head.line + 1; // CodeMirror 6 lines are 1-based
  for (let i = 0; i < args.repeat; i++) {
    if (i > 0) line = Math.min(line + 1, doc.lines);
    line = foldedLastLine(doc, folds, line);
  }
  return new head.constructor(line - 1, Infinity);
}

// `j`, `gj` and `+` find the line below with the adapter's findPosV, which
// asks CodeMirror's moveVertically. On a closed heading fold that can come
// back short of the line after the fold: at the fold's end, still on the
// heading's screen line, when it looks just below the heading's text and
// finds it still inside the folded line. Vim then puts the cursor at the
// fold's end, or on the hidden line below the heading, and either shows at
// the end of the heading. Whenever the answer doesn't get past a closed fold
// on the cursor's line, go to the first line after the fold, keeping the
// column. (`gj` on a folded heading that wraps skips its other rows too.)
function foldAwareFindPosV(stock) {
  const patched = function (start, amount, unit, goalColumn) {
    const view = this.cm6;
    const folds = view && unit === "line" && amount > 0 ? allFolds(view.state) : [];
    if (folds.length === 0) return stock.call(this, start, amount, unit, goalColumn);
    const doc = view.state.doc;
    const Pos = start.constructor;
    let pos = start;
    for (let i = Math.round(amount); i > 0; i--) {
      const from = this.indexFromPos(pos);
      const end = foldedLineEnd(doc, folds, from);
      const goal = goalColumn ?? this.charCoords(pos, "div").left;
      let next = stock.call(this, pos, 1, unit, goal);
      if (end > doc.lineAt(from).to && end < doc.length && this.indexFromPos(next) <= end) {
        const line = doc.lineAt(end).number; // 1-based, so the next line's 0-based number
        const top = this.charCoords(new Pos(line, 0), "div").top;
        const hit = this.coordsChar({ left: goal, top: top + 1 }, "div");
        next = hit.line === line ? hit : new Pos(line, 0);
      }
      pos = next;
    }
    return pos;
  };
  patched.stock = stock;
  return patched;
}

const firstNonBlank = (text) => text.length - text.trimStart().length;

const posBefore = (a, b) => a.line < b.line || (a.line === b.line && a.ch < b.ch);

// The stock `delete` operator as it runs on CodeMirror 6 (vim's operator
// table isn't exposed, so it can't be wrapped).
function stockDelete(Vim) {
  return function (cm, args, ranges) {
    const vim = cm.state.vim;
    const Pos = ranges[0].anchor.constructor;
    let text, head;
    if (!vim.visualBlock) {
      let from = ranges[0].anchor;
      const to = ranges[0].head;
      // `dd` on the last line also deletes the newline before it.
      if (args.linewise && to.line !== cm.firstLine() && from.line === cm.lastLine() && from.line === to.line - 1) {
        from = from.line === cm.firstLine() ? new Pos(from.line, 0) : new Pos(from.line - 1, cm.getLine(from.line - 1).length);
      }
      text = cm.getRange(from, to);
      cm.replaceRange("", from, to);
      head = args.linewise ? new Pos(from.line, firstNonBlank(cm.getLine(from.line))) : from;
    } else {
      text = cm.getSelection();
      cm.replaceSelections(ranges.map(() => ""));
      const { anchor, head: h } = ranges[0];
      head = posBefore(h, anchor) ? h : anchor;
    }
    Vim.getRegisterController().pushText(args.registerName, "delete", text, args.linewise, vim.visualBlock);
    const line = Math.min(Math.max(cm.firstLine(), head.line), cm.lastLine());
    const maxCh = cm.getLine(line).length - 1 + (vim.insertMode || vim.visualMode ? 1 : 0);
    return new Pos(line, Math.min(Math.max(0, head.ch), maxCh));
  };
}

// First and last (1-based) lines of a linewise operator range. The range may
// end at the start of the line after it, past the end of the note for the last
// line; this compares positions, not offsets, since an offset would clip that
// to the start of an empty last line.
function operatorLines(range) {
  const { anchor, head } = range;
  const [start, end] = posBefore(head, anchor) ? [head, anchor] : [anchor, head];
  const last = end.ch === 0 && end.line > start.line ? end.line - 1 : end.line;
  return { first: start.line + 1, last: last + 1 };
}

// `d` (and `x`, `X`, `D` in visual mode). Vim's linewise delete at the end of
// the note also deletes the newline before the lines, so no empty line is left
// behind; codemirror-vim does this only for a single line, not for a closed
// fold, `3dd` or `Vd`. The cursor goes to the new last line's first non-blank,
// or, if that line is in a closed fold, to the fold's heading so the fold stays
// closed (CodeMirror opens a fold the cursor enters). In a table, line deletes
// delete rows and a visual block blanks cells (see deleteTableRows and
// deleteTableBlock).
function orgDelete(Vim) {
  const stock = stockDelete(Vim);
  return function (cm, args, ranges, oldAnchor) {
    const state = cm.cm6.state;
    const doc = state.doc;
    const { first, last } = operatorLines(ranges[0]);
    const vim = cm.state.vim;
    const table = args.linewise && !vim.visualBlock && ranges.length === 1 && tableRowsDeleted(doc, first, last);
    if (table) return deleteTableRows(Vim, cm, args, table, first, last, oldAnchor);
    const block = vim.visualMode && vim.visualBlock && tableBlock(doc, vim.sel, args.linewise);
    if (block) return deleteTableBlock(Vim, cm, args, block, oldAnchor);
    if (!args.linewise || vim.visualBlock || ranges.length > 1 || first === 1 || last < doc.lines) {
      return stock(cm, args, ranges);
    }
    const prev = doc.line(first - 1); // the line before the deleted ones
    const target = doc.lineAt(foldedLineStart(doc, allFolds(state), prev.to));
    const text = doc.sliceString(doc.line(first).from);
    const Pos = ranges[0].anchor.constructor;
    const lastLine = cm.lastLine();
    cm.replaceRange("", new Pos(prev.number - 1, prev.length), new Pos(lastLine, cm.getLine(lastLine).length));
    Vim.getRegisterController().pushText(args.registerName, "delete", text, true, false);
    const cursor = new Pos(target.number - 1, firstNonBlank(target.text));
    // Leaving visual mode, vim first puts the cursor at the selection's head.
    if (vim.visualMode) vim.sel.head = cursor;
    return cursor;
  };
}

// orgDelete on rows of a table (see tableDeleteRows): the rows go to the
// register linewise, as with any `dd`, so `p` puts them back as rows. Where
// the rows can't be deleted, nothing changes and the cursor stays.
function deleteTableRows(Vim, cm, args, table, first, last, oldAnchor) {
  const view = cm.cm6;
  const Pos = oldAnchor.constructor;
  const at = tableCellAt(view.state.doc, cm.indexFromPos(oldAnchor));
  const text = tableDeleteRows(view, table, first, last, at ? at.col : 0);
  if (text === null) return oldAnchor;
  Vim.getRegisterController().pushText(args.registerName, "delete", text, true, false);
  return tableEditCursor(cm, Pos);
}

// orgDelete on a visual block in a table (see tableClearBlock): the cells go
// to the register blockwise (see tableClip), so `p` puts them back.
function deleteTableBlock(Vim, cm, args, block, oldAnchor) {
  const cells = tableClearBlock(cm.cm6, block);
  if (cells === null) return oldAnchor;
  Vim.getRegisterController().pushText(args.registerName, "delete", clipCells(cells), false, true);
  return tableEditCursor(cm, oldAnchor.constructor);
}

// The cursor a table edit left in the editor, for vim.
function tableEditCursor(cm, Pos) {
  const view = cm.cm6;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const cursor = new Pos(line.number - 1, head - line.from);
  const vim = cm.state.vim;
  // Leaving visual mode, vim first puts the cursor at the selection's head.
  if (vim.visualMode) vim.sel.head = cursor;
  return cursor;
}

// `p`/`P` in normal mode: on a table row, with table rows in the register,
// paste them as rows (tablePaste), and with cells copied from a table, paste
// the cells (tablePasteCells); otherwise vim's paste. Not for the `+`
// register, which vim reads from the clipboard later.
function orgPaste(Vim) {
  return function (cm, args, vim) {
    const register = args.registerName === "+" ? null : Vim.getRegisterController().getRegister(args.registerName);
    if (cm.cm6 && register && register.linewise && !register.blockwise &&
      tablePaste(cm.cm6, register.toString(), args.after, args.repeat || 1)) return;
    const cells = registerCells(register);
    if (cm.cm6 && cells && tablePasteCells(cm.cm6, cells)) return;
    return this.paste(cm, args, vim);
  };
}

// Motion run by `p`/`P` just before the paste action. With a linewise
// register it works out where the pasted lines will land, and once the paste
// has settled folds the pasted subtree (and, for `p`, re-closes the heading it
// was pasted under). Vim puts linewise `p` below a closed fold rather than
// inside it, so `p` first steps to the fold's last line; entering the fold
// opens it (CodeMirror drops folds containing the cursor), hence the re-close.
function pasteMotion(Vim, after) {
  return function (cm, head, args, _vim, inputState) {
    const view = cm && cm.cm6;
    if (!view) return head;
    const register = Vim.getRegisterController().getRegister(inputState && inputState.registerName);
    if (!register || !register.linewise) return head;
    const text = register.toString();
    const count = (text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length) * (args.repeat || 1);
    const doc = view.state.doc;
    const headLine = doc.line(head.line + 1);
    let target = head.line; // 0-based line the paste goes after (p) or before (P)
    if (after) {
      target = foldedLastLine(doc, allFolds(view.state), headLine.number) - 1;
    }
    const first = after ? target + 2 : target + 1; // 1-based, in the new doc
    const reclose = after && target !== head.line ? headLine.from : null;
    afterVim(view, () => {
      const state = view.state;
      const ranges = pastedSubtreeFolds(state, first, first + count - 1);
      // lineAt needs a position inside the doc.
      if (reclose !== null && reclose <= state.doc.length) {
        ranges.push(sectionRange(state, state.doc.lineAt(reclose)));
      }
      foldRanges(view, ranges);
    });
    return target === head.line ? head : new head.constructor(target, head.ch);
  };
}

// The stock `indent` operator as it runs on CodeMirror 6 (vim's operator
// table isn't exposed, so it can't be wrapped): shift the selection vim has
// just set, then go to the first non-blank of the first line. In visual block
// mode, shift the text right of the block's left edge instead, line by line.
function stockIndent(cm, args, ranges) {
  const vim = cm.state.vim;
  const repeat = vim && vim.visualMode ? args.repeat || 1 : 1;
  if (vim && vim.visualBlock) return blockIndent(cm, args, ranges, repeat);
  for (let j = 0; j < repeat; j++) {
    if (args.indentRight) cm.indentMore();
    else cm.indentLess();
  }
  const doc = cm.cm6.state.doc;
  const line = doc.line(operatorLines(ranges[0]).first);
  return new ranges[0].anchor.constructor(line.number - 1, firstNonBlank(line.text));
}

// The stock visual block `>`/`<`: at the block's left edge on each line, insert
// `repeat` indents (a tab, or tabSize spaces), or remove up to that many tabs
// or runs of up to tabSize spaces. The cursor goes to the edge on the top line.
function blockIndent(cm, args, ranges, repeat) {
  const tabSize = cm.getOption("tabSize");
  const indent = cm.getOption("indentWithTabs") ? "\t" : " ".repeat(tabSize);
  const Pos = ranges[0].anchor.constructor;
  let cursor;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { anchor, head } = ranges[i];
    cursor = posBefore(head, anchor) ? head : anchor;
    if (args.indentRight) {
      cm.replaceRange(indent.repeat(repeat), cursor, cursor);
      continue;
    }
    const text = cm.getLine(cursor.line);
    let end = cursor.ch;
    for (let j = 0; j < repeat; j++) {
      if (text[end] === "\t") end++;
      else if (text[end] === " ") {
        const stop = end + indent.length;
        while (end < stop && text[end] === " ") end++;
      } else break;
    }
    cm.replaceRange("", cursor, new Pos(cursor.line, end));
  }
  return cursor;
}

// `>`/`<` (and `>>`, `3<<`, `V>`) on headings: promote/demote instead of
// indenting. expandToLine treats a closed fold as one line, so `>>` on a
// folded heading shifts its whole subtree (org-demote-subtree) and on an open
// one just the heading (org-do-demote). Body lines are left alone, also when
// the range starts on one. A range that starts on a list item shifts items
// with their sub-items (see indentItems); one without headings indents as
// usual, and so does a visual block, which shifts columns, not lines.
function orgIndent(cm, args, ranges) {
  if (cm.state.vim && cm.state.vim.visualBlock) return stockIndent(cm, args, ranges);
  const view = cm.cm6;
  const state = view.state;
  const doc = state.doc;
  const { first, last } = operatorLines(ranges[0]);
  const levels = headingLevels(doc);
  const vim = cm.state.vim;
  const steps = vim && vim.visualMode ? args.repeat || 1 : 1;
  if (!levels[first] && listItem(doc, first)) {
    indentItems(view, first, last, args.indentRight, steps);
    const line = view.state.doc.line(first);
    return new ranges[0].anchor.constructor(first - 1, firstNonBlank(line.text));
  }
  if (!levels.slice(first, last + 1).some(Boolean)) return stockIndent(cm, args, ranges);
  const cursor = new ranges[0].anchor.constructor(first - 1, firstNonBlank(doc.line(first).text));
  // Like org, refuse the whole shift if a heading would go past level 1 or
  // MAX_LEVEL: clamping just that one would flatten the subtree.
  const delta = args.indentRight ? steps : -steps;
  for (let i = first; i <= last; i++) {
    if (levels[i] && (levels[i] + delta < 1 || levels[i] + delta > MAX_LEVEL)) return cursor;
  }
  const folds = allFolds(state);
  const changes = [];
  const closed = [];
  for (let i = first; i <= last; i++) {
    const level = levels[i];
    if (!level) continue;
    const line = doc.line(i);
    if (delta > 0) changes.push({ from: line.from, insert: "#".repeat(delta) });
    else changes.push({ from: line.from, to: line.from - delta });
    closed.push(...folds.filter((f) => f.from === line.to));
  }
  const tr = state.update({ changes, userEvent: "input.indent" });
  view.dispatch(tr);
  // Vim opens folds under the operator's range once it finishes; close them
  // again over the same text. Like org, a promoted heading's fold doesn't grow
  // to take in the sections that are now its children.
  const refold = closed.map((f) => ({ from: tr.changes.mapPos(f.from), to: tr.changes.mapPos(f.to) }));
  if (refold.length > 0) afterVim(view, () => foldRanges(view, refold));
  return cursor;
}

// The heading whose section contains line n, then its ancestors, innermost first.
function enclosingHeadings(doc, n) {
  const levels = headingLevels(doc);
  const out = [];
  let h = n;
  while (h >= 1 && !levels[h]) h--;
  while (h >= 1) {
    out.push(h);
    let p = h - 1;
    while (p >= 1 && !(levels[p] && levels[p] < levels[h])) p--;
    h = p;
  }
  return out;
}

// evil-org's `org-up-element`, for headings: from line n, the heading it is
// under; from a heading, its parent. A count goes up that many levels,
// stopping at the top-level heading. 0 with no heading above.
function upHeading(doc, n, count) {
  const headings = enclosingHeadings(doc, n).filter((h) => h !== n);
  return headings.length ? headings[Math.min(count, headings.length) - 1] : 0;
}

// `gh` motion: see upHeading. With no heading above, the cursor stays.
function upHeadingMotion(cm, head, motionArgs) {
  const h = upHeading(cm.cm6.state.doc, head.line + 1, motionArgs.repeat || 1);
  return h ? { line: h - 1, ch: 0 } : head;
}

// The up-heading command: see upHeading.
function goUpHeading(view) {
  const doc = view.state.doc;
  const h = upHeading(doc, doc.lineAt(view.state.selection.main.head).number, 1);
  if (h) view.dispatch({ selection: { anchor: doc.line(h).from }, scrollIntoView: true });
}

// `ar`/`ir` text objects. `ar` is the subtree of the heading the cursor is
// under, heading included, plus trailing blank lines; `ir` is its body without
// the heading or leading and trailing blank lines. A count, or repeating `ar`
// in visual mode, takes in the enclosing subtrees.
//
// On a Markdown table row they are Vim Motions' table-row text objects
// instead, since vim runs only one mapping per key: `ar` is the whole line,
// `ir` the text between the first and last unescaped pipe, both charwise. The
// row counts as the innermost level: a count of n, or `ar`/`ir` in visual
// mode once the selection already covers the row, goes on to the subtrees as
// a count of n - 1 would.
function subtreeTextObject(cm, head, motionArgs, vim) {
  const doc = cm.cm6.state.doc;
  const inner = !!motionArgs.textObjectInner;
  let skip = 0;
  const row = tableRowRange(doc, head.line + 1, inner);
  if (row) {
    const Pos = head.constructor;
    const from = new Pos(head.line, row.from);
    // In charwise visual mode the head is on the last selected character.
    const to = new Pos(head.line, vim.visualMode ? row.to - 1 : row.to);
    // `ir` on a row with no text between its pipes selects nothing, as in Vim
    // Motions, and counts as covered in visual mode.
    const empty = row.from >= row.to;
    if ((motionArgs.repeat || 1) === 1) {
      if (!empty && !(vim.visualMode && selectionCovers(vim, from, to))) return [from, to];
      if (empty && !vim.visualMode) return null;
    }
    skip = 1;
  }
  const headings = enclosingHeadings(doc, head.line + 1);
  let selFirst = Infinity, selLast = -Infinity;
  if (vim.visualMode) {
    selFirst = Math.min(vim.sel.anchor.line, vim.sel.head.line) + 1;
    selLast = Math.max(vim.sel.anchor.line, vim.sel.head.line) + 1;
  }
  let range = null;
  for (let i = Math.min(Math.max(1, (motionArgs.repeat || 1) - skip), headings.length) - 1; i < headings.length; i++) {
    const h = headings[i];
    let first = inner ? h + 1 : h;
    const last = sectionEnd(doc, h, !inner);
    while (inner && first <= last && isBlank(doc.line(first).text)) first++;
    if (first > last) break;
    range = { first, last };
    if (!(first >= selFirst && last <= selLast)) break;
  }
  if (!range) return null;
  const Pos = head.constructor;
  if (vim.visualMode) vim.visualLine = true;
  else motionArgs.linewise = true;
  return [new Pos(range.first - 1, 0), new Pos(range.last - 1, 0)];
}

// Columns of line n's table row for `ar` (the line) or `ir` (between the
// first and last unescaped pipe), end exclusive; null if line n isn't a table
// row (see tableRow).
function tableRowRange(doc, n, inner) {
  const row = tableRow(doc, n);
  if (!row) return null;
  const { pipes } = row;
  return inner ? { from: pipes[0] + 1, to: pipes[pipes.length - 1] } : { from: 0, to: doc.line(n).length };
}

// `i|`/`a|` text objects: the table cell at the cursor (see tableColumn), as
// in vim-table-mode and Vim Motions. `i|` is the cell's text without its
// padding; `a|` the cell with its padding and the pipe that closes it, so
// `da|` leaves a row with one cell less. A last cell without a closing pipe
// runs to the end of the line. A count takes in that many cells, the first at
// the cursor. On an empty cell `i|` is nothing, but `ci|` still types into it.
function cellTextObject(cm, head, motionArgs, vim, inputState) {
  const doc = cm.cm6.state.doc;
  const row = tableRow(doc, head.line + 1);
  if (!row) return null;
  const text = doc.line(head.line + 1).text;
  const { pipes } = row;
  const first = tableColumn(row, head.ch);
  const last = Math.min(first + (motionArgs.repeat || 1) - 1, row.cells.length - 1);
  const start = pipes[first] + 1;
  let from = start;
  let to = last + 1 < pipes.length ? pipes[last + 1] : text.length;
  if (motionArgs.textObjectInner) {
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
  } else if (last + 1 < pipes.length) {
    to++;
  }
  const Pos = head.constructor;
  if (from >= to) {
    if (vim.visualMode || !inputState || inputState.operator !== "change") return null;
    const at = new Pos(head.line, text[start] === " " ? start + 1 : start);
    return [at, at];
  }
  if (vim.visualMode) vim.visualLine = false;
  // A visual selection includes the character under its head.
  return [new Pos(head.line, from), new Pos(head.line, vim.visualMode ? to - 1 : to)];
}

// Markdown pipe tables, for org's table editor. A table row is a line that
// starts, after any indent, with `|` and has two unescaped pipes, outside
// code blocks and front matter; a table is a run of such lines. A `|` after
// an odd number of backslashes is escaped: it is text in its cell. A
// delimiter row (`| --- | :-: |`) sets the alignment of each column; it holds
// no cells to move to. As in GFM, only a table's first row of delimiter cells
// is its delimiter row: a later one, such as `| - | - |` for missing values,
// is a row of cells like any other. Rows and columns are numbered from 0.
//
// Commands that change a table work on a model of it: a list of rows, each
// { cells, delimiter }, with cells the trimmed text of each cell. They change
// the model and hand it to replaceTable, which writes it back aligned.

// A delimiter cell: dashes, with a colon at either end for the alignment.
const DELIMITER_CELL_RE = /^:?-+:?$/;

// Offsets of the unescaped pipes in text.
function tablePipes(text) {
  const pipes = [];
  for (let i = 0, slashes = 0; i < text.length; i++) {
    if (text[i] === "|" && slashes % 2 === 0) pipes.push(i);
    slashes = text[i] === "\\" ? slashes + 1 : 0;
  }
  return pipes;
}

// The table row a line of text would be, or null: { indent, pipes, cells,
// delimiter }, with delimiter true if every cell is a delimiter cell. Text after the last pipe that isn't blank is one more cell, as
// a row may leave off its closing pipe.
function parseTableRow(text) {
  if (!/^\s*\|/.test(text)) return null;
  const pipes = tablePipes(text);
  if (pipes.length < 2) return null;
  const cells = [];
  for (let i = 1; i < pipes.length; i++) cells.push(text.slice(pipes[i - 1] + 1, pipes[i]).trim());
  const rest = text.slice(pipes[pipes.length - 1] + 1).trim();
  if (rest) cells.push(rest);
  const delimiter = cells.every((c) => DELIMITER_CELL_RE.test(c));
  return { indent: text.slice(0, pipes[0]), pipes, cells, delimiter };
}

// Line n's table row, or null: { line, indent, pipes, cells, delimiter }.
function tableRow(doc, n) {
  const text = doc.line(n).text;
  if (!/^\s*\|/.test(text) || scanLines(doc).code[n]) return null;
  const row = parseTableRow(text);
  return row && { line: n, ...row };
}

// The table that line n is in, or null: its first and last lines and its
// rows (see tableRow). Only the first row of delimiter cells is a delimiter
// row.
function tableAt(doc, n) {
  if (n < 1 || n > doc.lines || !tableRow(doc, n)) return null;
  let first = n;
  let last = n;
  while (first > 1 && tableRow(doc, first - 1)) first--;
  while (last < doc.lines && tableRow(doc, last + 1)) last++;
  const rows = [];
  for (let i = first; i <= last; i++) rows.push(tableRow(doc, i));
  const header = rows.findIndex((r) => r.delimiter);
  for (let i = header + 1; header >= 0 && i < rows.length; i++) rows[i].delimiter = false;
  return { first, last, rows };
}

// The column of a row that offset ch of its line is in. A pipe belongs to
// the cell it closes; text before the first pipe to the first cell, and text
// after the last to the last.
function tableColumn(row, ch) {
  let k = 0;
  while (k < row.pipes.length && row.pipes[k] < ch) k++;
  return Math.max(0, Math.min(k - 1, row.cells.length - 1));
}

// The cell at pos: { table, row, col }, or null outside a table.
function tableCellAt(doc, pos) {
  const line = doc.lineAt(pos);
  const table = tableAt(doc, line.number);
  if (!table) return null;
  const row = line.number - table.first;
  return { table, row, col: tableColumn(table.rows[row], pos - line.from) };
}

// A table's model: a copy of its rows' cells, to change and write back.
function tableModel(table) {
  return table.rows.map((r) => ({ cells: r.cells.slice(), delimiter: r.delimiter }));
}

const tableColumns = (rows) => Math.max(1, ...rows.map((r) => r.cells.length));

// The alignment of each column, from the delimiter row: "left",
// "right", "center", or "" for none.
function tableAlignments(rows, columns) {
  const delimiter = rows.find((r) => r.delimiter);
  return Array.from({ length: columns }, (_, c) => {
    const cell = (delimiter && delimiter.cells[c]) || "";
    const left = cell.startsWith(":");
    const right = cell.length > 1 && cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  });
}

// East Asian wide and fullwidth characters take two columns in a monospace
// font, so they count twice when padding cells.
const WIDE_RE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;

function textWidth(text) {
  let width = 0;
  for (const ch of text) width += WIDE_RE.test(ch) ? 2 : 1;
  return width;
}

// The lines of a table model, aligned (org-table-align): every row gets every
// column, each cell is padded to its column's width with one space on either
// side, so the pipes line up, and a delimiter row's dashes fill the width,
// keeping its colons. Cells are padded by their column's alignment, left if
// it has none. With a delimiter row a column is at least three wide, the
// width of `---`. Also returns where each cell's text starts in its line
// (just inside the padding, for an empty cell).
function formatTable(rows, indent) {
  const columns = tableColumns(rows);
  const align = tableAlignments(rows, columns);
  const min = rows.some((r) => r.delimiter) ? 3 : 1;
  const widths = align.map((_, c) =>
    Math.max(min, ...rows.map((r) => (r.delimiter ? 0 : textWidth(r.cells[c] || "")))));
  const lines = [];
  const starts = [];
  for (const row of rows) {
    let line = indent + "|";
    const rowStarts = [];
    for (let c = 0; c < columns; c++) {
      const w = widths[c];
      let cell;
      if (row.delimiter) {
        const a = align[c];
        cell = (a === "left" || a === "center" ? ":" : "") + "-".repeat(w - (a === "center" ? 2 : a ? 1 : 0)) +
          (a === "right" || a === "center" ? ":" : "");
      } else {
        const text = row.cells[c] || "";
        const pad = w - textWidth(text);
        const before = align[c] === "right" ? pad : align[c] === "center" ? Math.floor(pad / 2) : 0;
        cell = " ".repeat(before) + text + " ".repeat(pad - before);
      }
      rowStarts.push(line.length + 1 + (row.delimiter || !row.cells[c] ? 0 : cell.length - cell.trimStart().length));
      line += ` ${cell} |`;
    }
    lines.push(line);
    starts.push(rowStarts);
  }
  return { lines, starts };
}

// Write a table model in place of table, aligned, and put the cursor at the
// start of the text of cell { row, col } of the model, in one change: one
// `u` undoes it. Lines that don't change aren't touched. The table keeps the
// indent of its first row.
function replaceTable(view, table, rows, target) {
  const doc = view.state.doc;
  const { lines, starts } = formatTable(rows, table.rows[0].indent);
  const changes = [];
  if (lines.length === table.rows.length) {
    lines.forEach((text, i) => {
      const line = doc.line(table.first + i);
      if (line.text !== text) changes.push({ from: line.from, to: line.to, insert: text });
    });
  } else {
    changes.push({ from: doc.line(table.first).from, to: doc.line(table.last).to, insert: lines.join("\n") });
  }
  const set = view.state.changes(changes);
  const row = Math.max(0, Math.min(target.row, lines.length - 1));
  const col = Math.max(0, Math.min(target.col, starts[row].length - 1));
  const anchor = set.apply(doc).line(table.first + row).from + starts[row][col];
  view.dispatch({ changes: set, selection: { anchor }, scrollIntoView: true, userEvent: "input.table" });
  return true;
}

// A new row without text; formatTable gives it every column.
const emptyRow = () => ({ cells: [], delimiter: false });

// org-table-next-field (Tab) and org-table-previous-field (Shift-Tab): align
// the table at the cursor and go to the next or previous cell, row by row,
// past the delimiter row. Tab in the last cell adds an empty row and goes to its
// first cell; Shift-Tab in the first cell stays there. False outside a table.
function tableNextField(view, forward) {
  const cell = tableCellAt(view.state.doc, view.state.selection.main.head);
  if (!cell) return false;
  const rows = tableModel(cell.table);
  const columns = tableColumns(rows);
  let { row, col } = cell;
  do {
    col += forward ? 1 : -1;
    if (col >= columns) [row, col] = [row + 1, 0];
    else if (col < 0) [row, col] = [row - 1, columns - 1];
  } while (row >= 0 && row < rows.length && rows[row].delimiter);
  if (row >= rows.length) rows.push(emptyRow());
  else if (row < 0) ({ row, col } = cell);
  return replaceTable(view, cell.table, rows, { row, col });
}

// org-table-next-row (Enter): align the table at the cursor and go to the
// same column in the next row, past the delimiter row, adding an empty row at
// the end of the table. False outside a table.
function tableNextRow(view) {
  const cell = tableCellAt(view.state.doc, view.state.selection.main.head);
  if (!cell) return false;
  const rows = tableModel(cell.table);
  let row = cell.row + 1;
  while (row < rows.length && rows[row].delimiter) row++;
  if (row >= rows.length) rows.push(emptyRow());
  return replaceTable(view, cell.table, rows, { row, col: cell.col });
}

// The org table structure edits (M-← M-→ M-↑ M-↓ and their Shift forms).
// Each changes a table model in place for the cell at { row, col } and
// returns the cell the cursor goes to, or null, changing nothing, where the
// edit can't be made. Markdown has one header row, right above the
// delimiter row: rows never move across the delimiter row (org won't move one
// past an hline), the delimiter row is neither moved nor deleted, and the
// header is never deleted. New rows go below the header.
const TABLE_EDITS = {
  // org-table-move-column-left/right: the delimiter row's colons move too.
  moveColumnLeft: (rows, at) => tableSwapColumns(rows, at, at.col - 1),
  moveColumnRight: (rows, at) => tableSwapColumns(rows, at, at.col + 1),
  // org-table-move-row-up/down.
  moveRowUp: (rows, at) => tableSwapRows(rows, at, at.row - 1),
  moveRowDown: (rows, at) => tableSwapRows(rows, at, at.row + 1),
  // org-table-delete-column: the last column stays.
  deleteColumn(rows, at) {
    const columns = tableColumns(rows);
    if (columns < 2) return null;
    for (const r of rows) r.cells.splice(at.col, 1);
    return { row: at.row, col: Math.min(at.col, columns - 2) };
  },
  // org-table-insert-column: an empty column left of the cursor's, which the
  // cursor goes to.
  insertColumn(rows, at) {
    for (const r of rows) {
      while (r.cells.length < at.col) r.cells.push("");
      r.cells.splice(at.col, 0, "");
    }
    return at;
  },
  // org-table-kill-row: the cursor goes to the row that takes its place, or
  // to the row above at the end of the table. The last row stays.
  deleteRow(rows, at) {
    const header = tableHeader(rows);
    if (rows.length < 2 || at.row === header || (at.row < header && header === 1)) return null;
    rows.splice(at.row, 1);
    return { row: Math.min(at.row, rows.length - 1), col: at.col };
  },
  // org-table-insert-row: an empty row above the cursor's, which the cursor
  // goes to; in the header or on its delimiter row, the first row below them.
  insertRow(rows, at) {
    const row = Math.max(at.row, tableHeader(rows) + 1);
    rows.splice(row, 0, emptyRow());
    return { row, col: at.col };
  },
};

// The number of header rows: the rows above the delimiter row, or -1
// for a table without one.
const tableHeader = (rows) => rows.findIndex((r) => r.delimiter);

// Swap the cursor's column with column `to`, in every row.
function tableSwapColumns(rows, at, to) {
  const columns = tableColumns(rows);
  if (to < 0 || to >= columns) return null;
  for (const r of rows) {
    while (r.cells.length < columns) r.cells.push("");
    [r.cells[at.col], r.cells[to]] = [r.cells[to], r.cells[at.col]];
  }
  return { row: at.row, col: to };
}

// Swap the cursor's row with row `to`; neither may be a delimiter row.
function tableSwapRows(rows, at, to) {
  if (to < 0 || to >= rows.length || rows[to].delimiter || rows[at.row].delimiter) return null;
  [rows[at.row], rows[to]] = [rows[to], rows[at.row]];
  return { row: to, col: at.col };
}

// `o`/`O` on a table row (evil-org-open-below/above, which call
// org-table-insert-row): an empty row below or above the cursor's, in the
// cursor's column, aligning the table. As with insertRow, the row goes below
// the header and its delimiter row. False outside a table.
function tableOpenRow(view, after) {
  const cell = tableCellAt(view.state.doc, view.state.selection.main.head);
  if (!cell) return false;
  const rows = tableModel(cell.table);
  const row = Math.max(cell.row + (after ? 1 : 0), tableHeader(rows) + 1);
  rows.splice(row, 0, emptyRow());
  return replaceTable(view, cell.table, rows, { row, col: cell.col });
}

// Make a table edit (a key of TABLE_EDITS) `count` times at the cursor, or as
// many times as it can be made, and align the table, in one undo step. False
// outside a table, or if the edit can't be made at all.
function tableEdit(view, name, count = 1) {
  const cell = tableCellAt(view.state.doc, view.state.selection.main.head);
  if (!cell) return false;
  const rows = tableModel(cell.table);
  let at = { row: cell.row, col: cell.col };
  let done = 0;
  for (let next; done < count && (next = TABLE_EDITS[name](rows, at)); done++) at = next;
  return done > 0 && replaceTable(view, cell.table, rows, at);
}

// The table that a linewise delete of lines first..last (1-based) deletes
// rows of, or null: the table holds them all, but they aren't all of it (a
// plain delete then takes the whole table).
function tableRowsDeleted(doc, first, last) {
  const table = tableAt(doc, first);
  return table && last <= table.last && !(first === table.first && last === table.last) ? table : null;
}

// Delete lines first..last (1-based) of table, as `dd`, `3dd`, `dj` or
// `Vjd` do there: by deleteRow's rules, aligning the table, with the cursor
// in column col. Returns the deleted lines' text, or null, changing nothing,
// if a row can't be deleted (the delimiter row or the only header row): a
// delete that would leave a table without its header is refused whole.
function tableDeleteRows(view, table, first, last, col) {
  const doc = view.state.doc;
  const rows = tableModel(table);
  const at = { row: first - table.first, col };
  let target = at;
  for (let n = first; n <= last; n++) {
    target = TABLE_EDITS.deleteRow(rows, at);
    if (!target) return null;
  }
  const text = doc.sliceString(doc.line(first).from, doc.line(last).to) + "\n";
  replaceTable(view, table, rows, target);
  return text;
}

// The table rows that linewise register text holds, or null if a line of it
// isn't a table row. They go below the delimiter row, so none of them is one:
// a copied delimiter row pastes as a row of dashes.
function registerTableRows(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  const rows = lines.map(parseTableRow);
  return rows.every(Boolean) ? rows.map((r) => ({ cells: r.cells, delimiter: false })) : null;
}

// `p`/`P` with table rows in a linewise register, on a table row (org pastes
// rows and aligns): put the rows `count` times below or above the cursor's
// row and align the table, in one undo step. Rows go below the header and
// its delimiter row, as insertRow's do, which keeps the table valid. The
// cursor goes to the first cell of the first pasted row. False outside a
// table, or if a line of text isn't a table row.
function tablePaste(view, text, after, count) {
  const cell = tableCellAt(view.state.doc, view.state.selection.main.head);
  const pasted = cell && registerTableRows(text);
  if (!pasted) return false;
  const rows = tableModel(cell.table);
  const row = Math.max(cell.row + (after ? 1 : 0), tableHeader(rows) + 1);
  for (let i = 0; i < count; i++) rows.splice(row, 0, ...pasted);
  return replaceTable(view, cell.table, rows, { row, col: 0 });
}

// Org's rectangle of cells (org-table-copy-region, -cut-region and
// -paste-rectangle), on a visual block (Ctrl-v): the operation takes the
// whole cells the block's corners are in, not the characters it covers, so
// that it does the same in a table that isn't aligned. The selection isn't
// drawn as cells, since an unaligned table's cells aren't a block of text.
//
// A block: the table that both corners of a visual selection are in, and the
// rows (top..bottom) and columns (left..right) from the cell of one corner to
// that of the other. With toEnd, as for `D`, `X` and `Y`, the columns go to
// the last one. Null unless both corners are in one table.
function tableBlock(doc, sel, toEnd) {
  const offset = (pos) => {
    const line = doc.line(Math.min(pos.line + 1, doc.lines));
    return line.from + Math.min(pos.ch, line.length); // `$` makes ch Infinity
  };
  const a = tableCellAt(doc, offset(sel.anchor));
  const b = tableCellAt(doc, offset(sel.head));
  if (!a || !b || a.table.first !== b.table.first) return null;
  return {
    table: a.table,
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: toEnd ? tableColumns(a.table.rows) - 1 : Math.max(a.col, b.col),
  };
}

// The text of a block's cells, a list per row. Like org, which copies fields
// and not hlines, it leaves out the delimiter row; null if that leaves no row.
function tableBlockCells(block) {
  const { left, right } = block;
  const cells = block.table.rows.slice(block.top, block.bottom + 1).filter((r) => !r.delimiter)
    .map((r) => Array.from({ length: right - left + 1 }, (_, i) => r.cells[left + i] || ""));
  return cells.length > 0 ? cells : null;
}

// The cells last copied or cut (org's org-table-clip), and the text they went
// to the register as: blockwise, a line per row, the cells separated by tabs,
// so that outside a table, or in another program, they paste as columns of
// text. `p` with that text in its register pastes the cells.
let tableClip = null;

function clipCells(cells) {
  tableClip = { text: cells.map((r) => r.join("\t")).join("\n"), cells };
  return tableClip.text;
}

function registerCells(register) {
  return register && register.blockwise && tableClip && register.toString() === tableClip.text ? tableClip.cells : null;
}

// Visual block `d` and `x` in a table (org-table-cut-region): blank the cells
// of block, as org does, rather than delete them, align the table, and put the
// cursor in the first blanked cell, in one undo step. Returns the cells'
// text, or null, changing nothing, if the block spans only the delimiter row.
function tableClearBlock(view, block) {
  const cells = tableBlockCells(block);
  if (!cells) return null;
  const rows = tableModel(block.table);
  let first = -1;
  for (let r = block.top; r <= block.bottom; r++) {
    if (rows[r].delimiter) continue;
    if (first < 0) first = r;
    for (let c = block.left; c <= block.right && c < rows[r].cells.length; c++) rows[r].cells[c] = "";
  }
  replaceTable(view, block.table, rows, { row: first, col: block.left });
  return cells;
}

// `p`/`P` with cells in the register (org-table-paste-rectangle): put them
// into the table over the cells from the cursor's to the right and down, past
// the delimiter row, adding rows and columns where they run past the table, and
// align it, in one undo step. The cursor goes to the first pasted cell. On the
// delimiter row they go from the row below it. False outside a table.
function tablePasteCells(view, cells) {
  const at = tableCellAt(view.state.doc, view.state.selection.main.head);
  if (!at) return false;
  const rows = tableModel(at.table);
  let r = at.row;
  let first = -1;
  for (const pasted of cells) {
    while (r < rows.length && rows[r].delimiter) r++;
    if (r >= rows.length) rows.push(emptyRow());
    if (first < 0) first = r;
    const row = rows[r++];
    while (row.cells.length < at.col) row.cells.push("");
    row.cells.splice(at.col, pasted.length, ...pasted);
  }
  return replaceTable(view, at.table, rows, { row: first, col: at.col });
}

// The cells a visual block yank in a table copies, or null: see
// cellYankPushText. The editor yanking is the active one, still in visual
// block mode while vim pushes the text.
function yankedCells(app, linewise) {
  const view = activeEditorView(app);
  const vim = view && getVimState(view);
  if (!vim || !vim.visualMode || !vim.visualBlock || !vim.sel) return null;
  const block = tableBlock(view.state.doc, vim.sel, linewise);
  return block && tableBlockCells(block);
}

// Visual block `y` and `Y` in a table (org-table-copy-region) copy the cells
// of the block. Vim's own yank runs, so that what an engine does around it,
// such as Vim Motions' yank highlight, still happens; only the text it puts in
// the register is the cells'. The yank operator isn't exposed, so this wraps
// the register controller's pushText, which it calls.
function cellYankPushText(stock, app) {
  const cellsOf = guarded(yankedCells);
  const patched = function (name, operator, text, linewise, blockwise, ...rest) {
    const cells = operator === "yank" && blockwise ? cellsOf(app, linewise) : null;
    if (cells) return stock.call(this, name, operator, clipCells(cells), false, true, ...rest);
    return stock.call(this, name, operator, text, linewise, blockwise, ...rest);
  };
  patched.stock = stock;
  return patched;
}

// The visual selection takes in from..to (to inclusive), or their lines in
// linewise visual mode.
function selectionCovers(vim, from, to) {
  const { anchor, head } = vim.sel;
  const [start, end] = anchor.line < head.line || (anchor.line === head.line && anchor.ch <= head.ch)
    ? [anchor, head] : [head, anchor];
  if (vim.visualLine) return start.line <= from.line && end.line >= to.line;
  return (start.line < from.line || (start.line === from.line && start.ch <= from.ch)) &&
    (end.line > to.line || (end.line === to.line && end.ch >= to.ch));
}

// org-move-subtree-down/up (M-↓/M-↑): swap the subtree under the cursor with
// the next or previous `count` sibling subtrees, keeping the blank lines
// between them where they were and closed folds closed. In a list, swap the
// item the cursor is in, with its sub-items, the same way with its sibling
// items (org-move-item-down/up), and renumber a numbered list. On other lines
// move the line (with the closed fold on it) past `count` lines, a closed fold
// counting as one line.
function moveSubtree(view, forward, count) {
  const state = view.state;
  const doc = state.doc;
  const folds = allFolds(state);
  const kind = blockKind(doc, doc.lineAt(state.selection.main.head).number);
  const n = kind.line;
  const block = [n, blockEnd(doc, folds, kind, n)];
  const siblings = siblingBlocks(doc, folds, kind, block, forward, count);
  if (siblings.length === 0) return false;
  const near = siblings[0];
  const far = siblings[siblings.length - 1];
  // The list keeps the number of its first item.
  const item = kind.item;
  let renumber = null;
  if (item && item.delim) {
    const top = listSpan(doc, folds, item)[0];
    const start = Number(listItem(doc, top).digits);
    renumber = (next) => renumberFrom(next, [], listItem(next, top), top, start);
  }
  if (forward) {
    swapSpans(view, folds, block, [near[0], far[1]], renumber);
  } else {
    // Blank lines just above the block stay where they are, even at the end
    // of a closed fold (so not near[1]).
    let end = n - 1;
    while (end > near[0] && isBlank(doc.line(end).text)) end--;
    swapSpans(view, folds, [far[0], end], block, renumber);
  }
  return true;
}

// What moveSubtree moves from line n, and the line it starts on: a heading's
// subtree ({ level }), the list item n is in ({ item }), or else the line.
function blockKind(doc, n) {
  const level = headingLevels(doc)[n];
  const item = !level && enclosingItem(doc, n);
  return item ? { item, line: item.line } : { level, line: n };
}

// Last line of the block of the given kind that starts on line n: a heading's
// subtree or an item with its sub-items, without trailing blank lines; or the
// line and any closed fold on it.
function blockEnd(doc, folds, kind, n) {
  if (kind.level) return sectionEnd(doc, n, false);
  if (kind.item) return itemEnd(doc, folds, listItem(doc, n));
  return foldedLastLine(doc, folds, n);
}

// Up to count blocks of the given kind beside block ([first, last] lines),
// after it going forward, else before it; nearest first, each [first, last].
function siblingBlocks(doc, folds, kind, block, forward, count) {
  const out = [];
  while (out.length < count) {
    const s = siblingStart(doc, folds, kind, block, forward);
    if (!s) break;
    out.push((block = [s, blockEnd(doc, folds, kind, s)]));
  }
  return out;
}

// First line of the block right after or before block, or 0 if there is none.
// A heading's sibling is the nearest heading of its level or shallower, found
// past blank lines or deeper subtrees, and only if it has the same level. An
// item's is the next or previous item of its list (see siblingItem). A line's
// is the next line, or the previous one with any closed fold over it.
function siblingStart(doc, folds, kind, [first, last], forward) {
  const i = forward ? last + 1 : first - 1;
  if (i < 1 || i > doc.lines) return 0;
  if (kind.item) return siblingItem(doc, kind.item, i, forward);
  if (!kind.level) return forward ? i : doc.lineAt(foldedLineStart(doc, folds, doc.line(i).from)).number;
  const levels = headingLevels(doc);
  let h = i;
  while (h >= 1 && h <= doc.lines && !(levels[h] && levels[h] <= kind.level)) h += forward ? 1 : -1;
  return levels[h] === kind.level ? h : 0;
}

// Swap the line spans upper and lower ([first, last], upper above lower) in
// one change, leaving the text between them in place. The cursor moves with
// its span, and the folds that start in either span are closed again. fix,
// if given, returns more changes to make to the swapped doc in the same step.
function swapSpans(view, folds, upper, lower, fix = null) {
  const state = view.state;
  const doc = state.doc;
  const levels = headingLevels(doc);
  const from = doc.line(upper[0]).from;
  const upperEnd = doc.line(upper[1]).to;
  const lowerStart = doc.line(lower[0]).from;
  const to = doc.line(lower[1]).to;
  const upperText = doc.sliceString(from, upperEnd);
  const gap = doc.sliceString(upperEnd, lowerStart);
  const lowerText = doc.sliceString(lowerStart, to);
  // How far the text at pos moves: the lower span goes to `from`, the upper
  // one after it and the gap.
  const shift = (pos) => (pos <= upperEnd ? lowerText.length + gap.length : from - lowerStart);
  const spanEnd = (pos) => (pos <= upperEnd ? upperEnd : to);
  // Replace through the end of any fold that starts in the range, so every
  // such fold is dropped whole (and restored by undo) and can be re-closed.
  const inside = folds.filter((f) => f.from >= from && f.from <= to);
  const replaceTo = Math.max(to, ...inside.map((f) => f.to));
  const swap = state.changes({ from, to: replaceTo, insert: lowerText + gap + upperText + doc.sliceString(to, replaceTo) });
  const swapped = swap.apply(doc);
  const after = ChangeSet.of(fix ? fix(swapped) : [], swapped.length);
  // Where the text at pos ends up.
  const moved = (pos) => after.mapPos(pos + shift(pos));
  // A heading's fold is recomputed where it lands; any other keeps its text,
  // cut at the end of its span.
  const headingFolds = [];
  const otherFolds = [];
  for (const f of inside) {
    const line = doc.lineAt(f.from);
    if (levels[line.number] && f.from === line.to) headingFolds.push(moved(line.from));
    else otherFolds.push({ from: moved(f.from), to: moved(Math.min(f.to, spanEnd(f.from))) });
  }
  view.dispatch({
    changes: swap.compose(after),
    selection: { anchor: moved(state.selection.main.head) },
    scrollIntoView: true,
    userEvent: "move.line",
  });
  const next = view.state;
  foldRanges(view, [...headingFolds.map((pos) => sectionRange(next, next.doc.lineAt(pos))), ...otherFolds]);
}

// A list item's first line: indent, a bullet (`-`, `*`, `+`) or a number with
// `.` or `)`, then a space or the end of the line, then maybe a checkbox.
const ITEM_RE = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))(?:[ \t]+(\[.\](?=[ \t]|$))?|$)/;
// A thematic break such as `- - -` or `* * *` isn't a list item.
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

// The list item that starts on line n, or null. `content` is where its text
// starts, after the marker, the checkbox and the spaces after them.
function listItem(doc, n) {
  if (scanLines(doc).code[n]) return null;
  const text = doc.line(n).text;
  const m = !RULE_RE.test(text) && text.match(ITEM_RE);
  if (!m) return null;
  const content = m[0].length + firstNonBlank(text.slice(m[0].length));
  return { line: n, indent: m[1], bullet: m[2], digits: m[3], delim: m[4], checkbox: !!m[5], content };
}

// The list item line n is in: the item that starts on it, or the one whose
// indented body or sub-items it is part of. Null on a blank line or outside a
// list.
function enclosingItem(doc, n) {
  return isBlank(doc.line(n).text) ? null : itemAbove(doc, n, Infinity);
}

// The item a sub-item is part of, or null.
function parentItem(doc, item) {
  return itemAbove(doc, item.line - 1, item.indent.length);
}

// The nearest item on line n or above it with an indent less than width,
// looking past blank lines and lines indented deeper. Null at a line without
// indent that isn't an item.
function itemAbove(doc, n, width) {
  for (let i = n; i >= 1; i--) {
    const text = doc.line(i).text;
    if (isBlank(text)) continue;
    const indent = firstNonBlank(text);
    if (indent >= width) continue;
    const item = listItem(doc, i);
    if (item || indent === 0) return item;
    width = indent;
  }
  return null;
}

// Last line of an item: its indented body and sub-items, without trailing
// blank lines, and any closed fold on its first line.
function itemEnd(doc, folds, item) {
  let last = item.line;
  for (let i = item.line + 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (isBlank(text)) continue;
    if (firstNonBlank(text) <= item.indent.length) break;
    last = i;
  }
  return Math.max(last, foldedLastLine(doc, folds, item.line));
}

// Changes that add one to the number of each item of the ordered list `item`
// is in, from the one starting on line n to the end of the list; or, with
// start, that number those items start, start + 1, and so on.
function renumberFrom(doc, folds, item, n, start) {
  const changes = [];
  for (let i = n, k = 0; i <= doc.lines; ) {
    if (isBlank(doc.line(i).text)) {
      i++;
      continue;
    }
    const next = listItem(doc, i);
    if (!next || next.indent !== item.indent || next.delim !== item.delim) break;
    const from = doc.line(i).from + next.indent.length;
    const number = String(start === undefined ? Number(next.digits) + 1 : start + k++);
    if (number !== next.digits) changes.push({ from, to: from + next.digits.length, insert: number });
    i = itemEnd(doc, folds, next) + 1;
  }
  return changes;
}

// A block quote line; a callout is a quote whose first line is `> [!type]`.
const QUOTE_RE = /^[ \t]*>/;
const CALLOUT_RE = /^[ \t]*>[ \t]*\[![^\]]*\]/;

// Items of one list: the same indent and the same bullet or number delimiter.
const sameList = (a, b) => a.indent === b.indent && a.bullet === b.bullet && a.delim === b.delim;

// The line of the first item of `item`'s list from line i on, going forward,
// or back, past blank lines and lines indented deeper; 0 if another line
// comes first.
function siblingItem(doc, item, i, forward) {
  for (; i >= 1 && i <= doc.lines; i += forward ? 1 : -1) {
    const text = doc.line(i).text;
    if (isBlank(text) || firstNonBlank(text) > item.indent.length) continue;
    const other = listItem(doc, i);
    return other && sameList(other, item) ? i : 0;
  }
  return 0;
}

// First and last lines of the list `item` is in: its sibling items and their
// sub-items.
function listSpan(doc, folds, item) {
  let first = item.line;
  for (let s; (s = siblingItem(doc, item, first - 1, false)); ) first = s;
  let last = itemEnd(doc, folds, item);
  for (let s; (s = siblingItem(doc, item, last + 1, true)); ) last = itemEnd(doc, folds, listItem(doc, s));
  return [first, last];
}

// Whether the note's lists are indented with tabs, going by its first
// indented item; null if no item is indented.
function tabbedLists(doc) {
  for (let i = 1; i <= doc.lines; i++) {
    const item = listItem(doc, i);
    if (item && item.indent) return item.indent.includes("\t");
  }
  return null;
}

// The indent `>` gives an item (org-indent-item-tree): that of the sub-items
// of the sibling above it, which it joins; if that sibling has none, a tab
// more than the sibling in a note whose lists use tabs, else spaces up to the
// sibling's text, as Markdown needs for a sub-item. The first item of a list
// has no sibling to go under, so it gets the editor's indent unit, as in vim.
function childIndent(state, doc, folds, item) {
  const tabs = tabbedLists(doc) ?? state.facet(indentUnit) === "\t";
  const s = siblingItem(doc, item, item.line - 1, false);
  if (!s) return item.indent + (tabs ? "\t" : state.facet(indentUnit));
  const prev = listItem(doc, s);
  const end = itemEnd(doc, folds, prev);
  for (let i = s + 1; i <= end; i++) {
    const child = listItem(doc, i);
    if (child) return child.indent;
  }
  if (tabs) return prev.indent + "\t";
  const marker = prev.bullet || prev.digits + prev.delim;
  const gap = firstNonBlank(doc.line(s).text.slice(prev.indent.length + marker.length));
  return prev.indent + " ".repeat(marker.length + (gap >= 1 && gap <= 4 ? gap : 1));
}

// The change that replaces the first `width` characters of whitespace on
// line with indent, touching only the characters that differ.
function reindent(line, width, indent) {
  const end = Math.min(width, firstNonBlank(line.text));
  let i = 0;
  while (i < end && i < indent.length && line.text[i] === indent[i]) i++;
  return { from: line.from + i, to: line.from + end, insert: indent.slice(i) };
}

// One `>` or `<` over the items that start in lines first..last, as changes
// to doc (see indentItems).
function shiftItems(state, doc, folds, first, last, right) {
  const changes = [];
  const lists = []; // lines of items whose numbered lists may change
  // Items at the same indent go to the same indent, so `3>>` over siblings
  // doesn't nest each under the one before it.
  const targets = new Map();
  for (let i = first; i <= last; i++) {
    const item = listItem(doc, i);
    if (!item) continue;
    if (!targets.has(item.indent)) {
      const parent = right ? null : parentItem(doc, item);
      targets.set(item.indent, right ? childIndent(state, doc, folds, item) : parent && parent.indent);
    }
    const indent = targets.get(item.indent);
    if (indent === null) continue;
    const end = itemEnd(doc, folds, item);
    for (let j = i; j <= end; j++) {
      const line = doc.line(j);
      if (!isBlank(line.text)) changes.push(reindent(line, item.indent.length, indent));
    }
    lists.push(i, siblingItem(doc, item, end + 1, true));
    i = end; // its sub-items go with it
  }
  const shift = ChangeSet.of(changes, doc.length);
  const next = shift.apply(doc);
  // Renumber each numbered list an item joined or left. A list keeps the
  // number of its first item if that item was already first; a list that
  // starts at a moved item or at a new first item starts at 1.
  const renumber = [];
  const done = new Set();
  for (const n of lists) {
    const item = n && listItem(next, n);
    if (!item || !item.delim) continue;
    const top = listSpan(next, [], item)[0];
    if (done.has(top)) continue;
    done.add(top);
    const before = listItem(doc, top);
    const kept = before && listSpan(doc, folds, before)[0] === top;
    renumber.push(...renumberFrom(next, [], listItem(next, top), top, kept ? Number(listItem(next, top).digits) : 1));
  }
  return shift.compose(ChangeSet.of(renumber, next.length));
}

// `>`/`<` on list items (org-shiftmetaright/left): indent or outdent each item
// that starts in lines first..last with its body and sub-items, `steps` times.
// `>` puts an item under the sibling above it (see childIndent); `<` makes it
// a sibling of its parent, and an item without a parent stays. Lines that
// aren't in such an item stay, as body lines do for headings. Numbered lists
// are renumbered, closed folds stay closed, and one `u` undoes it all.
function indentItems(view, first, last, right, steps) {
  const state = view.state;
  const folds = allFolds(state);
  let changes = ChangeSet.empty(state.doc.length);
  for (let k = 0; k < steps; k++) {
    const mapped = folds.map((f) => ({ from: changes.mapPos(f.from), to: changes.mapPos(f.to) }));
    changes = changes.compose(shiftItems(state, changes.apply(state.doc), mapped, first, last, right));
  }
  if (changes.empty) return;
  view.dispatch({ changes, userEvent: "input.indent" });
  // Vim opens folds under the operator's range once it finishes; close the
  // ones in the shifted items again.
  const doc = state.doc;
  let end = last;
  for (let i = first; i <= last; i++) {
    const item = listItem(doc, i);
    if (item) end = Math.max(end, itemEnd(doc, folds, item));
  }
  const refold = folds
    .filter((f) => f.from >= doc.line(first).from && f.from <= doc.line(end).to)
    .map((f) => ({ from: changes.mapPos(f.from), to: changes.mapPos(f.to) }));
  if (refold.length > 0) afterVim(view, () => foldRanges(view, refold));
}

// The Markdown elements that contain line n, innermost first, for `ae`/`ie`:
// a code block, front matter, heading line, block quote or paragraph;
// then each list item and list around it; then each subtree around it. Each
// has an `outer` range (its lines and the blank lines after them) and an
// `inner` one: character offsets for an item's or heading's text, else lines;
// null if there is nothing inside. Like org, a blank line is part of the
// element above it. Closed folds count as one line, as for `dd`.
// Obsidian's syntax tree comes from its own line-by-line markdown mode, with
// no nodes for lists, items or quotes, and covers only the parsed part of a
// long note. So this works from the lines, like the other helpers.
function elementsAt(state, n) {
  const doc = state.doc;
  const folds = allFolds(state);
  const { levels, code, blocks } = scanLines(doc);
  let m = n;
  while (m >= 1 && isBlank(doc.line(m).text)) m--;
  if (m < 1) return [];
  const lines = (first, last) =>
    first <= last ? { from: doc.line(first).from, to: doc.line(foldedLastLine(doc, folds, last)).to, linewise: true } : null;
  const chars = (from, to) => (from < to ? { from, to, linewise: false } : null);
  const out = [];
  const add = (first, last, inner) => {
    let end = foldedLastLine(doc, folds, last);
    while (end < doc.lines && isBlank(doc.line(end + 1).text)) end++;
    const outer = lines(first, end);
    const prev = out[out.length - 1];
    if (!prev || !sameRange(prev.outer, outer)) out.push({ outer, inner });
  };
  const text = (i) => doc.line(i).text;
  const block = blocks.find((b) => b.first <= m && m <= b.last);
  let top = m; // the element's first line, where the items around it are found
  if (block) {
    add(block.first, block.last, lines(block.first + 1, block.closed ? block.last - 1 : block.last));
    top = block.first;
  } else if (levels[m]) {
    const line = doc.line(m);
    add(m, m, chars(line.from + line.text.match(/^#+\s*/)[0].length, line.to));
  } else if (QUOTE_RE.test(text(m))) {
    const quote = (i) => !code[i] && QUOTE_RE.test(text(i));
    let last = m;
    while (top > 1 && quote(top - 1)) top--;
    while (last < doc.lines && quote(last + 1)) last++;
    add(top, last, lines(CALLOUT_RE.test(text(top)) ? top + 1 : top, last));
  } else {
    // A paragraph: the lines around m that aren't blank or another element.
    // In a list item, only lines of its body; the lines that go on from the
    // item's first line are the item itself.
    const item = enclosingItem(doc, m);
    const plain = (i) => !isBlank(text(i)) && !code[i] && !levels[i] && !QUOTE_RE.test(text(i)) &&
      !RULE_RE.test(text(i)) && !listItem(doc, i) &&
      (!item || firstNonBlank(text(i)) > item.indent.length);
    let last = m;
    if (plain(m)) {
      while (top > 1 && plain(top - 1)) top--;
      while (last < doc.lines && plain(last + 1)) last++;
    }
    if (!item || (plain(m) && top - 1 !== item.line)) add(top, last, lines(top, last));
  }
  for (let item = levels[m] ? null : enclosingItem(doc, top); item; item = parentItem(doc, item)) {
    const end = itemEnd(doc, folds, item);
    add(item.line, end, chars(doc.line(item.line).from + item.content, doc.line(end).to));
    const [first, last] = listSpan(doc, folds, item);
    add(first, last, lines(first, last));
  }
  for (const h of enclosingHeadings(doc, m)) {
    const last = sectionEnd(doc, h, false);
    let first = h + 1;
    while (first <= last && isBlank(text(first))) first++;
    add(h, last, lines(first, last));
  }
  return out;
}

// `ae`/`ie` text objects (evil-org's `evil-org-an-object` and
// `evil-org-inner-object`): the element at the cursor (see elementsAt), with
// the blank lines after it or just its inside. A count, or repeating the text
// object in visual mode, takes in the enclosing elements.
function elementTextObject(cm, head, motionArgs, vim) {
  const doc = cm.cm6.state.doc;
  const inner = !!motionArgs.textObjectInner;
  const elements = elementsAt(cm.cm6.state, head.line + 1);
  if (elements.length === 0) return null;
  const sel = grownSelection(doc, vim);
  let range = null;
  for (let i = Math.min(motionArgs.repeat || 1, elements.length) - 1; i < elements.length; i++) {
    range = inner ? elements[i].inner : elements[i].outer;
    if (!range || !sel || !(range.from >= sel.from && range.to <= sel.to)) break;
  }
  if (!range) return null;
  const Pos = head.constructor;
  const pos = (offset) => {
    const line = doc.lineAt(offset);
    return new Pos(line.number - 1, offset - line.from);
  };
  if (range.linewise) {
    if (vim.visualMode) vim.visualLine = true;
    else motionArgs.linewise = true;
    return [pos(range.from), new Pos(doc.lineAt(range.to).number - 1, 0)];
  }
  // A visual selection includes the character under its head; an operator's
  // range stops before it.
  if (vim.visualMode) vim.visualLine = false;
  return [pos(range.from), pos(vim.visualMode ? range.to - 1 : range.to)];
}

// The text a visual selection covers, as offsets from its start to the end of
// its last character, or of its last line in V mode. Null outside visual mode
// and for a selection just started with `v` or `V`: `ae` there picks the
// innermost element, and `ae` again (or after another motion) the next one out.
function grownSelection(doc, vim) {
  if (!vim.visualMode) return null;
  const { anchor, head } = vim.sel;
  const single = anchor.line === head.line && (vim.visualLine || anchor.ch === head.ch);
  if (single && vim.lastMotion !== elementTextObject) return null;
  const [start, end] = posBefore(head, anchor) ? [head, anchor] : [anchor, head];
  const from = doc.line(start.line + 1);
  const to = doc.line(end.line + 1);
  if (vim.visualLine) return { from: from.from, to: to.to };
  return { from: from.from + start.ch, to: Math.min(to.from + end.ch + 1, to.to) };
}

// Number of blank lines right above line n.
function blanksAbove(doc, n) {
  let k = 0;
  while (n - k > 1 && isBlank(doc.line(n - k - 1).text)) k++;
  return k;
}

// Where a heading opened after the subtree of the heading on line h goes (h 0:
// after the text before the first heading), as the line it goes below and the
// blank lines above and below it. It keeps the note's spacing: if blank lines
// separate the subtree from the next heading, as many separate the new heading
// from both. At the end of the note it goes after the subtree and any closed
// fold, with as many blank lines above it as heading h has, and blank lines
// at the very end stay at the end.
function headingSlot(doc, folds, h) {
  const levels = headingLevels(doc);
  const first = levels.findIndex((l) => l > 0);
  const end = h ? sectionEnd(doc, h, true) : first > 0 ? first - 1 : doc.lines;
  let last = end;
  while (last > h && isBlank(doc.line(last).text)) last--;
  if (end < doc.lines) return { target: end, above: 0, below: end - last };
  return { target: last ? foldedLastLine(doc, folds, last) : 0, above: h ? blanksAbove(doc, h) : 0, below: 0 };
}

// The change that opens a line holding text below line target (after) or
// above it, with `above` and `below` blank lines around it, and the new line's
// number. It inserts at the start of the line after the new one where
// possible: the end of the line before it may be the end of a closed fold.
function openLineChange(doc, target, after, text, above = 0, below = 0) {
  const newLine = (after ? target + 1 : target) + above;
  const insert = after && target === doc.lines
    ? { from: doc.length, insert: "\n".repeat(1 + above) + text + "\n".repeat(below) }
    : { from: doc.line(after ? target + 1 : target).from, insert: "\n".repeat(above) + text + "\n".repeat(1 + below) };
  return { insert, newLine };
}

// `o`/`O` (evil-org-open-below/above). On a table row, insert an empty row
// below or above it (see tableOpenRow). In a list item, open a new item after
// the item and its sub-items, or before the item: same indent and bullet, the
// next number (numbering the items after it in sequence from it), and an empty
// checkbox if the item has one. On a heading, or in a code block or front
// matter even inside an item, open a plain line, as in vim. On a closed fold
// `o` opens a line below the whole fold, not inside it. Elsewhere `o`/`O` are
// the stock ones. Vim calls actions as methods of its action table, so `this`
// holds the stock actions.
function openLine(cm, args, vim) {
  const view = cm.cm6;
  if (!view) return this.newLineAndEnterInsertMode(cm, args, vim);
  if (tableOpenRow(view, args.after)) {
    const head = tableEditCursor(cm, cm.constructor.Pos);
    return this.enterInsertMode(cm, { repeat: args.repeat, head }, vim);
  }
  const state = view.state;
  const doc = state.doc;
  const folds = allFolds(state);
  const n = doc.lineAt(state.selection.main.head).number;
  const lineText = doc.line(n).text;
  const indent = lineText.slice(0, firstNonBlank(lineText));
  const item = !scanLines(doc).code[n] && enclosingItem(doc, n);
  let target, text;
  let renumber = [];
  if (item) {
    target = args.after ? itemEnd(doc, folds, item) : item.line;
    const number = Number(item.digits) + (args.after ? 1 : 0);
    text = `${item.indent}${item.delim ? number + item.delim : item.bullet} ${item.checkbox ? "[ ] " : ""}`;
    if (item.delim) renumber = renumberFrom(doc, folds, item, args.after ? target + 1 : item.line, number + 1);
  } else {
    target = args.after ? foldedLastLine(doc, folds, n) : n;
    if (target === n) return this.newLineAndEnterInsertMode(cm, args, vim);
    text = indent;
  }
  const { insert, newLine } = openLineChange(doc, target, args.after, text);
  const changes = state.changes([insert, ...renumber]);
  const cursor = changes.apply(doc).line(newLine).from + text.length;
  view.dispatch({ changes, selection: { anchor: cursor }, scrollIntoView: true, userEvent: "input" });
  const head = new cm.constructor.Pos(newLine - 1, text.length);
  this.enterInsertMode(cm, { repeat: args.repeat, head }, vim);
}

// org-insert-heading-respect-content (M-RET) and, with deeper, a subheading:
// open a heading after the subtree the cursor is in, at the same level or one
// deeper. Outside any heading, open a level-1 heading after the text before
// the first heading. In vim normal mode, go on to insert mode, as evil-org
// does.
function insertHeading(view, deeper) {
  const state = view.state;
  const doc = state.doc;
  const h = enclosingHeadings(doc, doc.lineAt(state.selection.main.head).number)[0] || 0;
  const level = h ? Math.min(MAX_LEVEL, headingLevels(doc)[h] + (deeper ? 1 : 0)) : 1;
  const { target, above, below } = headingSlot(doc, allFolds(state), h);
  const { insert, newLine } = openLineChange(doc, target, true, "#".repeat(level) + " ", above, below);
  const changes = state.changes(insert);
  const cursor = changes.apply(doc).line(newLine).to;
  view.dispatch({ changes, selection: { anchor: cursor }, scrollIntoView: true, userEvent: "input" });
  const Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim;
  if (Vim && normalMode(view)) Vim.handleKey(view.cm, "A", "user");
}

// org-indent-mode: each line is indented by its depth in the outline, in
// display only. A heading of level L goes in L - 1 steps and the lines under
// it L steps, so a heading starts where its parent's text does, as org's star
// does. Text before the first heading isn't indented. The step is the CSS
// variable --evil-org-indent, 1.5 editor font sizes unless a snippet sets it.
// The margin goes outside Obsidian's own padding, so list items keep their
// hanging indent, and wrapped lines line up with the first. It is !important
// because Obsidian zeroes the margin of every line with !important. Like
// scanLines, the depths are cached per doc.
const depthCache = new WeakMap();

function indentDepths(doc) {
  let depths = depthCache.get(doc);
  if (depths) return depths;
  const levels = headingLevels(doc);
  depths = new Uint8Array(levels.length);
  let level = 0;
  for (let n = 1; n < levels.length; n++) {
    if (levels[n]) level = levels[n];
    depths[n] = levels[n] ? level - 1 : level;
  }
  depthCache.set(doc, depths);
  return depths;
}

const INDENT_STEP = "var(--evil-org-indent, calc(1.5 * var(--font-text-size, 16px)))";

const indentLines = Array.from({ length: MAX_LEVEL + 1 }, (_, d) => Decoration.line({
  class: "evil-org-indent",
  attributes: { style: `margin-inline-start: calc(${d} * ${INDENT_STEP}) !important` },
}));

// org-bullets: in Live Preview, where Obsidian hides a heading's `#`s, a
// glyph for its level takes their place, one step wide, so the heading's text
// lines up with its body as in org. It is drawn at the size of body text, to
// fit in the step, and goes after the hidden `#`s, so that Obsidian's fold
// arrow at the start of the line doesn't cover it. On a line the selection
// touches, Obsidian shows the `#`s, and the glyph goes away.
const BULLETS = ["◉", "○", "✸", "✿"];

class BulletWidget extends WidgetType {
  constructor(level) {
    super();
    this.level = level;
  }

  eq(other) {
    return other.level === this.level;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "evil-org-bullet";
    span.textContent = BULLETS[(this.level - 1) % BULLETS.length];
    span.style.cssText = `display: inline-block; width: ${INDENT_STEP}; text-indent: 0; font-size: var(--font-text-size, 16px);`;
    return span;
  }
}

const bullets = Array.from({ length: MAX_LEVEL + 1 }, (_, level) =>
  Decoration.widget({ widget: new BulletWidget(level), side: -1 }));

// Live Preview draws a table as a widget whose cells are editors of their
// own, without vim: there `u`, `gg` or `V` would be typed into the cell. So
// while vim's cursor or selection is in a table, the table is shown as text,
// as in Source mode, and every vim key works on it. Obsidian has no switch
// for this, but it draws a table as text when one of its search highlights
// touches it. The plugin puts such a highlight on the line break after the
// table (before it, at the end of the note), where it colours nothing.
// Obsidian doesn't export the highlight's mark or the effects that add and
// filter highlights; probeSearchHighlight finds them.
const SEARCH_HIGHLIGHT = "obsidian-search-match-highlight";
let searchHighlight = null;

// Ask Obsidian's editor to add a search highlight, and keep the transaction
// it would dispatch instead of dispatching it: its effects are the filter (of
// the old highlights) and the add, whose range carries the mark.
function probeSearchHighlight(editor) {
  if (searchHighlight || !editor || typeof editor.addHighlights !== "function") return;
  const view = editor.cm;
  if (!view || view.state.doc.length === 0) return;
  const own = Object.prototype.hasOwnProperty.call(view, "dispatch") ? view.dispatch : null;
  let spec = null;
  view.dispatch = (s) => { spec = s; };
  try {
    const all = { from: editor.offsetToPos(0), to: editor.offsetToPos(view.state.doc.length) };
    editor.addHighlights([all], SEARCH_HIGHLIGHT, true, false);
  } finally {
    if (own) view.dispatch = own;
    else delete view.dispatch;
  }
  const [filter, add] = (spec && spec.effects) || [];
  const range = add && Array.isArray(add.value) && add.value[0];
  if (!(filter instanceof StateEffect) || !range || !(range.value instanceof Decoration)) return;
  searchHighlight = { filter: filter.type, add: add.type, mark: range.value };
}

// The line breaks the plugin has highlighted, mapped as Obsidian maps the
// highlights, so it can take them off again.
const setTableBreaks = StateEffect.define();
const tableBreaksField = StateField.define({
  create: () => [],
  update(breaks, tr) {
    for (const e of tr.effects) if (e.is(setTableBreaks)) return e.value;
    return tr.docChanged ? mapBreaks(breaks, tr.changes) : breaks;
  },
});

function mapBreaks(breaks, changes) {
  return breaks
    .map((r) => ({ from: changes.mapPos(r.from, 1), to: changes.mapPos(r.to, -1) }))
    .filter((r) => r.from < r.to);
}

// The line break next to the table at pos, or null (also for a table that is
// the whole note).
function tableBreak(doc, pos) {
  const table = tableAt(doc, doc.lineAt(pos).number);
  if (!table) return null;
  if (table.last < doc.lines) {
    const to = doc.line(table.last).to;
    return { from: to, to: to + 1 };
  }
  if (table.first === 1) return null;
  const from = doc.line(table.first).from;
  return { from: from - 1, to: from };
}

// The line breaks of the tables that the selection's ends are in.
function tableBreaks(doc, selection) {
  const breaks = [];
  for (const r of selection.ranges) {
    for (const pos of [r.anchor, r.head]) {
      const b = tableBreak(doc, pos);
      if (b && !breaks.some((o) => o.from === b.from)) breaks.push(b);
    }
  }
  return breaks.sort((a, b) => a.from - b.from);
}

const sameBreaks = (a, b) => a.length === b.length && a.every((r, i) => r.from === b[i].from && r.to === b[i].to);

// A highlight the plugin may have put: one line break next to a table line.
function isTableBreak(doc, from, to) {
  if (to - from !== 1 || doc.sliceString(from, to) !== "\n") return false;
  const n = doc.lineAt(from).number;
  return !!(tableRow(doc, n) || (n < doc.lines && tableRow(doc, n + 1)));
}

// Highlight the line breaks of the tables the selection is in, and take the
// highlight off a table the selection leaves. Done in the transaction that
// moves the selection, so Obsidian never draws the widget with the cursor in
// it (it would focus a cell). In Source mode the highlights do nothing.
function showTablesAsText(enabled) {
  return [
    tableBreaksField,
    EditorState.transactionExtender.of((tr) => {
      const hl = searchHighlight;
      if (!hl) return null;
      const old = mapBreaks(tr.startState.field(tableBreaksField, false) || [], tr.changes);
      const want = enabled() ? tableBreaks(tr.newDoc, tr.newSelection) : [];
      // Clearing Obsidian's search highlights may clear these too.
      const cleared = tr.effects.some((e) => e.is(hl.filter));
      if (!cleared && sameBreaks(old, want)) return null;
      return {
        effects: [
          hl.filter.of((from, to, value) => value !== hl.mark || !old.some((r) => r.from === from && r.to === to)),
          hl.add.of(want.map((r) => hl.mark.range(r.from, r.to))),
          setTableBreaks.of(want),
        ],
      };
    }),
  ];
}

// The line breaks highlighted once tr is applied: those the transaction sets,
// or the old ones mapped through its changes.
function tableBreaksAfter(tr) {
  for (const e of tr.effects) if (e.is(setTableBreaks)) return e.value;
  return mapBreaks(tr.startState.field(tableBreaksField, false) || [], tr.changes);
}

// Obsidian's table widget follows the note's selection: a cursor that lands
// in its table but in no cell, as on the delimiter row, it moves a moment
// later to the first cell (coming from above) or the last (from below). The
// widget lives on while its table is shown as text, and still does this, so
// `k` onto the delimiter row ended on the table's last row. While its table
// is shown as text the widget ignores the selection. Obsidian doesn't export
// the widget's class; it is found from a widget drawn in an editor.
let tableWidgetPatched = false;

function patchTableWidget(view, restorers) {
  if (tableWidgetPatched) return;
  const el = view.contentDOM.querySelector(".cm-table-widget");
  const tile = el && (el.cmTile || el.cmView);
  let proto = tile && tile.widget && Object.getPrototypeOf(tile.widget);
  while (proto && !Object.hasOwn(proto, "receiveSelection")) proto = Object.getPrototypeOf(proto);
  if (!proto || typeof proto.receiveSelection !== "function") return;
  const stock = proto.receiveSelection;
  proto.receiveSelection = function (tr) {
    if (tr && typeof this.start === "number" && this.start <= tr.newDoc.length) {
      const b = tableBreak(tr.newDoc, this.start);
      if (b && tableBreaksAfter(tr).some((r) => r.from === b.from)) return;
    }
    return stock.call(this, tr);
  };
  tableWidgetPatched = true;
  restorers.push(() => {
    proto.receiveSelection = stock;
    tableWidgetPatched = false;
  });
}

// The offset of the text of a table's cell, given its row and column as the
// widget draws them: the widget leaves out the delimiter row. An empty cell
// gives the offset after its padding space.
function widgetCellPos(doc, table, row, col) {
  const r = table.rows.filter((r) => !r.delimiter)[row];
  if (!r) return null;
  const line = doc.line(r.line);
  const c = Math.min(col, r.cells.length - 1);
  const start = r.pipes[c] + 1;
  const end = c + 1 < r.pipes.length ? r.pipes[c + 1] : line.text.length;
  let ch = start;
  while (ch < end && line.text[ch] === " ") ch++;
  if (ch === end) ch = Math.min(start + 1, end);
  return line.from + ch;
}

// Obsidian's flag for Live Preview, absent outside Obsidian (and in tests
// that don't add it): then the editor counts as Source mode.
function livePreview(state) {
  return !!(editorLivePreviewField && state.field(editorLivePreviewField, false));
}

function touchesSelection(state, line) {
  return state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
}

// The lines of the visible ranges, each once: two ranges share a line when a
// fold starts and ends inside it.
function visibleLines(view) {
  const doc = view.state.doc;
  const lines = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      if (!lines.length || lines[lines.length - 1].number < line.number) lines.push(line);
      pos = line.to + 1;
    }
  }
  return lines;
}

function indentDecorations(view) {
  const state = view.state;
  const depths = indentDepths(state.doc);
  const levels = headingLevels(state.doc);
  const preview = livePreview(state);
  const out = [];
  for (const line of visibleLines(view)) {
    if (depths[line.number]) out.push(indentLines[depths[line.number]].range(line.from));
    const level = levels[line.number];
    if (level && preview && !touchesSelection(state, line)) out.push(bullets[level].range(line.from + line.text.match(/^#+\s*/)[0].length));
  }
  return Decoration.set(out, true);
}

// Live Preview draws tables, callouts and embeds as block widgets, not lines,
// so the line decorations don't reach them. Their own element takes the
// indent of the line where they start. Obsidian gives a table a margin of
// its own, which the indent goes on top of. CodeMirror ignores changes made
// inside a widget, so this doesn't disturb the editor.
function indentBlocks(view) {
  const doc = view.state.doc;
  const depths = indentDepths(doc);
  for (const el of view.contentDOM.children) {
    if (!el.classList.contains("cm-embed-block")) continue;
    let pos;
    try {
      pos = view.posAtDOM(el);
    } catch {
      continue;
    }
    const depth = pos <= doc.length ? depths[doc.lineAt(pos).number] : 0;
    const base = el.classList.contains("cm-table-widget") ? " - var(--size-4-4)" : "";
    const margin = depth ? `calc(${depth} * ${INDENT_STEP}${base})` : "";
    const priority = depth ? "important" : "";
    // This runs on every geometry change; write only what differs, since
    // each write is a style mutation.
    if (el.style.getPropertyValue("margin-inline-start") === margin &&
        el.style.getPropertyPriority("margin-inline-start") === priority) continue;
    if (depth) el.style.setProperty("margin-inline-start", margin, priority);
    else el.style.removeProperty("margin-inline-start");
  }
}

function unindentBlocks(view) {
  for (const el of view.contentDOM.children) {
    if (el.classList.contains("cm-embed-block")) el.style.removeProperty("margin-inline-start");
  }
}

const indentMode = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.decorations = indentDecorations(view);
    // A measure already queued still runs after destroy; it mustn't
    // indent the widgets again.
    this.measure = { read: () => null, write: () => this.destroyed || indentBlocks(view) };
    view.requestMeasure(this.measure);
  }

  update(update) {
    const preview = livePreview(update.state) !== livePreview(update.startState);
    if (update.docChanged || update.viewportChanged || update.selectionSet || preview) {
      this.decorations = indentDecorations(update.view);
    }
    // The widgets are drawn after this, so they're indented in the measure
    // phase that follows.
    if (update.docChanged || update.viewportChanged || update.geometryChanged || preview) {
      update.view.requestMeasure(this.measure);
    }
  }

  // Turning the mode off destroys the plugin; the widgets stay.
  destroy() {
    this.destroyed = true;
    unindentBlocks(this.view);
  }
}, { decorations: (p) => p.decorations });

// Hide heading fold arrows: org shows none, and with indent mode the bullets
// mark the headings; a folded heading still ends in Obsidian's line count.
// This and the settings' other styles are themes, not base themes: a
// theme's rules hold only in editors that have it, while a base theme's stay
// in force once mounted, so turning the setting off wouldn't undo them.
const hideFoldArrows = EditorView.theme({
  "& .HyperMD-header .cm-fold-indicator": { display: "none !important" },
});

// Compact headings: without the space Obsidian puts above each heading, and
// without the blank lines between one heading and the next, the headings of
// an outline sit on consecutive lines, as in org. Blank lines next to body
// text stay. A blank line the selection touches shows, so the cursor on it
// can be seen. Which blank lines sit between headings is worked out once per
// doc, cached like scanLines: a blank line outside code whose nearest
// non-blank lines above and below are both headings.
const blankCache = new WeakMap();

function compactableBlanks(doc) {
  let blanks = blankCache.get(doc);
  if (blanks) return blanks;
  const { levels, code } = scanLines(doc);
  blanks = new Uint8Array(doc.lines + 1);
  let above = 0;
  for (let n = 1; n <= doc.lines; n++) {
    if (isBlank(doc.line(n).text)) continue;
    if (levels[above] && levels[n]) for (let b = above + 1; b < n; b++) blanks[b] = code[b] ? 0 : 1;
    above = n;
  }
  blankCache.set(doc, blanks);
  return blanks;
}

function compactBlanks(view) {
  const state = view.state;
  const blanks = compactableBlanks(state.doc);
  const out = [];
  for (const line of visibleLines(view)) {
    if (blanks[line.number] && !touchesSelection(state, line)) out.push(hiddenBlank.range(line.from));
  }
  return Decoration.set(out);
}

const hiddenBlank = Decoration.line({ class: "evil-org-hidden-blank" });

const compactHeadings = [
  EditorView.theme({
    "& .cm-line.HyperMD-header": { paddingTop: "0 !important" },
    "& .cm-line.evil-org-hidden-blank": { height: "0", padding: "0 !important", overflow: "hidden" },
  }),
  ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = compactBlanks(view);
    }

    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = compactBlanks(update.view);
      }
    }
  }, { decorations: (p) => p.decorations }),
];

// Uniform heading size: every heading at the size and line height of body
// text, as in org, where only the color and weight set a headline apart.
// The text in a heading line inherits the line's size.
const uniformHeadings = EditorView.theme({
  "& .cm-line.HyperMD-header": { fontSize: "inherit !important", lineHeight: "var(--line-height-normal) !important" },
});

const DEFAULT_SETTINGS = { indent: false, compactHeadings: false, uniformHeadings: false, hideFoldArrows: false };

class EvilOrgSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Indent mode")
      .setDesc("Indent the text under each heading by its level, in display only, as org-indent-mode does.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.indent)
        .onChange((on) => this.plugin.setSetting("indent", on)));
    new Setting(this.containerEl)
      .setName("Compact headings")
      .setDesc("Remove the space above headings in the editor, and hide the blank lines between one heading and the next, so that the headings of an outline are on consecutive lines, as in org-mode.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.compactHeadings)
        .onChange((on) => this.plugin.setSetting("compactHeadings", on)));
    new Setting(this.containerEl)
      .setName("Uniform heading size")
      .setDesc("Show all headings in the editor at the font size of body text, as in org-mode.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.uniformHeadings)
        .onChange((on) => this.plugin.setSetting("uniformHeadings", on)));
    new Setting(this.containerEl)
      .setName("Hide heading fold arrows")
      .setDesc("Hide the fold arrows of headings in the editor, as org-mode shows none. Tab and Shift-Tab still fold. List items keep their arrows.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.hideFoldArrows)
        .onChange((on) => this.plugin.setSetting("hideFoldArrows", on)));
  }
}

// The letters of the Alt keys handleAltMove catches, by key code, for when
// the key isn't a letter (macOS Option-j is `∆`), and the arrow keys that
// stand for the same letters in a table (M-← is M-h, as in evil-org).
const ALT_CODES = { KeyH: "h", KeyJ: "j", KeyK: "k", KeyL: "l" };
const ALT_ARROWS = { ArrowLeft: "h", ArrowDown: "j", ArrowUp: "k", ArrowRight: "l" };

// The table edits of M-h, M-l and the Shift forms (M-S-h is "H"), by letter.
// Vim gets them as keys of their own, which no keydown gives, so that off a
// table these Alt keys still reach vim, the editor and the hotkeys as before.
// In a table M-j/M-k are <A-j>/<A-k>, which move the row there.
const TABLE_KEYS = {
  h: "moveColumnLeft", l: "moveColumnRight",
  H: "deleteColumn", L: "insertColumn", K: "deleteRow", J: "insertRow",
};
const tableVimKey = (edit) => `<OrgTable${edit[0].toUpperCase()}${edit.slice(1)}>`;

// Command ids and names are user-facing: hotkeys are bound to the ids.
const COMMANDS = [
  ["cycle-local", "Cycle fold under cursor (TAB in org-mode)", localCycle],
  ["cycle-global", "Cycle global fold overview (S-TAB in org-mode)", globalCycle],
  ["move-subtree-down", "Move subtree down (M-↓ in org-mode)", (view) => moveSubtree(view, true, 1)],
  ["move-subtree-up", "Move subtree up (M-↑ in org-mode)", (view) => moveSubtree(view, false, 1)],
  ["insert-heading", "Insert heading (M-RET in org-mode)", (view) => insertHeading(view, false)],
  ["insert-subheading", "Insert subheading", (view) => insertHeading(view, true)],
  ["up-heading", "Go to heading of this line (org-up-element)", goUpHeading],
];

module.exports = class EvilOrgPlugin extends Plugin {
  installVimOverrides() {
    const Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim;
    if (!Vim) return;
    // Obsidian's adapter class even before an editor shows up, and the class
    // of the active editor's adapter, which may be another.
    if (typeof window.CodeMirrorAdapter === "function") this.patchFindPosV(window.CodeMirrorAdapter.prototype);
    const view = activeEditorView(this.app);
    if (view) this.patchFindPosV(view.cm);
    const md = this.app.workspace.getActiveViewOfType(MarkdownView);
    guarded(probeSearchHighlight)(md && md.editor);
    if (Vim === this.patchedVim) return;
    // Every engine patched keeps the overrides until unload, not just the
    // current one. The engine counts as patched and its restorer is queued
    // before any override, so if one throws (say, after an update changes
    // vim's API) those already made are still undone on unload, and the next
    // leaf change doesn't try again. Undoing an override never made is
    // harmless.
    this.patchedVim = Vim;
    (this.vimRestorers ||= []).push(guarded(() => {
      Vim.defineMotion("expandToLine", stockExpandToLine);
      Vim.defineAction("orgMoveSubtree", () => {});
      Vim.defineAction("orgTableEdit", () => {});
      Vim.defineMotion("orgSubtree", () => null);
      Vim.defineMotion("orgCell", () => null);
      Vim.defineMotion("orgElement", () => null);
      Vim.defineMotion("orgUpHeading", (_cm, head) => head);
      Vim.defineAction("orgOpenLine", function (cm, args, vim) {
        return this.newLineAndEnterInsertMode(cm, args, vim);
      });
      // Keymap entries can't be removed, so make them behave like the stock ones.
      Vim.defineMotion("orgPasteAfter", (_cm, head) => head);
      Vim.defineMotion("orgPasteBefore", (_cm, head) => head);
      Vim.defineAction("orgPaste", function (cm, args, vim) {
        return this.paste(cm, args, vim);
      });
      Vim.defineOperator("orgIndent", stockIndent);
      Vim.defineOperator("orgDelete", stockDelete(Vim));
    }));
    // Alt-j/Alt-k go to vim only once its <A-j>/<A-k> mappings are in place.
    this.altMoveVim = guarded(() => this.overrideVim(Vim))() === false ? null : Vim;
  }

  // The overrides installVimOverrides makes on one Vim engine.
  overrideVim(Vim) {
    Vim.defineMotion("expandToLine", foldAwareExpandToLine);
    // A command's motion runs before its action; these entries shadow the
    // stock `p`/`P` in normal mode (visual-mode paste is untouched). On a
    // table row, orgPaste pastes table rows as rows of the table.
    Vim.defineMotion("orgPasteAfter", pasteMotion(Vim, true));
    Vim.defineMotion("orgPasteBefore", pasteMotion(Vim, false));
    Vim.defineAction("orgPaste", guarded(orgPaste(Vim)));
    Vim.mapCommand("p", "action", "orgPaste", { after: true, isEdit: true },
      { isEdit: true, context: "normal", motion: "orgPasteAfter" });
    Vim.mapCommand("P", "action", "orgPaste", { after: false, isEdit: true },
      { isEdit: true, context: "normal", motion: "orgPasteBefore" });
    // `>`/`<` shadow the stock indent operator; doubled (`>>`) they still
    // pair up, since vim matches operators by name.
    Vim.defineOperator("orgIndent", orgIndent);
    Vim.mapCommand(">", "operator", "orgIndent", { indentRight: true });
    Vim.mapCommand("<", "operator", "orgIndent", { indentRight: false });
    // `d` shadows the stock delete operator the same way. In visual mode `x`,
    // `X` and `D` delete with it too.
    Vim.defineOperator("orgDelete", orgDelete(Vim));
    Vim.mapCommand("d", "operator", "orgDelete", {});
    Vim.mapCommand("D", "operator", "orgDelete", { linewise: true }, { context: "visual" });
    for (const [key, forward, visualLine] of [["x", true, false], ["X", false, true]]) {
      Vim.mapCommand(key, "operatorMotion", null, undefined, {
        operator: "orgDelete", motion: "moveByCharacters", motionArgs: { forward },
        operatorMotionArgs: { visualLine }, context: "visual",
      });
    }
    // M-j / M-k move the subtree (M-↓ / M-↑ in org-mode), or in a table the
    // row. On macOS vim reads Option-j as <A-j> too.
    Vim.defineAction("orgMoveSubtree", guarded((cm, args) => {
      const view = cm.cm6;
      if (!view) return;
      const count = args.repeat || 1;
      if (tableCellAt(view.state.doc, view.state.selection.main.head)) {
        tableEdit(view, args.forward ? "moveRowDown" : "moveRowUp", count);
      } else {
        moveSubtree(view, args.forward, count);
      }
    }));
    Vim.mapCommand("<A-j>", "action", "orgMoveSubtree", { forward: true }, { context: "normal", isEdit: true });
    Vim.mapCommand("<A-k>", "action", "orgMoveSubtree", { forward: false }, { context: "normal", isEdit: true });
    // The other table edits, on keys only handleAltMove gives vim.
    Vim.defineAction("orgTableEdit", guarded((cm, args) => {
      if (cm.cm6) tableEdit(cm.cm6, args.edit, args.repeat || 1);
    }));
    for (const edit of Object.values(TABLE_KEYS)) {
      Vim.mapCommand(tableVimKey(edit), "action", "orgTableEdit", { edit }, { context: "normal", isEdit: true });
    }
    // `ar`/`ir` shadow vim's `a<register>`/`i<register>` text objects for `r`,
    // which vim leaves undefined.
    Vim.defineMotion("orgSubtree", subtreeTextObject);
    Vim.mapCommand("ar", "motion", "orgSubtree", {});
    Vim.mapCommand("ir", "motion", "orgSubtree", { textObjectInner: true });
    // `ae`/`ie` shadow `a<register>`/`i<register>` for `e` the same way.
    Vim.defineMotion("orgElement", elementTextObject);
    Vim.mapCommand("ae", "motion", "orgElement", {});
    Vim.mapCommand("ie", "motion", "orgElement", { textObjectInner: true });
    // `a|`/`i|` shadow Vim Motions' table cell text objects, as `ar`/`ir` do
    // its row ones. Stock vim has none: `|` alone is the column motion.
    Vim.defineMotion("orgCell", cellTextObject);
    Vim.mapCommand("a|", "motion", "orgCell", {});
    Vim.mapCommand("i|", "motion", "orgCell", { textObjectInner: true });
    // Visual block `y` in a table copies cells.
    this.patchPushText(Vim);
    // `gh` shadows vim's select mode (codemirror-vim has it in some builds,
    // such as the one in Vim Motions). Like `gg`, it is linewise for
    // operators and goes on the jump list.
    Vim.defineMotion("orgUpHeading", upHeadingMotion);
    Vim.mapCommand("gh", "motion", "orgUpHeading", { linewise: true, toJumplist: true });
    // `o`/`O` shadow the stock ones. Like those, a count or `.` runs the
    // action again before each repeat of the typed text.
    Vim.defineAction("orgOpenLine", guarded(openLine));
    for (const [key, after] of [["o", true], ["O", false]]) {
      Vim.mapCommand(key, "action", "orgOpenLine", { after },
        { isEdit: true, interlaceInsertRepeat: true, context: "normal" });
    }
  }

  // `j` past a closed fold wraps findPosV on the class of the adapter at
  // view.cm. In Obsidian that's window.CodeMirrorAdapter, but a plugin that
  // bundles its own codemirror-vim (vim-motions does) has a class of its own
  // and may leave window.CodeMirrorAdapter a plain object, so the method is
  // looked up from the adapter itself. Each class is patched once.
  patchFindPosV(adapter) {
    while (adapter && !Object.hasOwn(adapter, "findPosV")) adapter = Object.getPrototypeOf(adapter);
    if (!adapter || typeof adapter.findPosV !== "function" || adapter.findPosV.stock) return;
    adapter.findPosV = foldAwareFindPosV(adapter.findPosV);
    (this.vimRestorers ||= []).push(() => {
      adapter.findPosV = adapter.findPosV.stock || adapter.findPosV;
    });
  }

  // Wrap pushText (see cellYankPushText) on the class of the engine's register
  // controller, which outlives the controller: vim makes a new one when it
  // resets. Each class is patched once.
  patchPushText(Vim) {
    let proto = typeof Vim.getRegisterController === "function" ? Vim.getRegisterController() : null;
    while (proto && !Object.hasOwn(proto, "pushText")) proto = Object.getPrototypeOf(proto);
    if (!proto || typeof proto.pushText !== "function" || proto.pushText.stock) return;
    proto.pushText = cellYankPushText(proto.pushText, this.app);
    (this.vimRestorers ||= []).push(() => {
      proto.pushText = proto.pushText.stock || proto.pushText;
    });
  }

  // On macOS Option-j arrives as `∆` with code "KeyJ", and some vim builds
  // strip the Alt modifier rather than restoring it from the code, leaving a
  // bare `j`. Catch Alt-j/Alt-k before any editor handler sees them and give
  // vim <A-j>/<A-k> directly, which keeps counts and `.` working. A typed
  // letter wins over the code, so on Colemak or Dvorak the key in QWERTY's
  // J position (Alt-n, Alt-h) is left alone.
  //
  // On a table row the same goes for the table keys: Alt with h, j, k, l or
  // an arrow, with or without Shift. They are caught only there, and only in
  // the note's own editor: a cell editor of a Live Preview table keeps all
  // its keys, Alt-j/Alt-k too. Off a table Alt-arrows (word motion on macOS)
  // and the rest are left alone.
  handleAltMove(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const key = (e.key || "").toLowerCase();
    const arrow = ALT_ARROWS[e.key];
    const letter = arrow || (/^[a-z]$/.test(key) ? (/^[hjkl]$/.test(key) ? key : null) : ALT_CODES[e.code]);
    const Vim = this.altMoveVim;
    if (!letter || !Vim) return;
    const view = activeEditorView(this.app);
    if (!view || !view.dom.contains(e.target)) return;
    // A pending count is kept in the key buffer; let it through to vim.
    if (!normalMode(view, true)) return;
    const table = tableCellAt(view.state.doc, view.state.selection.main.head);
    if (table && e.target !== view.contentDOM) return;
    let vimKey;
    if (table) {
      const edit = TABLE_KEYS[e.shiftKey ? letter.toUpperCase() : letter];
      vimKey = edit ? tableVimKey(edit) : `<A-${letter}>`;
    } else if (!arrow && !e.shiftKey && /^[jk]$/.test(letter)) {
      vimKey = `<A-${letter}>`;
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    Vim.handleKey(view.cm, vimKey, "user");
  }

  // Enter in a table (org-table-next-row) in vim normal mode. Vim reads Enter
  // as `j^` before the editor's keymaps see it, so it is caught first, as
  // Alt-j is. Only in the note's own editor: in Live Preview a table's cells
  // are editors of their own, with their own Enter. With a count pending,
  // Enter is vim's. In insert mode vim leaves Enter to the keymap.
  handleTableEnter(e) {
    if (e.key !== "Enter" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    const view = activeEditorView(this.app);
    if (!view || e.target !== view.contentDOM || !normalMode(view)) return;
    if (!guarded(tableNextRow)(view)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  // Change a setting in every editor, and keep the choice.
  async setSetting(key, value) {
    this.settings[key] = value;
    this.applySettings();
    await this.saveData(this.settings);
  }

  // The editor extensions the settings turn on.
  applySettings() {
    this.settingExtensions.length = 0;
    if (this.settings.indent) this.settingExtensions.push(indentMode);
    if (this.settings.compactHeadings) this.settingExtensions.push(...compactHeadings);
    if (this.settings.uniformHeadings) this.settingExtensions.push(uniformHeadings);
    if (this.settings.hideFoldArrows) this.settingExtensions.push(hideFoldArrows);
    this.app.workspace.updateOptions();
  }

  onunload() {
    for (const restore of (this.vimRestorers || []).reverse()) restore();
    this.vimRestorers = [];
    this.patchedVim = null;
    this.altMoveVim = null;
    // Draw the tables shown as text as widgets again.
    const hl = searchHighlight;
    if (!hl) return;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view.editor && leaf.view.editor.cm;
      if (!view) continue;
      const doc = view.state.doc;
      view.dispatch({ effects: hl.filter.of((from, to, value) => value !== hl.mark || !isTableBreak(doc, from, to)) });
    }
  }

  // A click on a cell of a Live Preview table, in an editor with vim, moves
  // vim's cursor to the cell's text instead of opening Obsidian's editor for
  // the cell, which has no vim. The table is then shown as text (see
  // showTablesAsText). The widget opens its cell editor on pointerdown; the
  // mouse events that follow are stopped too. The drag handles, the menu and
  // the add buttons are left alone, as are links and other controls in a
  // cell, so Obsidian follows a link, with a modifier key too.
  handleTableClick(e) {
    if (e.button !== 0 || !this.patchedVim || !searchHighlight) return;
    const target = e.target;
    if (!target || typeof target.closest !== "function") return;
    const cell = target.closest("td, th");
    const widget = cell && cell.closest(".cm-table-widget");
    if (!widget || target.closest(".table-col-drag-handle, .table-row-drag-handle")) return;
    const control = target.closest("a, input, button, select, textarea");
    if (control && cell.contains(control)) return;
    const editor = widget.parentElement && widget.parentElement.closest(".cm-editor");
    const view = editor && EditorView.findFromDOM(editor);
    if (!view || !getVimState(view)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type !== "pointerdown") return;
    const doc = view.state.doc;
    const table = tableAt(doc, doc.lineAt(view.posAtDOM(widget)).number);
    const tr = cell.parentElement;
    const row = [...widget.querySelectorAll("tr")].indexOf(tr);
    const col = [...tr.children].filter((c) => /^T[DH]$/.test(c.tagName)).indexOf(cell);
    const pos = table && row >= 0 && col >= 0 ? widgetCellPos(doc, table, row, col) : null;
    if (pos === null) return;
    view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
    view.focus();
  }
  // The widget may also focus a cell's editor by itself when it draws, as
  // when the cursor leaves the table. Vim's keys would go to the cell, and
  // once the cursor is back in the table the widget goes, with the focus:
  // keys then reach nothing. Cells are edited as text (see handleTableClick),
  // so give the focus back to the note's editor.
  handleTableFocus(e) {
    if (!this.patchedVim || !searchHighlight) return;
    const target = e.target;
    if (!target || typeof target.closest !== "function") return;
    const widget = target.closest(".cm-table-widget");
    const editor = widget && widget.parentElement && widget.parentElement.closest(".cm-editor");
    const view = editor && EditorView.findFromDOM(editor);
    if (view && getVimState(view)) view.focus();
  }

  async onload() {
    // The Vim engine can be replaced at runtime (e.g. by the vim-motions
    // plugin), so re-check whenever the active editor changes.
    this.app.workspace.onLayoutReady(() => this.installVimOverrides());
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.installVimOverrides()));
    const listen = (doc) => {
      this.registerDomEvent(doc, "keydown", (e) => {
        this.handleAltMove(e);
        this.handleTableEnter(e);
      }, { capture: true });
      for (const type of ["pointerdown", "mousedown", "click"]) {
        this.registerDomEvent(doc, type, guarded((e) => this.handleTableClick(e)), { capture: true });
      }
      this.registerDomEvent(doc, "focusin", guarded((e) => this.handleTableFocus(e)), { capture: true });
    };
    listen(document);
    // A pop-out window has a document of its own.
    this.registerEvent(this.app.workspace.on("window-open", (win) => listen(win.doc)));
    // In a table, Tab, Shift-Tab and Enter move between cells in normal and
    // insert mode, as org's do in evil's normal and insert states. Elsewhere
    // Tab cycles folds in normal mode only, and the rest is left to vim and
    // the editor.
    const table = (fn) => (view) => (normalMode(view) || insertMode(view)) && fn(view);
    const tab = (forward, cycle) => guarded((view) => table((v) => tableNextField(v, forward))(view) ||
      (normalMode(view) && cycle(view)));
    this.registerEditorExtension([
      Prec.highest(
        keymap.of([
          {
            key: "Tab",
            run: tab(true, localCycle),
            shift: tab(false, globalCycle),
          },
          { key: "Enter", run: guarded(table(tableNextRow)) },
        ])
      ),
      EditorState.transactionFilter.of((tr) => keepSelectedFoldsClosed(tr, this.app)),
      invertedEffects.of(deletedFolds),
      headingFolds,
      codeBlockFolds,
      showTablesAsText(() => {
        const view = this.patchedVim && activeEditorView(this.app);
        return !!view && !!getVimState(view);
      }),
      EditorView.updateListener.of((update) => {
        // An editor that opened without a leaf change, as in a pop-out or an
        // embed, may bring an adapter class not yet patched. Only while the
        // overrides are in, so an editor left open after unload stays stock.
        // The table widget's class is patched once one is drawn.
        if (this.patchedVim) {
          this.patchFindPosV(update.view.cm);
          guarded(patchTableWidget)(update.view, (this.vimRestorers ||= []));
        }
        if (!update.selectionSet || !visualLineMode(update.view)) return;
        if (!foldExtendedSelection(update.view)) return;
        // Vim is still mid-command here. Adjusting after it finishes makes the
        // change count as external, so vim re-syncs its own selection (used
        // by d/y/c/>) from ours.
        const view = update.view;
        afterVim(view, () => {
          if (!visualLineMode(view)) return;
          const next = foldExtendedSelection(view);
          if (next) view.dispatch({ selection: EditorSelection.single(next.anchor, next.head) });
        });
      }),
    ]);
    // A command is an explicit request, so unlike Tab it also runs in insert
    // mode (a hotkey can fire there) and without vim. It waits only while vim
    // is mid-command: a visual selection or pending operator would be left
    // out of step with text or folds changed under it.
    for (const [id, name, fn] of COMMANDS) {
      const run = guarded(fn);
      this.addCommand({
        id,
        name,
        editorCallback: (editor) => {
          const view = editor.cm;
          if (view && vimIdle(view)) run(view);
        },
      });
    }
    this.addCommand({
      id: "toggle-indent",
      name: "Toggle indent mode (org-indent-mode)",
      callback: () => this.setSetting("indent", !this.settings.indent),
    });
    // Filled by applySettings, after the settings load: the editor extensions
    // are registered first so that editors opened meanwhile get the vim keys.
    this.settingExtensions = [];
    this.registerEditorExtension(this.settingExtensions);
    // The defaults until the saved settings load, for the toggle-indent
    // command and the settings tab, which may be used meanwhile.
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.addSettingTab(new EvilOrgSettingTab(this.app, this));
    Object.assign(this.settings, await this.loadData());
    this.applySettings();
  }
};
