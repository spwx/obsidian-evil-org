"use strict";

const { Plugin, MarkdownView } = require("obsidian");
const { Prec, EditorState, EditorSelection, ChangeSet } = require("@codemirror/state");
const { keymap, EditorView } = require("@codemirror/view");
const { invertedEffects } = require("@codemirror/commands");
const { foldable, foldedRanges, foldEffect, unfoldEffect, indentUnit } = require("@codemirror/language");

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
// headings and `-` lines aren't list items. `blocks` lists those blocks as
// their first and last lines, and whether a closing line ends them. A Text
// never changes, so the scan is cached per doc: callers ask again freely
// instead of passing it around. The arrays are shared, hence frozen.
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
    const fence = text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
    else if (i === 1 && text === "---") close = /^(---|\.\.\.)\s*$/;
    if (close) blocks.push({ first: i, last: i, closed: false });
    levels.push(close ? 0 : headingLevel(text));
    code.push(!!close);
  }
  return { levels: Object.freeze(levels), code: Object.freeze(code), blocks: Object.freeze(blocks.map(Object.freeze)) };
}

function collectHeadings(state) {
  const out = [];
  const levels = headingLevels(state.doc);
  // The shallowest level present is top: a note may start at ## when its file
  // name serves as the title.
  const top = levels.reduce((min, l) => (l && l < min ? l : min), Infinity);
  for (let i = 1; i <= state.doc.lines; i++) {
    if (!levels[i]) continue;
    const line = state.doc.line(i);
    const range = foldable(state, line.from, line.to);
    if (range) out.push({ top: levels[i] === top, range });
  }
  return out;
}

function directChildFolds(state, line, own) {
  const levels = headingLevels(state.doc);
  const level = levels[line.number];
  const out = [];
  for (let i = line.number + 1; i <= state.doc.lines; i++) {
    const l = state.doc.line(i);
    if (l.from >= own.to) break;
    const lv = levels[i];
    if (!lv) continue;
    if (lv <= level) break;
    if (lv === level + 1) {
      const r = foldable(state, l.from, l.to);
      if (r) out.push(r);
    }
  }
  return out;
}

function localCycle(view) {
  const state = view.state;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const folds = allFolds(state);
  const level = headingLevels(state.doc)[line.number];
  const own = foldable(state, line.from, line.to);

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
  if (!own) return true;

  if (isFolded(folds, own)) {
    const effects = [unfoldEffect.of(own)];
    for (const c of directChildFolds(state, line, own)) {
      if (!isFolded(folds, c)) effects.push(foldEffect.of(c));
    }
    view.dispatch({ effects });
    return true;
  }
  const inRange = folds.filter((f) => f.from >= own.from && f.to <= own.to);
  if (inRange.length > 0) {
    view.dispatch({ effects: inRange.map((f) => unfoldEffect.of(f)) });
    return true;
  }
  view.dispatch({ effects: [foldEffect.of(own)] });
  return true;
}

