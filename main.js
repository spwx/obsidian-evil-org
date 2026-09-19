"use strict";

const { Plugin, MarkdownView } = require("obsidian");
const { Prec, EditorState, EditorSelection } = require("@codemirror/state");
const { keymap, EditorView } = require("@codemirror/view");
const { invertedEffects } = require("@codemirror/commands");
const { foldable, foldedRanges, foldEffect, unfoldEffect } = require("@codemirror/language");

const HEADING_RE = /^(#+)(\s|$)/;

function getVimState(view, app) {
  try {
    const compat = view.cm;
    if (compat && compat.state && compat.state.vim) return compat.state.vim;
  } catch (e) {}
  if (app) {
    try {
      const md = app.workspace.getActiveViewOfType(MarkdownView);
      const c = md && md.editor && md.editor.cm ? md.editor.cm.cm : null;
      if (c && c.state && c.state.vim) return c.state.vim;
    } catch (e) {}
  }
  return (view.state && view.state.vim) || null;
}

function normalMode(view, app) {
  const v = getVimState(view, app);
  if (!v) return false;
  if (v.insertMode || v.visualMode || v.virtualReplace) return false;
  if (v.operator) return false;
  if (v.inputState && v.inputState.keyBuffer && v.inputState.keyBuffer.length > 0) return false;
  return true;
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

function isFolded(folds, range) {
  return folds.some((f) => f.from === range.from && f.to === range.to);
}

function headingLevel(text) {
  const m = text.match(HEADING_RE);
  return m ? m[1].length : 0;
}

const isBlank = (text) => text.trim() === "";

// Heading level of each line (levels[n] for 1-based line n), 0 for lines that
// aren't headings. `#` lines in front matter or fenced code blocks don't count.
function headingLevels(doc) {
  const levels = [0];
  let close = null;
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (close) {
      if (close.test(text)) close = null;
      levels.push(0);
      continue;
    }
    const fence = text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
    else if (i === 1 && text === "---") close = /^(---|\.\.\.)\s*$/;
    levels.push(close ? 0 : headingLevel(text));
  }
  return levels;
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

function directChildFolds(state, levels, line, own) {
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
  const levels = headingLevels(state.doc);
  const level = levels[line.number];

  if (level === 0) {
    const own = foldable(state, line.from, line.to);
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

  const own = foldable(state, line.from, line.to);
  const covering = folds.find((f) => f.from <= line.from && f.to >= line.to);
  if (covering && !(own && covering.from === own.from && covering.to === own.to)) {
    view.dispatch({ effects: [unfoldEffect.of(covering)] });
    return true;
  }
  if (!own) return true;

  const inRange = folds.filter((f) => f.from >= own.from && f.to <= own.to);

  if (isFolded(folds, own)) {
    const effects = [unfoldEffect.of(own)];
    for (const c of directChildFolds(state, levels, line, own)) {
      if (!isFolded(folds, c)) effects.push(foldEffect.of(c));
    }
    view.dispatch({ effects });
    return true;
  }
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

function visualLineMode(view, app) {
  const v = getVimState(view, app);
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

// Vim-style V over closed folds: grow the linewise selection so that any fold
// touching its first or last line is selected in full.
function foldExtendedSelection(state) {
  const { anchor, head } = state.selection.main;
  const doc = state.doc;
  const folds = allFolds(state);
  let top = Math.min(anchor, head);
  for (const f of folds) {
    if (f.from < top && f.to >= top) top = doc.lineAt(f.from).from;
  }
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
  const md = app.workspace.getActiveViewOfType(MarkdownView);
  const view = md && md.editor ? md.editor.cm : null;
  if (!view || view.state !== tr.startState || !visualLineMode(view, app)) return tr;
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

// Fold range for a heading's section: CodeMirror's (Obsidian's) own range,
// or, if that isn't available yet for freshly inserted text, the same range
// computed directly: to the last line before a heading of equal or higher level.
function sectionRange(state, line) {
  const r = foldable(state, line.from, line.to);
  if (r) return r;
  const doc = state.doc;
  const levels = headingLevels(doc);
  const level = levels[line.number];
  if (!level) return null;
  let end = line.to;
  for (let i = line.number + 1; i <= doc.lines; i++) {
    const lv = levels[i];
    if (lv && lv <= level) break;
    end = doc.line(i).to;
  }
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
    if (r && (r.to <= end || doc.sliceString(end, r.to).trim() === "")) out.push(r);
  }
  return out;
}

function foldRanges(view, ranges) {
  const folds = allFolds(view.state);
  const effects = ranges
    .filter((r) => r && !isFolded(folds, r))
    .sort((a, b) => a.from - b.from)
    .map((r) => foldEffect.of(r));
  if (effects.length > 0) view.dispatch({ effects });
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
      line = doc.lineAt(foldedLineEnd(doc, folds, doc.line(line).from)).number;
    }
    return new head.constructor(line - 1, Infinity);
  };
}

const firstNonBlank = (text) => text.length - text.trimStart().length;

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
      head = h.line < anchor.line || (h.line === anchor.line && h.ch < anchor.ch) ? h : anchor;
    }
    Vim.getRegisterController().pushText(args.registerName, "delete", text, args.linewise, vim.visualBlock);
    const line = Math.min(Math.max(cm.firstLine(), head.line), cm.lastLine());
    const maxCh = cm.getLine(line).length - 1 + (vim.insertMode || vim.visualMode ? 1 : 0);
    return new Pos(line, Math.min(Math.max(0, head.ch), maxCh));
  };
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
    const { anchor, head } = ranges[0];
    const forward = anchor.line < head.line || (anchor.line === head.line && anchor.ch <= head.ch);
    const start = forward ? anchor : head;
    const end = forward ? head : anchor;
    // Linewise ranges end at the start of the line after the last one.
    const last = end.ch === 0 && end.line > start.line ? end.line - 1 : end.line;
    if (!args.linewise || cm.state.vim.visualBlock || ranges.length > 1 || start.line === 0 || last < cm.lastLine()) {
      return stock(cm, args, ranges);
    }
    const state = cm.cm6.state;
    const doc = state.doc;
    const prev = doc.line(start.line); // 1-based: the line before the deleted ones
    const outer = allFolds(state)
      .filter((f) => f.from < prev.to && f.to >= prev.to)
      .sort((a, b) => a.from - b.from)[0];
    const target = outer ? doc.lineAt(outer.from) : prev;
    const text = doc.sliceString(doc.line(start.line + 1).from);
    const Pos = anchor.constructor;
    const lastLine = cm.lastLine();
    cm.replaceRange("", new Pos(start.line - 1, prev.length), new Pos(lastLine, cm.getLine(lastLine).length));
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
      target = doc.lineAt(foldedLineEnd(doc, allFolds(view.state), headLine.from)).number - 1;
    }
    const first = after ? target + 2 : target + 1; // 1-based, in the new doc
    const reclose = after && target !== head.line ? headLine.from : null;
    setTimeout(() => {
      const state = view.state;
      const ranges = pastedSubtreeFolds(state, first, first + count - 1);
      if (reclose !== null && reclose <= state.doc.length) {
        ranges.push(sectionRange(state, state.doc.lineAt(reclose)));
      }
      foldRanges(view, ranges);
    }, 0);
    return target === head.line ? head : new head.constructor(target, head.ch);
  };
}