function globalCycle(view) {
  const state = view.state;
  const headings = collectHeadings(state);
  const folds = allFolds(state);
  const foldedHeadings = headings.filter((h) => isFolded(folds, h.range));
  let effects;
  if (foldedHeadings.some((h) => h.top)) {
    effects = folds.map((f) => unfoldEffect.of(f));
  } else if (foldedHeadings.length > 0) {
    effects = headings.filter((h) => !isFolded(folds, h.range)).map((h) => foldEffect.of(h.range));
  } else {
    effects = headings.filter((h) => !h.top).map((h) => foldEffect.of(h.range));
  }
  if (effects.length > 0) view.dispatch({ effects });
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
// touching its first or last line is selected in full.
function foldExtendedSelection(state) {
  const { anchor, head } = state.selection.main;
  const doc = state.doc;
  const folds = allFolds(state);
  const top = foldedLineStart(doc, folds, Math.min(anchor, head));
  const bottom = foldedLineEnd(doc, folds, Math.max(anchor, head));
  const headIsTop = head < anchor;
  const next = headIsTop ? { anchor: bottom, head: top } : { anchor: top, head: bottom };
  if (next.anchor === anchor && next.head === head) return null;
  return next;
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
const plainExpandToLine = (_cm, head, args) => new head.constructor(head.line + args.repeat - 1, Infinity);

function foldAwareExpandToLine(original) {
  return function (cm, head, args, ...rest) {
    const view = cm && cm.cm6;
    if (!view) return original.call(this, cm, head, args, ...rest);
    const doc = view.state.doc;
    const folds = allFolds(view.state);
    if (folds.length === 0) return original.call(this, cm, head, args, ...rest);
    let line = head.line + 1; // CodeMirror 6 lines are 1-based
    for (let i = 0; i < args.repeat; i++) {
      if (i > 0) line = Math.min(line + 1, doc.lines);
      line = foldedLastLine(doc, folds, line);
    }
    return new head.constructor(line - 1, Infinity);
  };
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
// closed (CodeMirror opens a fold the cursor enters).
function orgDelete(Vim) {
  const stock = stockDelete(Vim);
  return function (cm, args, ranges) {
    const state = cm.cm6.state;
    const doc = state.doc;
    const { first, last } = operatorLines(ranges[0]);
    if (!args.linewise || cm.state.vim.visualBlock || ranges.length > 1 || first === 1 || last < doc.lines) {
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
    const vim = cm.state.vim;
    if (vim.visualMode) vim.sel.head = cursor;
    return cursor;
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
// one just the heading (org-do-demote). Body lines are left alone. A range
// that starts on a list item shifts items with their sub-items (see
// indentItems); one that starts on another line indents as usual, and so
// does a visual block, which shifts columns, not lines.
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
  if (!levels[first]) return stockIndent(cm, args, ranges);
  const folds = allFolds(state);
  const changes = [];
  const closed = [];
  for (let i = first; i <= last; i++) {
    const level = levels[i];
    if (!level) continue;
    const line = doc.line(i);
    const next = args.indentRight ? Math.min(MAX_LEVEL, level + steps) : Math.max(1, level - steps);
    if (next > level) changes.push({ from: line.from, insert: "#".repeat(next - level) });
    else if (next < level) changes.push({ from: line.from, to: line.from + level - next });
    closed.push(...folds.filter((f) => f.from === line.to));
  }
  if (changes.length === 0) return new ranges[0].anchor.constructor(first - 1, 0);
  const tr = state.update({ changes, userEvent: "input.indent" });
  view.dispatch(tr);
  // Vim opens folds under the operator's range once it finishes; close them
  // again over the same text. Like org, a promoted heading's fold doesn't grow
  // to take in the sections that are now its children.
  const refold = closed.map((f) => ({ from: tr.changes.mapPos(f.from), to: tr.changes.mapPos(f.to) }));
  if (refold.length > 0) afterVim(view, () => foldRanges(view, refold));
  return new ranges[0].anchor.constructor(first - 1, 0);
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

// `ar`/`ir` text objects. `ar` is the subtree of the heading the cursor is
// under, heading included, plus trailing blank lines; `ir` is its body without
// the heading or leading and trailing blank lines. A count, or repeating `ar`
// in visual mode, takes in the enclosing subtrees.
function subtreeTextObject(cm, head, motionArgs, vim) {
  const doc = cm.cm6.state.doc;
  const inner = !!motionArgs.textObjectInner;
  const headings = enclosingHeadings(doc, head.line + 1);
  let selFirst = Infinity, selLast = -Infinity;
  if (vim.visualMode) {
    selFirst = Math.min(vim.sel.anchor.line, vim.sel.head.line) + 1;
    selLast = Math.max(vim.sel.anchor.line, vim.sel.head.line) + 1;
  }
  let range = null;
  for (let i = Math.min((motionArgs.repeat || 1), headings.length) - 1; i < headings.length; i++) {
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

// org-move-subtree-down/up (M-↓/M-↑): swap the subtree under the cursor with
// the next or previous `count` sibling subtrees, keeping the blank lines
// between them where they were and closed folds closed. In a list, swap the
// item the cursor is in, with its sub-items, the same way with its sibling
// items (org-move-item-down/up), and renumber a numbered list. In a table,
// swap the row with the rows below or above it (org-table-move-row), but not
// with the header or the delimiter row. On other lines move the line (with the
// closed fold on it) past `count` lines, a closed fold counting as one line.
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
// subtree ({ level }), a table row ({ table }), the list item n is in
// ({ item }), or else the line.
function blockKind(doc, n) {
  const level = headingLevels(doc)[n];
  const table = !level && enclosingTable(doc, n);
  if (table) return { table, line: n };
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
// item's is the next or previous item of its list (see siblingItem). A table
// row's is the next or previous row below the delimiter row; the header and
// the delimiter row have none. A line's is the next line, or the previous one
// with any closed fold over it.
function siblingStart(doc, folds, kind, [first, last], forward) {
  const i = forward ? last + 1 : first - 1;
  if (i < 1 || i > doc.lines) return 0;
  if (kind.table) return first > kind.table.delim && i > kind.table.delim && i <= kind.table.last ? i : 0;
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

// A table's delimiter row, such as `| --- | :-: |`.
const DELIM_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

// The table line n is in, as the numbers of its header, delimiter and last
// rows, or null. A table is a block of lines with `|` in them whose second
// line is a delimiter row.
function enclosingTable(doc, n) {
  const code = scanLines(doc).code;
  const isRow = (i) => !code[i] && doc.line(i).text.includes("|");
  if (!isRow(n)) return null;
  let header = n;
  while (header > 1 && isRow(header - 1)) header--;
  const delim = header + 1;
  if (delim > doc.lines || !isRow(delim) || !DELIM_RE.test(doc.line(delim).text)) return null;
  let last = delim;
  while (last < doc.lines && isRow(last + 1)) last++;
  return { header, delim, last };
}

// An empty row shaped like the table row `text`: each cell blanked to its
// width, so an aligned table stays aligned.
function emptyRow(text) {
  const indent = text.slice(0, firstNonBlank(text));
  return indent + text.slice(indent.length).replace(/\\\||[^|]/g, (m) => " ".repeat(m.length));
}

// The cells of the table row `text`, and its indent. Each cell has the
// offsets of the text between its pipes (from, to), that text trimmed, and
// where the trimmed text starts (for an empty cell, one space in). Outer pipes
// are optional. A `\|` doesn't split a cell, and neither does a `|` in inline
// code, so aligning a table never changes the text in code.
function rowCells(text) {
  const start = firstNonBlank(text);
  const end = text.trimEnd().length;
  const seps = [];
  for (let i = start; i < end; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "|") seps.push(i);
    else if (text[i] === "`") {
      let n = 1;
      while (text[i + n] === "`") n++;
      const close = codeSpanEnd(text, i + n, end, n);
      i = (close < 0 ? i : close) + n - 1;
    }
  }
  const bounds = seps[0] === start ? seps : [start - 1, ...seps];
  if (bounds.length === 1 || bounds[bounds.length - 1] !== end - 1) bounds.push(end);
  const cells = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const from = bounds[k] + 1;
    const to = bounds[k + 1];
    const raw = text.slice(from, to);
    const trimmed = raw.trim();
    cells.push({ from, to, text: trimmed, start: from + (trimmed ? firstNonBlank(raw) : Math.min(1, raw.length)) });
  }
  return { indent: text.slice(0, start), cells };
}

// Start of the run of exactly n backticks that closes a code span, from
// offset i on, or -1.
function codeSpanEnd(text, i, end, n) {
  while (i < end) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let k = 1;
    while (text[i + k] === "`") k++;
    if (k === n) return i;
    i += k;
  }
  return -1;
}

// Columns a string takes up in a monospace font: two for each wide (East
// Asian) character or emoji, none for a combining mark, else one. It works
// by grapheme where Intl.Segmenter is available. This is an estimate: fonts
// differ, and Obsidian's default font isn't monospace.
const WIDE_RE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}️]|\p{Emoji_Presentation}/u;
const ZERO_RE = /^[\p{M}\p{Cf}]+$/u;
const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter() : null;

function displayWidth(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s.length;
  const parts = segmenter ? Array.from(segmenter.segment(s), (p) => p.segment) : Array.from(s);
  return parts.reduce((w, g) => w + (WIDE_RE.test(g) ? 2 : ZERO_RE.test(g) ? 0 : 1), 0);
}

// The alignment a delimiter cell sets: `:--` left, `--:` right, `:-:`
// center, and "" (left) for `---`.
function cellAlign(cell) {
  const m = cell.match(/^(:?)-+(:?)$/);
  return !m ? "" : m[1] && m[2] ? "center" : m[1] ? "left" : m[2] ? "right" : "";
}

// The lines of a table (org-table-align): rows of cell texts, the second the
// delimiter row, each padded to the widest cell of its column as its
// alignment says. The delimiter row is rebuilt with dashes to that width,
// keeping its colons. Each line gets the table's indent and outer pipes.
function formatTable(indent, rows) {
  const aligns = rows[1].map(cellAlign);
  const widths = aligns.map((a, c) =>
    Math.max(a === "center" ? 3 : a ? 2 : 1, ...rows.map((r, k) => (k === 1 ? 0 : displayWidth(r[c])))));
  return rows.map((r, k) => {
    const cells = r.map((t, c) => {
      const w = widths[c];
      const a = aligns[c];
      if (k === 1) return a === "center" ? `:${"-".repeat(w - 2)}:` : a === "left" ? `:${"-".repeat(w - 1)}` : a === "right" ? `${"-".repeat(w - 1)}:` : "-".repeat(w);
      const gap = w - displayWidth(t);
      const left = a === "right" ? gap : a === "center" ? Math.floor(gap / 2) : 0;
      return " ".repeat(left) + t + " ".repeat(gap - left);
    });
    return `${indent}| ${cells.join(" | ")} |`;
  });
}

// The table at the cursor and the cursor's place in it, or null outside a
// table: the table's lines (see enclosingTable), its indent and its rows of
// cell texts, all as long as the longest row; the cursor's row (0 is the
// header, 1 the delimiter row) and cell, and how far into the cell's text.
function tableCursor(state) {
  const doc = state.doc;
  const head = state.selection.main.head;
  const line = doc.lineAt(head);
  const table = enclosingTable(doc, line.number);
  if (!table) return null;
  const rows = [];
  for (let i = table.header; i <= table.last; i++) rows.push(rowCells(doc.line(i).text).cells.map((c) => c.text));
  const cols = Math.max(...rows.map((r) => r.length));
  for (const r of rows) while (r.length < cols) r.push("");
  const cells = rowCells(line.text).cells;
  const ch = head - line.from;
  let col = cells.findIndex((c) => ch <= c.to);
  if (col < 0) col = cells.length - 1;
  const cell = cells[col];
  const offset = Math.max(0, Math.min(ch - cell.start, cell.text.length));
  return { table, indent: rowCells(doc.line(table.header).text).indent, rows, row: line.number - table.header, col, offset };
}

// Replace the table's lines with its rows, aligned, in one change, and put
// the cursor `offset` characters into the text of cell `col` of row `row`.
// Rows past the table's last line are added below it. Lines that don't change
// aren't touched.
function writeTable(view, { table, indent, rows }, row, col, offset) {
  const state = view.state;
  const doc = state.doc;
  const lines = formatTable(indent, rows);
  const count = table.last - table.header + 1;
  const changes = [];
  for (let k = 0; k < count; k++) {
    const line = doc.line(table.header + k);
    const insert = k < count - 1 ? lines[k] : lines.slice(k).join("\n");
    if (insert !== line.text) changes.push({ from: line.from, to: line.to, insert });
  }
  const set = state.changes(changes);
  const cell = rowCells(lines[row]).cells[col];
  const anchor = set.apply(doc).line(table.header + row).from + cell.start + Math.min(offset, cell.text.length);
  view.dispatch({ changes: set, selection: { anchor }, scrollIntoView: true, userEvent: "input" });
  return true;
}

// org-table-align: align the table at the cursor, which stays in its cell.
function alignTable(view) {
  const t = tableCursor(view.state);
  return !!t && writeTable(view, t, t.row, t.col, t.offset);
}

// org-table-next-field / org-table-previous-field (TAB / S-TAB in a table):
// align the table and go to the start of the next or previous cell, row by
// row, past the delimiter row. From the last cell, a new row opens below the
// table; from the first, the cursor stays. False outside a table.
function tableField(view, forward) {
  const t = tableCursor(view.state);
  if (!t) return false;
  const cols = t.rows[0].length;
  let { row, col } = t;
  // On the delimiter row, the next cell is the first below it, and the
  // previous one the last of the header.
  if (row === 1) col = forward ? cols - 1 : 0;
  col += forward ? 1 : -1;
  if (col === cols) [row, col] = [row + 1, 0];
  if (col < 0) [row, col] = [row - 1, cols - 1];
  if (row === 1) row += forward ? 1 : -1;
  if (row < 0) [row, col] = [0, 0];
  if (row === t.rows.length) t.rows.push(Array(cols).fill(""));
  return writeTable(view, t, row, col, 0);
}

// org-table-move-column-left/right (M-← / M-→ in a table): move the column at
// the cursor past `count` columns, with its alignment, and align the table.
// The cursor stays in its cell. False outside a table or at its edge.
function moveColumn(view, right, count) {
  const t = tableCursor(view.state);
  if (!t) return false;
  const to = Math.max(0, Math.min(t.rows[0].length - 1, t.col + (right ? count : -count)));
  if (to === t.col) return false;
  for (const r of t.rows) r.splice(to, 0, r.splice(t.col, 1)[0]);
  return writeTable(view, t, t.row, to, t.offset);
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
// a code block, front matter, heading line, table, block quote or paragraph;
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
  const table = !code[m] && enclosingTable(doc, m);
  let top = m; // the element's first line, where the items around it are found
  if (block) {
    add(block.first, block.last, lines(block.first + 1, block.closed ? block.last - 1 : block.last));
    top = block.first;
  } else if (levels[m]) {
    const line = doc.line(m);
    add(m, m, chars(line.from + line.text.match(/^#+\s*/)[0].length, line.to));
  } else if (table) {
    add(table.header, table.last, lines(table.delim + 1, table.last));
    top = table.header;
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
      !RULE_RE.test(text(i)) && !listItem(doc, i) && !enclosingTable(doc, i) &&
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

// `o`/`O` (evil-org-open-below/above). In a table, open an empty row below or
// above the row, with the cursor in its first cell; `o` on the header opens
// the first row under the delimiter row, and `O` there opens a plain line above
// the table. In a list item, open a new item after the item and its
// sub-items, or before the item: same indent and bullet, the next number
// (renumbering the items after it), and an empty checkbox if the item has one.
// On a heading, open a plain line, as in vim. On a closed fold `o` opens a
// line below the whole fold, not inside it. Elsewhere `o`/`O` are the stock
// ones. Vim calls actions as methods of its action table, so `this` holds the
// stock actions.
function openLine(cm, args, vim) {
  const view = cm.cm6;
  if (!view) return this.newLineAndEnterInsertMode(cm, args, vim);
  const state = view.state;
  const doc = state.doc;
  const folds = allFolds(state);
  const n = doc.lineAt(state.selection.main.head).number;
  const lineText = doc.line(n).text;
  const indent = lineText.slice(0, firstNonBlank(lineText));
  const table = enclosingTable(doc, n);
  const item = !table && enclosingItem(doc, n);
  let target, text, col;
  let renumber = [];
  if (table && n <= table.delim && !args.after) {
    target = table.header;
    text = indent;
  } else if (table) {
    target = n <= table.delim ? table.delim : n;
    text = emptyRow(lineText);
    col = indent.length + text.slice(indent.length).match(/^(?:\| ?)?/)[0].length;
  } else if (item) {
    target = args.after ? itemEnd(doc, folds, item) : item.line;
    const marker = item.delim ? `${Number(item.digits) + (args.after ? 1 : 0)}${item.delim}` : item.bullet;
    text = `${item.indent}${marker} ${item.checkbox ? "[ ] " : ""}`;
    if (item.delim) renumber = renumberFrom(doc, folds, item, args.after ? target + 1 : item.line);
  } else {
    target = args.after ? foldedLastLine(doc, folds, n) : n;
    if (target === n) return this.newLineAndEnterInsertMode(cm, args, vim);
    text = indent;
  }
  if (col === undefined) col = text.length;
  const { insert, newLine } = openLineChange(doc, target, args.after, text);
  const changes = state.changes([insert, ...renumber]);
  const cursor = changes.apply(doc).line(newLine).from + col;
  view.dispatch({ changes, selection: { anchor: cursor }, scrollIntoView: true, userEvent: "input" });
  const head = new cm.constructor.Pos(newLine - 1, col);
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

// The letters of the Alt keys handleAltMove catches, by key code.
const ALT_CODES = { KeyH: "h", KeyJ: "j", KeyK: "k", KeyL: "l" };

// Command ids and names are user-facing: hotkeys are bound to the ids.
const COMMANDS = [
  ["cycle-local", "Cycle fold under cursor (TAB in org-mode)", localCycle],
  ["cycle-global", "Cycle global fold overview (S-TAB in org-mode)", globalCycle],
  ["move-subtree-down", "Move subtree down (M-↓ in org-mode)", (view) => moveSubtree(view, true, 1)],
  ["move-subtree-up", "Move subtree up (M-↑ in org-mode)", (view) => moveSubtree(view, false, 1)],
  ["insert-heading", "Insert heading (M-RET in org-mode)", (view) => insertHeading(view, false)],
  ["insert-subheading", "Insert subheading", (view) => insertHeading(view, true)],
  ["align-table", "Align table", alignTable],
  ["move-table-column-left", "Move table column left", (view) => moveColumn(view, false, 1)],
  ["move-table-column-right", "Move table column right", (view) => moveColumn(view, true, 1)],
];

module.exports = class EvilOrgPlugin extends Plugin {
  installVimOverrides() {
    const Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim;
    if (!Vim || Vim === this.patchedVim) return;
    const original = (Vim.getMotion && Vim.getMotion("expandToLine")) || plainExpandToLine;
    Vim.defineMotion("expandToLine", foldAwareExpandToLine(original));
    // A command's motion runs before its action; these entries shadow the
    // stock `p`/`P` in normal mode (visual-mode paste is untouched).
    Vim.defineMotion("orgPasteAfter", pasteMotion(Vim, true));
    Vim.defineMotion("orgPasteBefore", pasteMotion(Vim, false));
    Vim.mapCommand("p", "action", "paste", { after: true, isEdit: true },
      { isEdit: true, context: "normal", motion: "orgPasteAfter" });
    Vim.mapCommand("P", "action", "paste", { after: false, isEdit: true },
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
    // M-j / M-k move the subtree (M-↓ / M-↑ in org-mode). On macOS vim reads
    // Option-j as <A-j> too.
    Vim.defineAction("orgMoveSubtree", guarded((cm, args) => {
      if (cm.cm6) moveSubtree(cm.cm6, args.forward, args.repeat || 1);
    }));
    Vim.mapCommand("<A-j>", "action", "orgMoveSubtree", { forward: true }, { context: "normal", isEdit: true });
    Vim.mapCommand("<A-k>", "action", "orgMoveSubtree", { forward: false }, { context: "normal", isEdit: true });
    // M-h / M-l move the table column (M-← / M-→ in org-mode).
    Vim.defineAction("orgMoveColumn", guarded((cm, args) => {
      if (cm.cm6) moveColumn(cm.cm6, args.right, args.repeat || 1);
    }));
    Vim.mapCommand("<A-h>", "action", "orgMoveColumn", { right: false }, { context: "normal", isEdit: true });
    Vim.mapCommand("<A-l>", "action", "orgMoveColumn", { right: true }, { context: "normal", isEdit: true });
    // `ar`/`ir` shadow vim's `a<register>`/`i<register>` text objects for `r`,
    // which vim leaves undefined.
    Vim.defineMotion("orgSubtree", subtreeTextObject);
    Vim.mapCommand("ar", "motion", "orgSubtree", {});
    Vim.mapCommand("ir", "motion", "orgSubtree", { textObjectInner: true });
    // `ae`/`ie` shadow `a<register>`/`i<register>` for `e` the same way.
    Vim.defineMotion("orgElement", elementTextObject);
    Vim.mapCommand("ae", "motion", "orgElement", {});
    Vim.mapCommand("ie", "motion", "orgElement", { textObjectInner: true });
    // `o`/`O` shadow the stock ones. Like those, a count or `.` runs the
    // action again before each repeat of the typed text.
    Vim.defineAction("orgOpenLine", guarded(openLine));
    for (const [key, after] of [["o", true], ["O", false]]) {
      Vim.mapCommand(key, "action", "orgOpenLine", { after },
        { isEdit: true, interlaceInsertRepeat: true, context: "normal" });
    }
    // Every engine patched keeps the overrides until unload, not just the
    // current one. Unload runs these last-first, so an engine patched twice
    // (swapped out and back) ends up with its stock originals.
    this.patchedVim = Vim;
    (this.vimRestorers ||= []).push(() => {
      Vim.defineMotion("expandToLine", original);
      Vim.defineAction("orgMoveSubtree", () => {});
      Vim.defineAction("orgMoveColumn", () => {});
      Vim.defineMotion("orgSubtree", () => null);
      Vim.defineMotion("orgElement", () => null);
      Vim.defineAction("orgOpenLine", function (cm, args, vim) {
        return this.newLineAndEnterInsertMode(cm, args, vim);
      });
      // Keymap entries can't be removed, so make them behave like the stock ones.
      Vim.defineMotion("orgPasteAfter", (_cm, head) => head);
      Vim.defineMotion("orgPasteBefore", (_cm, head) => head);
      Vim.defineOperator("orgIndent", stockIndent);
      Vim.defineOperator("orgDelete", stockDelete(Vim));
    });
  }

  // On macOS Option-j arrives as `∆` with code "KeyJ", and some vim builds
  // strip the Alt modifier rather than restoring it from the code, leaving a
  // bare `j`. Catch Alt-j/Alt-k before any editor handler sees them and give
  // vim <A-j>/<A-k> directly, which keeps counts and `.` working. Alt-h/Alt-l
  // are caught the same way, but only in a table: elsewhere they stay free.
  handleAltMove(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const letter = ALT_CODES[e.code] || (/^[hjkl]$/.test(e.key) ? e.key : null);
    const Vim = this.patchedVim;
    if (!letter || !Vim) return;
    const view = activeEditorView(this.app);
    if (!view || !view.dom.contains(e.target)) return;
    // A pending count is kept in the key buffer; let it through to vim.
    if (!normalMode(view, true)) return;
    const state = view.state;
    if ("hl".includes(letter) && !enclosingTable(state.doc, state.doc.lineAt(state.selection.main.head).number)) return;
    e.preventDefault();
    e.stopPropagation();
    Vim.handleKey(view.cm, `<A-${letter}>`, "user");
  }

  onunload() {
    for (const restore of (this.vimRestorers || []).reverse()) restore();
    this.vimRestorers = [];
    this.patchedVim = null;
  }

  async onload() {
    // The Vim engine can be replaced at runtime (e.g. by the vim-motions
    // plugin), so re-check whenever the active editor changes.
    this.app.workspace.onLayoutReady(() => this.installVimOverrides());
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.installVimOverrides()));
    this.registerDomEvent(document, "keydown", (e) => this.handleAltMove(e), { capture: true });
    // Tab cycles only in normal mode; elsewhere it's left to vim and the editor.
    // In a table, which is never a heading, it goes from cell to cell instead.
    const tab = (fn) => guarded((view) => normalMode(view) && fn(view));
    this.registerEditorExtension([
      Prec.highest(
        keymap.of([
          {
            key: "Tab",
            run: tab((view) => tableField(view, true) || localCycle(view)),
            shift: tab((view) => tableField(view, false) || globalCycle(view)),
          },
        ])
      ),
      EditorState.transactionFilter.of((tr) => keepSelectedFoldsClosed(tr, this.app)),
      invertedEffects.of(deletedFolds),
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet || !visualLineMode(update.view)) return;
        if (!foldExtendedSelection(update.state)) return;
        // Vim is still mid-command here. Adjusting after it finishes makes the
        // change count as external, so vim re-syncs its own selection (used
        // by d/y/c/>) from ours.
        const view = update.view;
        afterVim(view, () => {
          if (!visualLineMode(view)) return;
          const next = foldExtendedSelection(view.state);
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
  }
};