// First and last (1-based) lines of a linewise operator range. The range may
// end at the start of the line after it.
function operatorLines(doc, cm, range) {
  const a = cm.indexFromPos(range.anchor);
  const h = cm.indexFromPos(range.head);
  const from = Math.min(a, h);
  let to = Math.max(a, h);
  if (to > from && doc.lineAt(to).from === to) to--;
  return { first: doc.lineAt(from).number, last: doc.lineAt(to).number };
}

// The stock `indent` operator as it runs on CodeMirror 6 (vim's operator
// table isn't exposed, so it can't be wrapped): shift the selection vim has
// just set, then go to the first non-blank of the first line.
function stockIndent(cm, args, ranges) {
  const vim = cm.state.vim;
  const repeat = vim && vim.visualMode ? args.repeat : 1;
  for (let j = 0; j < repeat; j++) {
    if (args.indentRight) cm.indentMore();
    else cm.indentLess();
  }
  const doc = cm.cm6.state.doc;
  const line = doc.line(operatorLines(doc, cm, ranges[0]).first);
  return new ranges[0].anchor.constructor(line.number - 1, firstNonBlank(line.text));
}

// `>`/`<` (and `>>`, `3<<`, `V>`) on headings: promote/demote instead of
// indenting. expandToLine treats a closed fold as one line, so `>>` on a
// folded heading shifts its whole subtree (org-demote-subtree) and on an open
// one just the heading (org-do-demote). Body lines are left alone. A range
// that doesn't start on a heading indents as usual.
function orgIndent(cm, args, ranges) {
  const view = cm.cm6;
  const state = view.state;
  const doc = state.doc;
  const { first, last } = operatorLines(doc, cm, ranges[0]);
  const levels = headingLevels(doc);
  if (!levels[first]) return stockIndent(cm, args, ranges);
  const vim = cm.state.vim;
  const steps = vim && vim.visualMode ? args.repeat || 1 : 1;
  const folds = allFolds(state);
  const changes = [];
  const closed = [];
  for (let i = first; i <= last; i++) {
    const level = levels[i];
    if (!level) continue;
    const line = doc.line(i);
    const next = args.indentRight ? Math.min(6, level + steps) : Math.max(1, level - steps);
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
  if (refold.length > 0) {
    setTimeout(() => {
      const len = view.state.doc.length;
      foldRanges(view, refold.filter((r) => r.to <= len));
    }, 0);
  }
  return new ranges[0].anchor.constructor(first - 1, 0);
}

// Last line of the section of the heading on line h: up to the next heading of
// the same or a higher level, with or without trailing blank lines.
function sectionEnd(doc, levels, h, withBlank) {
  let last = h;
  for (let i = h + 1; i <= doc.lines; i++) {
    if (levels[i] && levels[i] <= levels[h]) break;
    if (withBlank || !isBlank(doc.line(i).text)) last = i;
  }
  return last;
}

// The heading whose section contains line n, then its ancestors, innermost first.
function enclosingHeadings(levels, n) {
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
  const levels = headingLevels(doc);
  const inner = !!motionArgs.textObjectInner;
  const headings = enclosingHeadings(levels, head.line + 1);
  let selFirst = Infinity, selLast = -Infinity;
  if (vim.visualMode) {
    selFirst = Math.min(vim.sel.anchor.line, vim.sel.head.line) + 1;
    selLast = Math.max(vim.sel.anchor.line, vim.sel.head.line) + 1;
  }
  let range = null;
  for (let i = Math.min((motionArgs.repeat || 1), headings.length) - 1; i < headings.length; i++) {
    const h = headings[i];
    let first = inner ? h + 1 : h;
    const last = sectionEnd(doc, levels, h, !inner);
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
// between them where they were and closed folds closed. On other lines move
// the line (with the closed fold on it) past `count` lines, a closed fold
// counting as one line.
function moveSubtree(view, forward, count) {
  const state = view.state;
  const doc = state.doc;
  const folds = allFolds(state);
  const levels = headingLevels(doc);
  const cursor = state.selection.main.head;
  const n = doc.lineAt(cursor).number;
  const level = levels[n];
  const a1 = n;
  const a2 = level ? sectionEnd(doc, levels, n, false) : doc.lineAt(foldedLineEnd(doc, folds, doc.line(n).from)).number;
  let b1 = 0, b2 = 0;
  if (forward) {
    for (let end = a2, c = 0; c < count; c++) {
      let next = end + 1;
      while (level && next <= doc.lines && isBlank(doc.line(next).text)) next++;
      if (next > doc.lines || (level && levels[next] !== level)) break;
      end = level ? sectionEnd(doc, levels, next, false) : doc.lineAt(foldedLineEnd(doc, folds, doc.line(next).from)).number;
      if (!b1) b1 = next;
      b2 = end;
    }
  } else {
    for (let start = a1, c = 0; c < count; c++) {
      let prev = start - 1;
      if (level) {
        while (prev >= 1 && !(levels[prev] && levels[prev] <= level)) prev--;
        if (prev < 1 || levels[prev] !== level) break;
      } else {
        if (prev < 1) break;
        const pos = doc.line(prev).from;
        for (const f of folds) if (f.from < pos && f.to >= pos) prev = Math.min(prev, doc.lineAt(f.from).number);
      }
      if (!b2) {
        b2 = a1 - 1;
        while (b2 > prev && isBlank(doc.line(b2).text)) b2--;
      }
      b1 = start = prev;
    }
  }
  if (!b1) return false;

  const [first, second] = forward ? [[a1, a2], [b1, b2]] : [[b1, b2], [a1, a2]];
  const from = doc.line(first[0]).from;
  const firstEnd = doc.line(first[1]).to;
  const secondStart = doc.line(second[0]).from;
  const to = doc.line(second[1]).to;
  // Replace through the end of any fold that starts in the range, so every
  // such fold is dropped whole (and restored by undo) and can be re-closed.
  const inside = folds.filter((f) => f.from >= from && f.from <= to);
  const replaceTo = Math.max(to, ...inside.map((f) => f.to));
  const firstText = doc.sliceString(from, firstEnd);
  const gap = doc.sliceString(firstEnd, secondStart);
  const secondText = doc.sliceString(secondStart, to);
  const insert = secondText + gap + firstText + doc.sliceString(to, replaceTo);
  const secondShift = from - secondStart;
  const firstShift = secondText.length + gap.length;
  const shiftA = forward ? firstShift : secondShift;

  const headingFolds = [];
  const otherFolds = [];
  for (const f of inside) {
    const inFirst = f.from <= firstEnd;
    const shift = inFirst ? firstShift : secondShift;
    const partEnd = inFirst ? firstEnd : to;
    const line = doc.lineAt(f.from);
    if (levels[line.number] && f.from === line.to) headingFolds.push(line.from + shift);
    else otherFolds.push({ from: f.from + shift, to: Math.min(f.to, partEnd) + shift });
  }
  view.dispatch({
    changes: { from, to: replaceTo, insert },
    selection: { anchor: cursor + shiftA },
    scrollIntoView: true,
    userEvent: "move.line",
  });
  const next = view.state;
  foldRanges(view, [...headingFolds.map((pos) => sectionRange(next, next.doc.lineAt(pos))), ...otherFolds]);
  return true;
}

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
    // M-j / M-k move the subtree (org M-↓ / M-↑). On macOS vim reads
    // Option-j as <A-j> too.
    Vim.defineAction("orgMoveSubtree", (cm, args) => {
      if (cm.cm6) moveSubtree(cm.cm6, args.forward, args.repeat || 1);
    });
    Vim.mapCommand("<A-j>", "action", "orgMoveSubtree", { forward: true }, { context: "normal", isEdit: true });
    Vim.mapCommand("<A-k>", "action", "orgMoveSubtree", { forward: false }, { context: "normal", isEdit: true });
    // `ar`/`ir` shadow vim's `a<register>`/`i<register>` text objects for `r`,
    // which vim leaves undefined.
    Vim.defineMotion("orgSubtree", subtreeTextObject);
    Vim.mapCommand("ar", "motion", "orgSubtree", {});
    Vim.mapCommand("ir", "motion", "orgSubtree", { textObjectInner: true });
    this.patchedVim = Vim;
    this.restoreVim = () => {
      Vim.defineMotion("expandToLine", original);
      Vim.defineAction("orgMoveSubtree", () => {});
      Vim.defineMotion("orgSubtree", () => null);
      // Keymap entries can't be removed, so make them behave like the stock ones.
      Vim.defineMotion("orgPasteAfter", (_cm, head) => head);
      Vim.defineMotion("orgPasteBefore", (_cm, head) => head);
      Vim.defineOperator("orgIndent", stockIndent);
      Vim.defineOperator("orgDelete", stockDelete(Vim));
    };
  }

  // Obsidian's Vim drops the Alt modifier on macOS, so Option-j reaches it as
  // plain `j`. Catch Alt-j/Alt-k before any editor handler sees them and give
  // vim <A-j>/<A-k> directly, which keeps counts and `.` working.
  handleAltMove(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const key = e.code === "KeyJ" || e.key === "j" ? "<A-j>" : e.code === "KeyK" || e.key === "k" ? "<A-k>" : null;
    const Vim = this.patchedVim;
    if (!key || !Vim) return;
    const md = this.app.workspace.getActiveViewOfType(MarkdownView);
    const view = md && md.editor ? md.editor.cm : null;
    if (!view || !view.dom.contains(e.target)) return;
    const cm = view.cm;
    const vim = cm && cm.state && cm.state.vim;
    if (!vim || vim.insertMode || vim.visualMode || vim.inputState.operator) return;
    // A pending count is kept in the key buffer.
    if (!/^\d*$/.test(vim.inputState.keyBuffer.join(""))) return;
    e.preventDefault();
    e.stopPropagation();
    Vim.handleKey(cm, key, "user");
  }

  onunload() {
    if (this.restoreVim) this.restoreVim();
  }

  async onload() {
    // The Vim engine can be replaced at runtime (e.g. by the vim-motions
    // plugin), so re-check whenever the active editor changes.
    this.app.workspace.onLayoutReady(() => this.installVimOverrides());
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.installVimOverrides()));
    this.registerDomEvent(document, "keydown", (e) => this.handleAltMove(e), { capture: true });
    const handle = (view, fn) => {
      if (!normalMode(view, this.app)) return false;
      try {
        return fn(view);
      } catch (e) {
        console.error("Evil Org:", e);
        return false;
      }
    };
    this.registerEditorExtension([
      Prec.highest(
        keymap.of([
          {
            key: "Tab",
            run: (view) => handle(view, localCycle),
            shift: (view) => handle(view, globalCycle),
          },
        ])
      ),
      EditorState.transactionFilter.of((tr) => keepSelectedFoldsClosed(tr, this.app)),
      invertedEffects.of(deletedFolds),
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet || !visualLineMode(update.view, this.app)) return;
        if (!foldExtendedSelection(update.state)) return;
        // Vim is still mid-command here; adjust once it has finished. The
        // change then counts as external, so vim re-syncs its own selection
        // (used by d/y/c/>) from ours.
        const view = update.view;
        queueMicrotask(() => {
          if (!visualLineMode(view, this.app)) return;
          const next = foldExtendedSelection(view.state);
          if (next) view.dispatch({ selection: EditorSelection.single(next.anchor, next.head) });
        });
      }),
    ]);
    this.addCommand({
      id: "cycle-local",
      name: "Cycle fold under cursor (org TAB)",
      editorCallback: (editor) => {
        const view = editor.cm;
        if (view) handle(view, localCycle);
      },
    });
    this.addCommand({
      id: "cycle-global",
      name: "Cycle global fold overview (org S-TAB)",
      editorCallback: (editor) => {
        const view = editor.cm;
        if (view) handle(view, globalCycle);
      },
    });
    for (const [id, name, forward] of [
      ["move-subtree-down", "Move subtree down (org M-↓)", true],
      ["move-subtree-up", "Move subtree up (org M-↑)", false],
    ]) {
      this.addCommand({
        id,
        name,
        editorCallback: (editor) => {
          if (editor.cm) moveSubtree(editor.cm, forward, 1);
        },
      });
    }
  }
};
