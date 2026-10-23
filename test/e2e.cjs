"use strict";
// End-to-end tests: the plugin's main.js running against a real CodeMirror 6
// editor with codemirror-vim, in jsdom, with a stubbed `obsidian` module.

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const g = globalThis;
for (const k of ["window", "document", "Window", "Node", "HTMLElement", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  if (!(k in g) || k === "window" || k === "document") g[k] = dom.window[k];
}
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
dom.window.document.createRange = () => {
  const r = new dom.window.Range();
  r.getClientRects = () => [];
  r.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  return r;
};

const { EditorState, EditorSelection, StateField, StateEffect } = require("@codemirror/state");
const { EditorView, Decoration, WidgetType, runScopeHandlers, ViewPlugin } = require("@codemirror/view");
const { foldable, foldService, foldedRanges, foldEffect, codeFolding } = require("@codemirror/language");
const { markdown } = require("@codemirror/lang-markdown");
const { history, undo } = require("@codemirror/commands");
const { vim, Vim, getCM, CodeMirror } = require("@replit/codemirror-vim");

let activeView = null;
class Plugin {
  constructor(app) { this.app = app; this.extensions = []; this.commands = []; }
  registerEditorExtension(ext) { this.extensions.push(ext); }
  registerEvent() {}
  registerDomEvent(el, type, fn, options) { el.addEventListener(type, fn, options); }
  addCommand(cmd) { this.commands.push(cmd); }
  addSettingTab() {}
  async loadData() { return null; }
  async saveData() {}
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Setting {}
class MarkdownView {}
// Obsidian's Live Preview flag; a test that wants Live Preview adds it.
const editorLivePreviewField = StateField.define({ create: () => true, update: (v) => v });
// Obsidian's search highlights, as its editor keeps them: marks in a field,
// added and filtered by effects, one mark for every highlight of a class.
// A test that wants them adds highlightField.
const addHighlight = StateEffect.define();
const filterHighlights = StateEffect.define();
const highlightMarks = new Map();
const highlightField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addHighlight)) deco = deco.update({ add: e.value, sort: true });
      else if (e.is(filterHighlights)) deco = deco.update({ filter: e.value });
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
function editorFor(view) {
  return {
    cm: view,
    offsetToPos: (offset) => offset,
    addHighlights(ranges, cls, removePrevious) {
      if (!highlightMarks.has(cls)) highlightMarks.set(cls, Decoration.mark({ class: cls }));
      const mark = highlightMarks.get(cls);
      const effects = removePrevious ? [filterHighlights.of((from, to, value) => value !== mark)] : [];
      effects.push(addHighlight.of(ranges.map((r) => mark.range(r.from, r.to))));
      this.cm.dispatch({ effects });
    },
  };
}
const app = {
  workspace: {
    getActiveViewOfType: () => (activeView ? { editor: editorFor(activeView) } : null),
    getLeavesOfType: () => (activeView ? [{ view: { editor: editorFor(activeView) } }] : []),
    onLayoutReady: (cb) => cb(),
    on: () => ({}),
    updateOptions: () => {},
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "obsidian") return { Plugin, MarkdownView, PluginSettingTab, Setting, editorLivePreviewField };
  return origLoad.call(this, request, ...rest);
};
// Obsidian's adapter is the class itself, with the engine on it.
CodeMirror.Vim = Vim;
window.CodeMirrorAdapter = CodeMirror;
Vim.suppressErrorLogging = true;

const PluginClass = require(path.join(__dirname, "..", "main.js"));
const plugin = new PluginClass(app);
plugin.onload();

const tick = () => new Promise((r) => setTimeout(r, 0));

function open(text, extra = []) {
  if (activeView) activeView.destroy();
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  activeView = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [vim(), history(), markdown(), codeFolding(), plugin.extensions, extra],
    }),
  });
  return activeView;
}

async function keys(view, seq) {
  const cm = getCM(view);
  for (const k of seq.match(/<[^>]+>|./g)) {
    if (k === "<Tab>" || k === "<S-Tab>") {
      const event = new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: k === "<S-Tab>" });
      runScopeHandlers(view, event, "editor");
    } else if (k === "<Enter>") {
      // A real keydown, as the browser sends it: the plugin's capture
      // listener on the document, then vim's and the keymaps' handlers.
      view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
    } else {
      Vim.handleKey(cm, k, "user");
    }
    await tick();
  }
  await tick();
}

function gotoLine(view, n) {
  view.dispatch({ selection: { anchor: view.state.doc.line(n).from } });
}

function fold(view, n) {
  const line = view.state.doc.line(n);
  const r = foldable(view.state, line.from, line.to);
  assert.ok(r, `line ${n} is foldable`);
  view.dispatch({ effects: foldEffect.of(r) });
}

// 1-based numbers of the lines whose sections are folded.
function foldedLines(view) {
  const out = [];
  const it = foldedRanges(view.state).iter();
  while (it.value) {
    out.push(view.state.doc.lineAt(it.from).number);
    it.next();
  }
  return out;
}

const text = (view) => view.state.doc.toString();

// 1-based numbers of the lines no closed fold hides.
function visibleLines(view) {
  const doc = view.state.doc;
  const folds = [];
  const it = foldedRanges(view.state).iter();
  for (; it.value; it.next()) folds.push({ from: it.from, to: it.to });
  const out = [];
  for (let n = 1; n <= doc.lines; n++) {
    const pos = doc.line(n).from;
    if (!folds.some((f) => f.from < pos && f.to >= pos)) out.push(n);
  }
  return out;
}

const DOC = [
  "# A",      // 1
  "a",        // 2
  "## B",     // 3
  "b",        // 4
  "### C",    // 5
  "c",        // 6
  "## D",     // 7
  "d",        // 8
].join("\n");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- existing behaviour -----------------------------------------------------

// org-cycle (Tab) and org-global-cycle (S-Tab), as in
// https://orgmode.org/manual/Global-and-local-cycling.html. A cycle goes on to
// its next state only when it is pressed again right away; anything else in
// between starts it over.

test("Tab cycles folded -> children -> subtree -> folded", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 7, 8]);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4, 5, 7, 8]);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4, 5, 6, 7, 8]);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 7, 8]);
});

test("Tab after a pending operator is left to vim", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "d<Tab>");
  assert.deepEqual(foldedLines(v), []);
});

test("Tab on an open heading with a folded subheading folds it", async () => {
  const v = open(DOC);
  fold(v, 5);
  gotoLine(v, 3);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 7, 8]);
});

test("Tab in children view after another command folds the subtree", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "<Tab><Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4, 5, 7, 8]);
  gotoLine(v, 4);
  gotoLine(v, 3);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 7, 8]);
});

test("Tab on a heading without subheadings cycles folded -> subtree", async () => {
  const v = open(DOC);
  gotoLine(v, 7);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4, 5, 6, 7]);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4, 5, 6, 7, 8]);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4, 5, 6, 7]);
});

test("Tab in children view shows every direct child, also past a deeper first one", async () => {
  const v = open("# A\na\n### X\nx\n## Y\ny\n### Z\nz");
  await keys(v, "<Tab><Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 5]);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("Tab on an empty heading does nothing", async () => {
  const v = open("# A\n# B\nb");
  await keys(v, "<Tab>");
  assert.deepEqual(foldedLines(v), []);
});

// Obsidian's editor has no code block folds of its own, unlike the markdown
// mode here, so check the plugin's range without it.
test("Tab on a code fence folds and unfolds the block", async () => {
  const doc = "x\n```js\na\n\nb\n```\ny\n  ~~~\n  c\n---";
  const state = EditorState.create({ doc, extensions: [plugin.extensions] });
  const range = (n) => foldable(state, state.doc.line(n).from, state.doc.line(n).to);
  assert.deepEqual(range(2), { from: state.doc.line(2).to, to: state.doc.line(6).to });
  assert.deepEqual(range(8), { from: state.doc.line(8).to, to: state.doc.length });
  for (const n of [1, 3, 6, 7]) assert.equal(range(n), null, `line ${n}`);
  assert.equal(foldable(EditorState.create({ doc: "---\na: 1\n---\nx", extensions: [plugin.extensions] }), 0, 3), null);

  const v = open(doc);
  gotoLine(v, 2);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 7, 8, 9, 10]);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("Tab leaves folded list items in the subtree folded", async () => {
  const v = open("# A\n- x\n  - y\n# B\nb");
  fold(v, 2);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 4, 5]);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 4, 5]);
});

// Vim Motions adds a heading fold service that ends at the last non-blank
// line. Folds are Obsidian's, blank lines before the next heading included.
test("Tab and S-Tab hide the blank lines under a heading with another fold service", async () => {
  const trimmed = foldService.of((state, from, to) => {
    const doc = state.doc;
    const n = doc.lineAt(from).number;
    const level = (doc.line(n).text.match(/^#+ /) || [""])[0].length;
    if (!level) return null;
    let last = n;
    for (let i = n + 1; i <= doc.lines; i++) {
      const m = doc.line(i).text.match(/^#+ /);
      if (m && m[0].length <= level) break;
      if (doc.line(i).text.trim()) last = i;
    }
    return last > n ? { from: to, to: doc.line(last).to } : null;
  });
  if (activeView) activeView.destroy();
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const v = (activeView = new EditorView({
    parent,
    state: EditorState.create({
      doc: "# A\na\n\n## B\nb\n\n# C\nc",
      extensions: [vim(), history(), markdown(), codeFolding(), trimmed, plugin.extensions],
    }),
  }));
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 7, 8]);
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4, 7, 8]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1, 7]);
});

test("S-Tab cycles overview -> contents -> show all -> overview", async () => {
  const v = open(DOC);
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1, 3, 5, 7]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4, 5, 6, 7, 8]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1]);
});

test("S-Tab after another command goes to overview", async () => {
  const v = open(DOC);
  await keys(v, "<S-Tab>");
  await keys(v, "<Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 7]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1, 3, 5, 7]);
});

test("S-Tab with some headings folded by hand goes to overview", async () => {
  const v = open("# A\na\n\n# B\nb");
  gotoLine(v, 4);
  await keys(v, "<Tab>");
  assert.deepEqual(foldedLines(v), [4]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [1, 4]);
});

test("S-Tab overview shows the first heading's level and shallower ones after it", async () => {
  const v = open("## A\na\n# B\nb\n## C\nc");
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1, 3]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1, 3, 5]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4, 5, 6]);
});

test("S-Tab on headings all at one level still has three states", async () => {
  const v = open("# A\na\n# B\nb");
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1, 3]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1, 3]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 3, 4]);
});

test("S-Tab leaves text before the first heading visible", async () => {
  const v = open("intro\n# A\na\n# B\nb");
  await keys(v, "<S-Tab>");
  assert.deepEqual(visibleLines(v), [1, 2, 4]);
});

test("S-Tab moves the cursor out of the text it folds", async () => {
  const v = open(DOC);
  gotoLine(v, 6);
  await keys(v, "<S-Tab>");
  assert.equal(v.state.selection.main.head, 0);
  assert.deepEqual(visibleLines(v), [1]);
});

test("dd on a folded heading deletes the subtree", async () => {
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "dd");
  assert.equal(text(v), "# A\na\n## D\nd");
});

test("yy on a folded heading, p pastes after the fold, folded", async () => {
  const v = open(DOC);
  fold(v, 7);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "yyp");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n## B\nb\n### C\nc\n## D\nd");
  assert.deepEqual(foldedLines(v), [3, 7, 11]);
});

test("Vd on a folded heading deletes the subtree", async () => {
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "Vd");
  assert.equal(text(v), "# A\na\n## D\nd");
});

test("V starting inside a fold closed under it grows to the fold's heading", async () => {
  const v = open(DOC);
  gotoLine(v, 5);
  await keys(v, "V");
  fold(v, 3);
  await keys(v, "Gd");
  assert.equal(text(v), "# A\na");
});

// Vim Motions' vim build draws V mode's lines itself and leaves the editor
// only a cursor at the start of the head's line.
async function withCursorOnlyVisualLine(fn) {
  const stock = CodeMirror.prototype.setSelections;
  CodeMirror.prototype.setSelections = function (ranges, primary) {
    const vs = this.state.vim;
    if (vs && vs.visualMode && vs.visualLine && ranges.length === 1) return this.setCursor(ranges[0].head.line, 0);
    return stock.call(this, ranges, primary);
  };
  try {
    await fn();
  } finally {
    CodeMirror.prototype.setSelections = stock;
  }
}

// 1-based lines of vim's own V selection, anchor then head.
function visualLines(view) {
  const { anchor, head } = getCM(view).state.vim.sel;
  return [anchor.line + 1, head.line + 1];
}

test("V keeps its anchor when vim leaves the editor only a cursor", async () => {
  await withCursorOnlyVisualLine(async () => {
    const v = open("- a\n- b\n- c");
    gotoLine(v, 1);
    await keys(v, "V2G");
    assert.deepEqual(visualLines(v), [1, 2]);
  });
});

test("V onto a folded heading takes in the fold when vim leaves the editor only a cursor", async () => {
  await withCursorOnlyVisualLine(async () => {
    const v = open(DOC);
    fold(v, 3);
    gotoLine(v, 1);
    await keys(v, "V3G");
    assert.deepEqual(visualLines(v), [1, 6]);
  });
});

// --- undo brings folds back --------------------------------------------------

test("u after dd on a folded heading restores it folded", async () => {
  const v = open(DOC);
  fold(v, 5);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "ddu");
  assert.equal(text(v), DOC);
  assert.deepEqual(foldedLines(v), [3, 5]);
});

test("u after Vd on a folded heading restores it folded", async () => {
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "Vdu");
  assert.equal(text(v), DOC);
  assert.deepEqual(foldedLines(v), [3]);
});

test("u after dd on a folded section at the end restores it folded", async () => {
  const v = open(DOC);
  fold(v, 7);
  gotoLine(v, 7);
  await keys(v, "ddu");
  assert.equal(text(v), DOC);
  assert.deepEqual(foldedLines(v), [7]);
});

test("u, <C-r>, u after dd still restores the fold", async () => {
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "ddu<C-r>");
  assert.equal(text(v), "# A\na\n## D\nd");
  await keys(v, "u");
  assert.equal(text(v), DOC);
  assert.deepEqual(foldedLines(v), [3]);
});

test("u after dd on an open heading leaves it open", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "ddu");
  assert.equal(text(v), DOC);
  assert.deepEqual(foldedLines(v), []);
});

// --- deleting at the end of the note -----------------------------------------

test("dd on a folded section at the end leaves no blank line", async () => {
  const v = open(DOC);
  fold(v, 7);
  gotoLine(v, 7);
  await keys(v, "dd");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc");
  await keys(v, "u");
  assert.equal(text(v), DOC);
});

test("2dd over the last two lines leaves no blank line", async () => {
  const v = open(DOC);
  gotoLine(v, 7);
  await keys(v, "2dd");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc");
});

test("dd at the end keeps the folded section above closed, cursor on it", async () => {
  const v = open(DOC);
  fold(v, 7);
  fold(v, 3);
  gotoLine(v, 7);
  await keys(v, "dd");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc");
  assert.deepEqual(foldedLines(v), [3]);
  assert.equal(v.state.doc.lineAt(v.state.selection.main.head).number, 3);
});

test("dd then p at the end puts the section back", async () => {
  const v = open(DOC);
  fold(v, 7);
  gotoLine(v, 7);
  await keys(v, "ddp");
  assert.equal(text(v), DOC);
});

test("cc on a folded section at the end keeps a line to type on", async () => {
  const v = open(DOC);
  fold(v, 7);
  gotoLine(v, 7);
  await keys(v, "cc");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n");
});

test("Vd on a folded section at the end leaves no blank line", async () => {
  const v = open(DOC);
  fold(v, 7);
  fold(v, 3);
  gotoLine(v, 7);
  await keys(v, "Vd");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc");
  assert.deepEqual(foldedLines(v), [3]);
  assert.equal(v.state.doc.lineAt(v.state.selection.main.head).number, 3);
  await keys(v, "u");
  assert.equal(text(v), DOC);
});

test("Vx, VD and VX over the last lines leave no blank line", async () => {
  for (const op of ["x", "D", "X"]) {
    const v = open(DOC);
    gotoLine(v, 7);
    await keys(v, "VG" + op);
    assert.equal(text(v), "# A\na\n## B\nb\n### C\nc", `V${op}`);
  }
});

test("Vd at the end then p puts the lines back", async () => {
  const v = open(DOC);
  gotoLine(v, 6);
  await keys(v, "VGd");
  assert.equal(text(v), "# A\na\n## B\nb\n### C");
  await keys(v, "p");
  assert.equal(text(v), DOC);
});

test("2dd over the last lines of a note ending in a newline", async () => {
  const v = open("# A\na\nb\n");
  gotoLine(v, 3);
  await keys(v, "2dd");
  assert.equal(text(v), "# A\na");
});

test(". repeats dd at the end", async () => {
  const v = open(DOC);
  fold(v, 7);
  gotoLine(v, 7);
  await keys(v, "dd.");
  assert.equal(text(v), "# A\na\n## B\nb\n### C");
});

test("dw, d$ and dd in the middle delete as usual", async () => {
  const v = open("# A\none two\nb");
  gotoLine(v, 2);
  await keys(v, "dw");
  assert.equal(text(v), "# A\ntwo\nb");
  await keys(v, "d$");
  assert.equal(text(v), "# A\n\nb");
  await keys(v, "dd");
  assert.equal(text(v), "# A\nb");
});

// --- >> / << ----------------------------------------------------------------

test(">> on an open heading demotes just that heading", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, ">>");
  assert.equal(text(v), "# A\na\n### B\nb\n### C\nc\n## D\nd");
});

test(">> on a folded heading demotes the subtree and keeps it folded", async () => {
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, ">>");
  assert.equal(text(v), "# A\na\n### B\nb\n#### C\nc\n## D\nd");
  assert.deepEqual(foldedLines(v), [3]);
  assert.equal(v.state.doc.lineAt(v.state.selection.main.head).number, 3);
});

test("<< on a folded heading promotes the subtree", async () => {
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "<<");
  assert.equal(text(v), "# A\na\n# B\nb\n## C\nc\n## D\nd");
  // The fold still ends at c; ## D, now under # B, stays visible.
  assert.deepEqual(foldedLines(v), [3]);
  assert.equal(foldedRanges(v.state).iter().to, v.state.doc.line(6).to);
});

test("<< on a level-1 heading and >> on a level-6 heading do nothing", async () => {
  const v = open("# A\na\n###### F\nf");
  await keys(v, "<<");
  gotoLine(v, 3);
  await keys(v, ">>");
  assert.equal(text(v), "# A\na\n###### F\nf");
});

test(">> on a folded subtree with a level-6 heading changes nothing", async () => {
  const v = open("##### a\n###### b\nx\n##### c");
  fold(v, 1);
  gotoLine(v, 1);
  await keys(v, ">>");
  assert.equal(text(v), "##### a\n###### b\nx\n##### c");
  assert.deepEqual(foldedLines(v), [1]);
});

test("<< on a folded subtree whose root is level 1 changes nothing", async () => {
  const v = open("# A\n## B\nb\n# C");
  fold(v, 1);
  gotoLine(v, 1);
  await keys(v, "<<");
  assert.equal(text(v), "# A\n## B\nb\n# C");
  assert.deepEqual(foldedLines(v), [1]);
});

test("V2> refuses to take a level-5 heading past 6, V> still demotes it", async () => {
  const v = open("##### a\nx");
  await keys(v, "V2>");
  assert.equal(text(v), "##### a\nx");
  await keys(v, "V>");
  assert.equal(text(v), "###### a\nx");
});

test("a line of seven #s is body text: >> indents it, ar goes past it", async () => {
  const v = open("## A\n####### x\n## B");
  gotoLine(v, 2);
  await keys(v, ">>");
  assert.match(v.state.doc.line(2).text, /^\s+####### x$/);
  await keys(v, "u");
  await keys(v, "dar");
  assert.equal(text(v), "## B");
});

test("3>> shifts every heading in three lines", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "3>>");
  assert.equal(text(v), "# A\na\n### B\nb\n#### C\nc\n## D\nd");
});

test("V> over headings and body shifts headings only", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "V6G>"); // G, not j: jsdom has no layout for j
  assert.equal(text(v), "# A\na\n### B\nb\n#### C\nc\n## D\nd");
});

test("V> from a body line over a heading demotes it and leaves body lines alone", async () => {
  const v = open(DOC);
  gotoLine(v, 2);
  await keys(v, "V3G>");
  assert.equal(text(v), "# A\na\n### B\nb\n### C\nc\n## D\nd");
});

test("V> from a body line over no heading still indents", async () => {
  const v = open("# A\na\nb\n## B");
  gotoLine(v, 2);
  await keys(v, "V3G>");
  assert.match(v.state.doc.line(2).text, /^\s+a$/);
  assert.match(v.state.doc.line(3).text, /^\s+b$/);
  assert.equal(v.state.doc.line(4).text, "## B");
});

test(". repeats and u undoes in one step", async () => {
  const v = open(DOC);
  gotoLine(v, 7);
  await keys(v, ">>.");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n#### D\nd");
  await keys(v, "u");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n### D\nd");
  await keys(v, "u");
  assert.equal(text(v), DOC);
});

const CODE = "## A\n```sh\n# comment\n```\n## B\nb";

test(">ar, V> and 3>> leave # lines in code blocks alone", async () => {
  for (const seq of [">ar", "V3G>", "3>>"]) {
    const v = open(CODE);
    await keys(v, seq);
    assert.equal(text(v), "### A\n```sh\n# comment\n```\n## B\nb", seq);
  }
});

test(">> on a # line in front matter indents it, not demotes it", async () => {
  const v = open("---\n# note: yaml\n---\n## A\na");
  gotoLine(v, 2);
  await keys(v, ">>");
  assert.match(v.state.doc.line(2).text, /^\s+# note: yaml$/);
});

test(">> after an unclosed --- on line 1 demotes the heading", async () => {
  const v = open("---\n# A\na\n# B\nb");
  gotoLine(v, 2);
  await keys(v, ">>");
  assert.equal(text(v), "---\n## A\na\n# B\nb");
});

test("a pasted subtree with a # line in a code block arrives folded", async () => {
  const v = open(CODE);
  await keys(v, "yarGp");
  assert.equal(text(v), CODE + "\n" + CODE.split("\n").slice(0, 4).join("\n"));
  assert.deepEqual(foldedLines(v), [7]);
});

test(">> and << on a body line still indent", async () => {
  const v = open(DOC);
  gotoLine(v, 4);
  await keys(v, ">>");
  assert.match(v.state.doc.line(4).text, /^\s+b$/);
  await keys(v, "<<");
  assert.equal(text(v), DOC);
});

test("> and < in visual block mode shift the text right of the block, as in vim", async () => {
  const v = open("abc\ndef");
  gotoLine(v, 1);
  await keys(v, "l<C-v>j>");
  assert.equal(text(v), "a    bc\nd    ef");
  assert.equal(v.state.selection.main.head, 1);
  await keys(v, "<C-v>j<");
  assert.equal(text(v), "abc\ndef");
  const w = open("a\t  bc\nd ef");
  gotoLine(w, 1);
  await keys(w, "l<C-v>j2<");
  assert.equal(text(w), "abc\ndef");
});

test("> in visual block mode shifts headings and items as columns too", async () => {
  const v = open("# A\n## B\n- x");
  gotoLine(v, 1);
  await keys(v, "<C-v>jj>");
  assert.equal(text(v), "    # A\n    ## B\n    - x");
});

// --- M-j / M-k ----------------------------------------------------------------

const cursorLine = (view) => view.state.doc.lineAt(view.state.selection.main.head).number;

test("M-j swaps a subtree with the next sibling, M-k swaps it back", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "<A-j>");
  assert.equal(text(v), "# A\na\n## D\nd\n## B\nb\n### C\nc");
  assert.equal(cursorLine(v), 5);
  await keys(v, "<A-k>");
  assert.equal(text(v), DOC);
  assert.equal(cursorLine(v), 3);
});

test("M-j and M-k stop at the last sibling and the parent", async () => {
  const v = open(DOC);
  gotoLine(v, 7);
  await keys(v, "<A-j>");
  gotoLine(v, 3);
  await keys(v, "<A-k>");
  gotoLine(v, 5);
  await keys(v, "<A-j><A-k>");
  gotoLine(v, 1);
  await keys(v, "<A-j><A-k>");
  assert.equal(text(v), DOC);
});

test("M-j keeps moved subtrees folded", async () => {
  const v = open(DOC);
  fold(v, 7);
  fold(v, 5);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "<A-j>");
  assert.equal(text(v), "# A\na\n## D\nd\n## B\nb\n### C\nc");
  assert.deepEqual(foldedLines(v), [3, 5, 7]);
  assert.equal(cursorLine(v), 5);
});

test("M-j keeps blank lines between subtrees in place", async () => {
  const v = open("# A\n\n## B\nb\n\n## C\nc\n\n# Z");
  gotoLine(v, 3);
  await keys(v, "<A-j>");
  assert.equal(text(v), "# A\n\n## C\nc\n\n## B\nb\n\n# Z");
  await keys(v, "<A-k>");
  assert.equal(text(v), "# A\n\n## B\nb\n\n## C\nc\n\n# Z");
});

test("M-j with blank lines keeps folds closed through u and <C-r>", async () => {
  const doc = "# A\n\n## B\nb\n\n## C\nc\n\n# Z";
  const v = open(doc);
  fold(v, 6);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "<A-j>");
  assert.equal(text(v), "# A\n\n## C\nc\n\n## B\nb\n\n# Z");
  assert.deepEqual(foldedLines(v), [3, 6]);
  await keys(v, "u");
  assert.equal(text(v), doc);
  assert.deepEqual(foldedLines(v), [3, 6]);
  await keys(v, "<C-r>");
  assert.equal(text(v), "# A\n\n## C\nc\n\n## B\nb\n\n# Z");
  assert.deepEqual(foldedLines(v), [3, 6]);
});

test("M-j re-closes folds that run over trailing blank lines", async () => {
  // Obsidian's heading folds may take in trailing blank lines; lang-markdown's don't.
  const doc = "## B\nb\n\n## C\nc\n\n# Z";
  const v = open(doc);
  const d = v.state.doc;
  v.dispatch({ effects: [
    foldEffect.of({ from: d.line(1).to, to: d.line(3).to }),
    foldEffect.of({ from: d.line(4).to, to: d.line(6).to }),
  ] });
  await keys(v, "<A-j>");
  assert.equal(text(v), "## C\nc\n\n## B\nb\n\n# Z");
  assert.deepEqual(foldedLines(v), [1, 4]);
  await keys(v, "u");
  assert.equal(text(v), doc);
  assert.deepEqual(foldedLines(v), [1, 4]);
});

// macOS Option-j: the key is "∆", the code "KeyJ". A vim build that strips the
// Alt modifier reads that as plain `j`, so the event must not reach the
// editor's own handlers. jsdom reports no platform, so CodeMirror's isMac is
// false here: this asserts the plugin intercepts, not that vim would misread.
const OPTION_KEYS = { h: "˙", j: "∆", k: "˚", l: "¬" };

function optionKey(view, letter) {
  return altKeydown(view, OPTION_KEYS[letter], `Key${letter.toUpperCase()}`);
}

function altKeydown(view, key, code) {
  const event = new window.KeyboardEvent("keydown", {
    key, code, altKey: true, bubbles: true, cancelable: true,
  });
  let reached = false;
  const spy = () => { reached = true; };
  view.contentDOM.addEventListener("keydown", spy);
  view.contentDOM.dispatchEvent(event);
  view.contentDOM.removeEventListener("keydown", spy);
  event.reachedEditor = reached;
  return event;
}

test("an Option-j keydown moves the subtree, with a count", async () => {
  const v = open("## A\n## B\n## C\n## D");
  const event = optionKey(v, "j");
  await tick();
  assert.ok(event.defaultPrevented);
  assert.ok(!event.reachedEditor);
  assert.equal(text(v), "## B\n## A\n## C\n## D");
  await keys(v, "2");
  optionKey(v, "j");
  await tick();
  assert.equal(text(v), "## B\n## C\n## D\n## A");
  optionKey(v, "k");
  await tick();
  assert.equal(text(v), "## B\n## C\n## A\n## D");
  await keys(v, ".");
  assert.equal(text(v), "## B\n## A\n## C\n## D");
});

// On Colemak, Alt-n sits where QWERTY's J is: the code is "KeyJ", the key "n".
test("an Alt-n keydown on Colemak is left alone", async () => {
  const v = open("## A\n## B");
  const event = altKeydown(v, "n", "KeyJ");
  await tick();
  assert.ok(!event.defaultPrevented);
  assert.ok(event.reachedEditor);
  assert.equal(text(v), "## A\n## B");
});

// On Colemak, j sits where QWERTY's Y is: the key decides, not the code.
test("an Alt-j keydown moves the subtree whatever its code", async () => {
  const v = open("## A\n## B");
  const event = altKeydown(v, "j", "KeyY");
  await tick();
  assert.ok(event.defaultPrevented);
  assert.equal(text(v), "## B\n## A");
});

test("an Option-j keydown in insert mode is left alone", async () => {
  const v = open("## A\n## B");
  await keys(v, "i");
  const event = optionKey(v, "j");
  await tick();
  assert.ok(event.reachedEditor);
  assert.equal(text(v), "## A\n## B");
});

test("a count moves past that many siblings", async () => {
  const v = open("## A\n## B\n## C\n## D");
  await keys(v, "2<A-j>");
  assert.equal(text(v), "## B\n## C\n## A\n## D");
  await keys(v, "5<A-j>");
  assert.equal(text(v), "## B\n## C\n## D\n## A");
});

test(". repeats M-j and u undoes it in one step, folds and all", async () => {
  const v = open("## A\na\n## B\nb\n## C\nc");
  fold(v, 1);
  gotoLine(v, 1);
  await keys(v, "<A-j>.");
  assert.equal(text(v), "## B\nb\n## C\nc\n## A\na");
  assert.deepEqual(foldedLines(v), [5]);
  await keys(v, "u");
  assert.equal(text(v), "## B\nb\n## A\na\n## C\nc");
  assert.deepEqual(foldedLines(v), [3]);
  await keys(v, "u");
  assert.equal(text(v), "## A\na\n## B\nb\n## C\nc");
  assert.deepEqual(foldedLines(v), [1]);
});

test("# lines in a code block don't end a subtree", async () => {
  const v = open("## A\n```sh\n# comment\n```\n## B\nb");
  await keys(v, "<A-j>");
  assert.equal(text(v), "## B\nb\n## A\n```sh\n# comment\n```");
});

test("M-j on a body line moves the line, over a folded heading as one line", async () => {
  const v = open(DOC);
  fold(v, 7);
  gotoLine(v, 6);
  await keys(v, "<A-j>");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\n## D\nd\nc");
  assert.equal(cursorLine(v), 8);
  gotoLine(v, 2);
  await keys(v, "<A-k>");
  assert.equal(text(v), "a\n# A\n## B\nb\n### C\n## D\nd\nc");
});

test("M-k moves a body line over a folded code block, and the block back", async () => {
  const v = open("# A\nx\n```\ncode\n```\ny");
  fold(v, 3);
  gotoLine(v, 6);
  await keys(v, "<A-k>");
  assert.equal(text(v), "# A\nx\ny\n```\ncode\n```");
  assert.deepEqual(foldedLines(v), [4]);
  gotoLine(v, 4);
  await keys(v, "<A-k>");
  assert.equal(text(v), "# A\nx\n```\ncode\n```\ny");
  assert.deepEqual(foldedLines(v), [3]);
});

test("a count with M-k moves back past subtrees and blank lines, folds and all", async () => {
  const v = open("# T\n## A\n### A1\na\n\n## B\nb\n\n## C\nc");
  fold(v, 3);
  gotoLine(v, 9);
  await keys(v, "2<A-k>");
  assert.equal(text(v), "# T\n## C\nc\n\n## A\n### A1\na\n\n## B\nb");
  assert.deepEqual(foldedLines(v), [6]);
  assert.equal(cursorLine(v), 2);
  gotoLine(v, 9);
  await keys(v, "5<A-k>");
  assert.equal(text(v), "# T\n## B\nb\n\n## C\nc\n\n## A\n### A1\na");
  assert.deepEqual(foldedLines(v), [9]);
  assert.equal(cursorLine(v), 2);
});

test("a count moves a body line past that many lines, a closed fold counting as one", async () => {
  const v = open("# A\nx\n```\ncode\n```\ny\nz");
  fold(v, 3);
  gotoLine(v, 2);
  await keys(v, "2<A-j>");
  assert.equal(text(v), "# A\n```\ncode\n```\ny\nx\nz");
  assert.deepEqual(foldedLines(v), [2]);
  assert.equal(cursorLine(v), 6);
  await keys(v, "2<A-k>");
  assert.equal(text(v), "# A\nx\n```\ncode\n```\ny\nz");
  assert.deepEqual(foldedLines(v), [3]);
  assert.equal(cursorLine(v), 2);
});

test("M-j on the last line and M-k on the first line do nothing", async () => {
  const v = open("x\ny");
  gotoLine(v, 2);
  await keys(v, "<A-j>");
  gotoLine(v, 1);
  await keys(v, "<A-k>");
  assert.equal(text(v), "x\ny");
  assert.equal(cursorLine(v), 1);
});

// --- M-j / M-k on list items ---------------------------------------------------------

// Fold the sub-items of the item on line n, through line last.
function foldItem(view, n, last) {
  view.dispatch({ effects: foldEffect.of({ from: view.state.doc.line(n).to, to: view.state.doc.line(last).to }) });
}

test("M-j swaps a list item and its sub-items with the next item, M-k swaps it back", async () => {
  const doc = "# T\n- a\n  - a1\n  more\n- b\n  - b1\n- c";
  const v = open(doc);
  gotoLine(v, 2);
  await keys(v, "<A-j>");
  assert.equal(text(v), "# T\n- b\n  - b1\n- a\n  - a1\n  more\n- c");
  assert.equal(cursorLine(v), 4);
  await keys(v, "<A-k>");
  assert.equal(text(v), doc);
  assert.equal(cursorLine(v), 2);
});

test("M-j on a sub-item or a body line moves the item it is in", async () => {
  let v = open("- a\n  - a1\n  - a2\n- b");
  gotoLine(v, 2);
  await keys(v, "<A-j>");
  assert.equal(text(v), "- a\n  - a2\n  - a1\n- b");
  assert.equal(cursorLine(v), 3);
  v = open("- a\n  more\n- b");
  gotoLine(v, 2);
  await keys(v, "<A-j>");
  assert.equal(text(v), "- b\n- a\n  more");
  assert.equal(cursorLine(v), 3);
});

test("an item doesn't move out of its parent item or its list", async () => {
  const doc = "text\n- a\n  - a1\n  - a2\n- b\n* c\n\nafter";
  const v = open(doc);
  for (const [n, seq] of [[2, "<A-k>"], [3, "<A-k>"], [4, "<A-j>"], [5, "<A-j>"], [6, "<A-j><A-k>"]]) {
    gotoLine(v, n);
    await keys(v, seq);
    assert.equal(text(v), doc, `${seq} on line ${n}`);
  }
});

test("M-j keeps blank lines between items in place", async () => {
  const v = open("- a\n\n- b\n  b more\n\n- c");
  await keys(v, "<A-j>");
  assert.equal(text(v), "- b\n  b more\n\n- a\n\n- c");
  gotoLine(v, 6);
  await keys(v, "<A-k>");
  assert.equal(text(v), "- b\n  b more\n\n- c\n\n- a");
});

test("M-j keeps a folded item folded, through u", async () => {
  const doc = "- a\n\t- a1\n\t- a2\n- b\n\t- b1";
  const v = open(doc);
  foldItem(v, 1, 3);
  await keys(v, "<A-j>");
  assert.equal(text(v), "- b\n\t- b1\n- a\n\t- a1\n\t- a2");
  assert.deepEqual(foldedLines(v), [3]);
  assert.equal(cursorLine(v), 3);
  await keys(v, "u");
  assert.equal(text(v), doc);
  assert.deepEqual(foldedLines(v), [1]);
});

test("a count moves an item past that many items, and . repeats it", async () => {
  const v = open("- a\n- b\n- c\n- d\n- e");
  await keys(v, "2<A-j>");
  assert.equal(text(v), "- b\n- c\n- a\n- d\n- e");
  await keys(v, ".");
  assert.equal(text(v), "- b\n- c\n- d\n- e\n- a");
  await keys(v, "u");
  assert.equal(text(v), "- b\n- c\n- a\n- d\n- e");
});

test("M-j and M-k renumber a numbered list from its first number", async () => {
  let v = open("1. a\n2. b\n3. c");
  await keys(v, "<A-j>");
  assert.equal(text(v), "1. b\n2. a\n3. c");
  await keys(v, "<A-j>");
  assert.equal(text(v), "1. b\n2. c\n3. a");
  await keys(v, "u");
  assert.equal(text(v), "1. b\n2. a\n3. c");
  v = open("8. a\n   1. a1\n   2. a2\n\n9. b\n10. c");
  gotoLine(v, 6);
  await keys(v, "2<A-k>");
  // The blank line between the items passed over moves with them.
  assert.equal(text(v), "8. c\n9. a\n   1. a1\n   2. a2\n\n10. b");
  assert.equal(cursorLine(v), 1);
  gotoLine(v, 3);
  await keys(v, "<A-j>");
  assert.equal(text(v), "8. c\n9. a\n   1. a2\n   2. a1\n\n10. b");
});

test("M-j moves checkbox items in a tab-indented list", async () => {
  const v = open("- [ ] a\n\t- [x] a1\n- [x] b");
  await keys(v, "<A-j>");
  assert.equal(text(v), "- [x] b\n- [ ] a\n\t- [x] a1");
});

// --- >> / << on list items -------------------------------------------------------------

test(">> puts an item and its sub-items under the item above, << takes them back", async () => {
  const doc = "- a\n- b\n  - b1\n  more\n- c";
  const v = open(doc);
  gotoLine(v, 2);
  await keys(v, ">>");
  assert.equal(text(v), "- a\n  - b\n    - b1\n    more\n- c");
  assert.equal(v.state.selection.main.head, v.state.doc.line(2).from + 2);
  await keys(v, "<<");
  assert.equal(text(v), doc);
});

test("<< on a top-level item does nothing, on a nested one takes it out one level", async () => {
  let v = open("- a\n  - b\n    - c");
  await keys(v, "<<");
  assert.equal(text(v), "- a\n  - b\n    - c");
  gotoLine(v, 3);
  await keys(v, "<<");
  assert.equal(text(v), "- a\n  - b\n  - c");
  // The items after it become its sub-items.
  v = open("- p\n  - x\n  - y\n  - z");
  gotoLine(v, 3);
  await keys(v, "<<");
  assert.equal(text(v), "- p\n  - x\n- y\n  - z");
});

test(">> joins the sub-items of the item above, with their indent", async () => {
  let v = open("- a\n\t- a1\n- b\n\t- b1");
  gotoLine(v, 3);
  await keys(v, ">>");
  assert.equal(text(v), "- a\n\t- a1\n\t- b\n\t\t- b1");
  v = open("- a\n    - a1\n- b");
  gotoLine(v, 3);
  await keys(v, ">>");
  assert.equal(text(v), "- a\n    - a1\n    - b");
});

test(">> indents with a tab if the note's lists do, else to the text of the item above", async () => {
  let v = open("- a\n\t- x\n\n- b\n- c");
  gotoLine(v, 5);
  await keys(v, ">>");
  assert.equal(text(v), "- a\n\t- x\n\n- b\n\t- c");
  v = open("1. a\n2. b\n\n* [ ] c\n* [ ] d\n\n10) e\n11) f");
  for (const n of [2, 5, 8]) {
    gotoLine(v, n);
    await keys(v, ">>");
  }
  assert.equal(text(v), "1. a\n   1. b\n\n* [ ] c\n  * [ ] d\n\n10) e\n    1) f");
});

test(">> and << renumber the numbered lists the item leaves and joins", async () => {
  const doc = "1. a\n   1. a1\n2. b\n   more\n3. c\n4. d";
  const v = open(doc);
  gotoLine(v, 3);
  await keys(v, ">>");
  assert.equal(text(v), "1. a\n   1. a1\n   2. b\n      more\n2. c\n3. d");
  await keys(v, "<<");
  assert.equal(text(v), doc);
  // Outdented, it follows its parent; the items after it become its sub-items
  // and start at 1.
  const w = open("1. p\n   1. x\n   2. y\n   3. z\n2. q");
  gotoLine(w, 3);
  await keys(w, "<<");
  assert.equal(text(w), "1. p\n   1. x\n2. y\n   1. z\n3. q");
});

test(">> on a folded item shifts it with its sub-items and keeps it folded", async () => {
  const v = open("- a\n- [x] b\n\t- b1\n\t\t- b2\n- c");
  foldItem(v, 2, 4);
  gotoLine(v, 2);
  await keys(v, ">>");
  assert.equal(text(v), "- a\n\t- [x] b\n\t\t- b1\n\t\t\t- b2\n- c");
  assert.deepEqual(foldedLines(v), [2]);
  await keys(v, "u");
  assert.equal(text(v), "- a\n- [x] b\n\t- b1\n\t\t- b2\n- c");
  assert.deepEqual(foldedLines(v), [2]);
});

test("3>>, V> and . shift items alike, and u undoes each in one step", async () => {
  const doc = "- p\n- a\n  - a1\n- b\n- c";
  let v = open(doc);
  gotoLine(v, 2);
  await keys(v, "3>>");
  assert.equal(text(v), "- p\n  - a\n    - a1\n  - b\n- c");
  await keys(v, "u");
  assert.equal(text(v), doc);
  v = open(doc);
  gotoLine(v, 2);
  await keys(v, "V5G>");
  assert.equal(text(v), "- p\n  - a\n    - a1\n  - b\n  - c");
  await keys(v, "u");
  assert.equal(text(v), doc);
  gotoLine(v, 4);
  await keys(v, ">>");
  gotoLine(v, 5);
  await keys(v, ".");
  assert.equal(text(v), "- p\n- a\n  - a1\n  - b\n  - c");
  await keys(v, "u");
  assert.equal(text(v), "- p\n- a\n  - a1\n  - b\n- c");
});

test("V< with a count outdents items that many levels, not past the top", async () => {
  const v = open("- a\n  - b\n    - c\n      - d");
  gotoLine(v, 3);
  await keys(v, "V4G2<");
  assert.equal(text(v), "- a\n  - b\n- c\n  - d");
  gotoLine(v, 3);
  await keys(v, "V4G3<");
  assert.equal(text(v), "- a\n  - b\n- c\n- d");
});

test(">> on an item's body line or next to a list indents the line as usual", async () => {
  const v = open("- a\n  more\npara");
  for (const n of [2, 3]) {
    gotoLine(v, n);
    await keys(v, ">>");
  }
  assert.equal(text(v), "- a\n    more\n  para");
});

// --- ar / ir -------------------------------------------------------------------

test("dar deletes the subtree around the cursor, dir its body", async () => {
  let v = open(DOC);
  gotoLine(v, 4);
  await keys(v, "dar");
  assert.equal(text(v), "# A\na\n## D\nd");
  v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "dir");
  assert.equal(text(v), "# A\na\n## B\n## D\nd");
});

test("ar takes trailing blank lines, ir leaves blank lines around the body", async () => {
  let v = open("## B\n\nb\n\n## D");
  await keys(v, "dar");
  assert.equal(text(v), "## D");
  v = open("## B\n\nb\n\n## D");
  await keys(v, "dir");
  assert.equal(text(v), "## B\n\n\n## D");
});

test("d2ar deletes the parent subtree, d3ar the grandparent's", async () => {
  let v = open(DOC + "\n# Z");
  gotoLine(v, 6);
  await keys(v, "d2ar");
  assert.equal(text(v), "# A\na\n## D\nd\n# Z");
  v = open(DOC + "\n# Z");
  gotoLine(v, 6);
  await keys(v, "d3ar");
  assert.equal(text(v), "# Z");
});

test("dar at the end of the note leaves no blank line", async () => {
  const v = open(DOC);
  gotoLine(v, 8);
  await keys(v, "dar");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc");
});

test("dir on a heading without a body does nothing", async () => {
  const v = open("## A\n## B\nb");
  await keys(v, "dir");
  assert.equal(text(v), "## A\n## B\nb");
});

test("yar then p pastes the subtree folded", async () => {
  const v = open(DOC);
  gotoLine(v, 7);
  await keys(v, "yarGp");
  assert.equal(text(v), DOC + "\n## D\nd");
  assert.deepEqual(foldedLines(v), [9]);
});

test(">ar demotes every heading in an open subtree", async () => {
  const v = open(DOC);
  gotoLine(v, 4);
  await keys(v, ">ar");
  assert.equal(text(v), "# A\na\n### B\nb\n#### C\nc\n## D\nd");
});

test("var selects the subtree, ar again the parent", async () => {
  let v = open(DOC + "\n# Z");
  gotoLine(v, 6);
  await keys(v, "vard");
  assert.equal(text(v), "# A\na\n## B\nb\n## D\nd\n# Z");
  v = open(DOC + "\n# Z");
  gotoLine(v, 6);
  await keys(v, "vararard");
  assert.equal(text(v), "# Z");
});

// On a table row ar/ir are the row and its inside, as in Vim Motions.
const TABLE = "# T\n## S\n| a | b |\n| - | - |\n| c | d |\n\n## U";

test("dar on a table row deletes the row's text, dir the text between its pipes", async () => {
  let v = open(TABLE);
  gotoLine(v, 5);
  await keys(v, "dar");
  assert.equal(text(v), "# T\n## S\n| a | b |\n| - | - |\n\n\n## U");
  v = open(TABLE);
  gotoLine(v, 5);
  await keys(v, "dir");
  assert.equal(text(v), "# T\n## S\n| a | b |\n| - | - |\n||\n\n## U");
});

test("yar on a table row yanks the row, vir selects between the pipes", async () => {
  assert.equal(await yanked(TABLE, 3, "ar", 4), "| a | b |");
  const v = open(TABLE);
  gotoLine(v, 3);
  await keys(v, "vir");
  assert.equal(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to), " a | b ");
  await keys(v, "d");
  assert.equal(text(v), "# T\n## S\n||\n| - | - |\n| c | d |\n\n## U");
});

test("ir on a table row skips escaped pipes but not one after an escaped backslash", async () => {
  assert.equal(await yanked("| a \\| b | c |", 1, "ir"), " a \\| b | c ");
  assert.equal(await yanked("| a | b \\|", 1, "ir"), " a ");
  assert.equal(await yanked("| a | b \\\\|", 1, "ir"), " a | b \\\\");
  assert.equal(await yanked("# T\n||", 2, "ir"), "");
});

test("ar on a table row in a code block is the subtree", async () => {
  const doc = "## S\n```\n| a | b |\n```\n## U";
  const v = open(doc);
  gotoLine(v, 3);
  await keys(v, "dar");
  assert.equal(text(v), "## U");
});

test("on a table row 2ar and ar again in visual mode are the subtree", async () => {
  let v = open(TABLE);
  gotoLine(v, 5);
  await keys(v, "d2ar");
  assert.equal(text(v), "# T\n## U");
  v = open(TABLE);
  gotoLine(v, 5);
  await keys(v, "d3ar");
  assert.equal(text(v), "");
  v = open(TABLE);
  gotoLine(v, 5);
  await keys(v, "varard");
  assert.equal(text(v), "# T\n## U");
  v = open(TABLE);
  gotoLine(v, 5);
  await keys(v, "virird");
  assert.equal(text(v), "# T\n## S\n\n## U");
  v = open(TABLE);
  gotoLine(v, 5);
  await keys(v, "Vard");
  assert.equal(text(v), "# T\n## U");
});

// --- org table navigation: Tab, S-Tab and Enter in a table -------------------

// The line and column of the cursor, 1-based line.
const cursorAt = (view) => {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return [line.number, head - line.from];
};

const NAV = "# T\n| a | bb |\n|-|:-:|\n| c | d |\n\ntext";
const NAV_ALIGNED = "# T\n| a   | bb  |\n| --- | :-: |\n| c   |  d  |\n\ntext";

test("Tab in a table aligns it and goes to the next cell, past the delimiter row", async () => {
  const v = open(NAV);
  gotoLine(v, 2);
  await keys(v, "<Tab>");
  assert.equal(text(v), NAV_ALIGNED);
  assert.deepEqual(cursorAt(v), [2, 8]);
  await keys(v, "<Tab>");
  assert.deepEqual(cursorAt(v), [4, 2]);
  await keys(v, "<Tab>");
  assert.deepEqual(cursorAt(v), [4, 9]);
  assert.deepEqual(foldedLines(v), []);
});

test("Tab in the last cell adds an empty row and goes to its first cell", async () => {
  const v = open(NAV);
  gotoLine(v, 4);
  await keys(v, "$<Tab>");
  assert.equal(text(v), "# T\n| a   | bb  |\n| --- | :-: |\n| c   |  d  |\n|     |     |\n\ntext");
  assert.deepEqual(cursorAt(v), [5, 2]);
});

test("S-Tab goes to the previous cell, past the delimiter row, and stays in the first", async () => {
  const v = open(NAV);
  gotoLine(v, 4);
  await keys(v, "<S-Tab>");
  assert.equal(text(v), NAV_ALIGNED);
  assert.deepEqual(cursorAt(v), [2, 8]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(cursorAt(v), [2, 2]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(cursorAt(v), [2, 2]);
  assert.deepEqual(foldedLines(v), []);
});

test("Tab and Enter go into a later row of dashes, a row of cells like any other", async () => {
  const v = open("| h | i |\n|---|---|\n| - | - |\n| 1 | 2 |");
  gotoLine(v, 1);
  await keys(v, "<Tab>");
  assert.equal(text(v), "| h   | i   |\n| --- | --- |\n| -   | -   |\n| 1   | 2   |");
  await keys(v, "<Tab>");
  assert.deepEqual(cursorAt(v), [3, 2]);
  await keys(v, "<Tab>");
  assert.deepEqual(cursorAt(v), [3, 8]);
  await keys(v, "<S-Tab><Enter>");
  assert.deepEqual(cursorAt(v), [4, 2]);
});

test("Enter in a table goes to the same column in the next row, adding a row at the end", async () => {
  const v = open(NAV);
  gotoLine(v, 2);
  await keys(v, "fb<Enter>");
  assert.equal(text(v), NAV_ALIGNED);
  assert.deepEqual(cursorAt(v), [4, 9]);
  await keys(v, "<Enter>");
  assert.equal(text(v), "# T\n| a   | bb  |\n| --- | :-: |\n| c   |  d  |\n|     |     |\n\ntext");
  assert.deepEqual(cursorAt(v), [5, 8]);
});

test("u undoes each table key in one step", async () => {
  const v = open(NAV);
  gotoLine(v, 4);
  await keys(v, "<Enter>");
  await keys(v, "<Tab>");
  await keys(v, "<Tab>");
  assert.equal(v.state.doc.lines, 8);
  await keys(v, "u");
  assert.equal(text(v), "# T\n| a   | bb  |\n| --- | :-: |\n| c   |  d  |\n|     |     |\n\ntext");
  await keys(v, "u");
  assert.equal(text(v), NAV);
});

test("Enter outside a table, with a count, or in visual mode is vim's", async () => {
  // jsdom has no layout, so where vim's `j` lands isn't checked here.
  let v = open("a\n  b\n| x |\n| y |\n| z |\nc");
  await keys(v, "<Enter>");
  assert.notEqual(cursorAt(v)[0], 1);
  gotoLine(v, 3);
  await keys(v, "2<Enter>");
  assert.equal(text(v), "a\n  b\n| x |\n| y |\n| z |\nc");
  v = open("| x |\n| y |");
  await keys(v, "v<Tab><Enter><Esc>");
  assert.equal(text(v), "| x |\n| y |");
});

test("Tab, S-Tab and Enter in a table work in insert mode too", async () => {
  const v = open(NAV);
  gotoLine(v, 2);
  await keys(v, "a");
  await keys(v, "<Tab>");
  type(v, "xyz");
  await keys(v, "<Tab>");
  assert.equal(text(v), "# T\n| a   | xyzbb |\n| --- | :---: |\n| c   |   d   |\n\ntext");
  assert.deepEqual(cursorAt(v), [4, 2]);
  await keys(v, "<Enter>");
  assert.deepEqual(cursorAt(v), [5, 2]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(cursorAt(v), [4, 10]);
  assert.ok(insertMode(v));
});

test("Tab and Enter add the delimiter row below the first row of a table without one", async () => {
  let v = open("# T\n| a | bb |\n\ntext");
  gotoLine(v, 2);
  await keys(v, "<Tab>");
  assert.equal(text(v), "# T\n| a   | bb  |\n| --- | --- |\n\ntext");
  assert.deepEqual(cursorAt(v), [2, 8]);
  await keys(v, "<Tab>");
  assert.equal(text(v), "# T\n| a   | bb  |\n| --- | --- |\n|     |     |\n\ntext");
  assert.deepEqual(cursorAt(v), [4, 2]);
  v = open("| a | bb |");
  await keys(v, "A<Enter>");
  assert.equal(text(v), "| a   | bb  |\n| --- | --- |\n|     |     |");
  assert.deepEqual(cursorAt(v), [3, 8]);
  assert.ok(insertMode(v));
  await keys(v, "<Esc>u");
  assert.equal(text(v), "| a | bb |");
});

test("the delimiter row Tab and Enter add goes below the first row, keeping its indent", async () => {
  let v = open("  | a | b |\n| c | d |");
  gotoLine(v, 2);
  await keys(v, "<Enter>");
  assert.equal(text(v), "  | a   | b   |\n  | --- | --- |\n  | c   | d   |\n  |     |     |");
  assert.deepEqual(cursorAt(v), [4, 4]);
  v = open("| a | b |\n| c | d |");
  gotoLine(v, 2);
  await keys(v, "<S-Tab>");
  assert.equal(text(v), "| a   | b   |\n| --- | --- |\n| c   | d   |");
  assert.deepEqual(cursorAt(v), [1, 8]);
  v = open("| a | b |");
  await keys(v, "<S-Tab>");
  assert.equal(text(v), "| a   | b   |\n| --- | --- |");
  assert.deepEqual(cursorAt(v), [1, 2]);
});

test("Tab and Enter keep a table's delimiter row and add no other", async () => {
  let v = open("| a | bb |\n| :-: | -: |\n| c |");
  gotoLine(v, 3);
  await keys(v, "<Tab>");
  assert.equal(text(v), "|  a  |  bb |\n| :-: | --: |\n|  c  |     |");
  v = open("| a | b |\n| x | - |");
  gotoLine(v, 2);
  await keys(v, "$<Tab>");
  assert.equal(text(v), "| a   | b   |\n| --- | --- |\n| x   | -   |\n|     |     |");
});

test("Tab off a table still cycles folds, and a | line in a code block isn't a table", async () => {
  let v = open("# A\n| x |\n# B\nb");
  await keys(v, "<Tab>");
  assert.deepEqual(foldedLines(v), [1]);
  v = open("```\n| a |  b |\n```");
  gotoLine(v, 2);
  await keys(v, "<Tab><Enter>");
  assert.equal(text(v), "```\n| a |  b |\n```");
});

test("aligning pads by the delimiter's colons, keeps escaped pipes and indent, and closes rows", async () => {
  const v = open("  | a | b | c |\n|:-|-:|:-:|\n| long \\| x | 1 |\n| y |no end");
  await keys(v, "<Tab>");
  assert.equal(text(v), [
    "  | a         |      b |  c  |",
    "  | :-------- | -----: | :-: |",
    "  | long \\| x |      1 |     |",
    "  | y         | no end |     |",
  ].join("\n"));
});

test("aligning counts wide characters twice", async () => {
  const v = open("| 漢字 | x |\n|-|-|\n| a | bbbb |");
  await keys(v, "<Tab>");
  assert.equal(text(v), "| 漢字 | x    |\n| ---- | ---- |\n| a    | bbbb |");
});

test("ar on a line under a heading that only contains a pipe is still the subtree", async () => {
  const v = open("# T\n## S\na | b\n|\n## U");
  gotoLine(v, 3);
  await keys(v, "dar");
  assert.equal(text(v), "# T\n## U");
  const w = open("# T\n## S\n|\n## U");
  gotoLine(w, 3);
  await keys(w, "dar");
  assert.equal(text(w), "# T\n## U");
});

// --- org table structure: M-h/j/k/l, the arrows, and their Shift forms -------

// An Alt keydown as the browser sends it, from the plugin's capture listener
// on: "h", "S-h" (key "H"), "Left", "S-Left". With option, the key macOS
// gives for Option and that letter, which isn't a letter.
const ARROW_KEYS = { h: "ArrowLeft", j: "ArrowDown", k: "ArrowUp", l: "ArrowRight" };
const OPTION_SHIFT_KEYS = { h: "Ó", j: "Ô", k: "", l: "Ò" };
const ARROW_NAMES = { Left: "h", Down: "j", Up: "k", Right: "l" };

function metaKey(view, name, { option = false, ctrl = false } = {}) {
  const shiftKey = name.startsWith("S-");
  const base = name.replace(/^S-/, "");
  const letter = ARROW_NAMES[base] || base;
  const key = ARROW_NAMES[base] ? ARROW_KEYS[letter]
    : option ? (shiftKey ? OPTION_SHIFT_KEYS : OPTION_KEYS)[letter]
    : shiftKey ? letter.toUpperCase() : letter;
  const code = ARROW_NAMES[base] ? ARROW_KEYS[letter] : `Key${letter.toUpperCase()}`;
  const event = new window.KeyboardEvent("keydown", {
    key, code, altKey: !ctrl, ctrlKey: ctrl, shiftKey, bubbles: true, cancelable: true,
  });
  let reached = false;
  const spy = () => { reached = true; };
  view.contentDOM.addEventListener("keydown", spy);
  view.contentDOM.dispatchEvent(event);
  view.contentDOM.removeEventListener("keydown", spy);
  event.reachedEditor = reached;
  return event;
}

async function metaKeys(view, names, options) {
  for (const name of names.split(" ")) {
    if (/^\d+$/.test(name)) await keys(view, name);
    else metaKey(view, name, options);
    await tick();
  }
}

const TBL = "# T\n| a | b | c |\n|:-|-:|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\ntext";
const tableLines = (view) => text(view).split("\n").filter((l) => l.startsWith("|"));

// The cursor on line n, in the cell holding text t.
function gotoCell(view, n, t) {
  const line = view.state.doc.line(n);
  view.dispatch({ selection: { anchor: line.from + line.text.indexOf(t) } });
}

test("M-h and M-l move the column, its alignment and the cursor with it", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  await metaKeys(v, "l");
  assert.deepEqual(tableLines(v), [
    "| a   | c   |   b |",
    "| :-- | --- | --: |",
    "| 1   | 3   |   2 |",
    "| 4   | 6   |   5 |",
  ]);
  assert.deepEqual(cursorAt(v), [4, 16]);
  await metaKeys(v, "h h");
  assert.deepEqual(tableLines(v), [
    "|   b | a   | c   |",
    "| --: | :-- | --- |",
    "|   2 | 1   | 3   |",
    "|   5 | 4   | 6   |",
  ]);
  assert.deepEqual(cursorAt(v), [4, 4]);
});

test("with the Meta key on Ctrl, Ctrl takes Alt's keys and Alt is left alone", async () => {
  await plugin.setSetting("metaModifier", "ctrl");
  try {
    const v = open(TBL);
    gotoCell(v, 4, "2");
    let event = metaKey(v, "l");
    await tick();
    assert.ok(event.reachedEditor);
    assert.equal(text(v), TBL);
    await metaKeys(v, "l 2 S-j", { ctrl: true });
    assert.deepEqual(tableLines(v), [
      "| a   | c   |   b |",
      "| :-- | --- | --: |",
      "|     |     |     |",
      "|     |     |     |",
      "| 1   | 3   |   2 |",
      "| 4   | 6   |   5 |",
    ]);
    const h = open("## A\n## B\n## C");
    event = metaKey(h, "j", { option: true });
    await tick();
    assert.ok(event.reachedEditor);
    assert.equal(text(h), "## A\n## B\n## C");
    event = metaKey(h, "j", { ctrl: true });
    await tick();
    assert.ok(event.defaultPrevented);
    assert.equal(text(h), "## B\n## A\n## C");
    await keys(h, ".");
    assert.equal(text(h), "## B\n## C\n## A");
    await metaKeys(h, "k", { ctrl: true });
    assert.equal(text(h), "## B\n## A\n## C");
  } finally {
    await plugin.setSetting("metaModifier", "alt");
  }
});

test("M-← and M-→ move the column; it stops at either edge", async () => {
  const v = open(TBL);
  gotoCell(v, 2, "a");
  await metaKeys(v, "Left");
  assert.equal(text(v), TBL);
  await metaKeys(v, "Right Right Right");
  assert.deepEqual(tableLines(v)[0], "|   b | c   | a   |");
  assert.deepEqual(cursorAt(v), [2, 14]);
});

test("a count moves the column that many places, as far as it can", async () => {
  const v = open(TBL);
  gotoCell(v, 2, "a");
  await metaKeys(v, "2 l");
  assert.deepEqual(tableLines(v)[0], "|   b | c   | a   |");
  await metaKeys(v, "5 h");
  assert.deepEqual(tableLines(v)[0], "| a   |   b | c   |");
});

test("M-j and M-k move the row, but not across the delimiter row", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  await metaKeys(v, "j");
  assert.deepEqual(tableLines(v), [
    "| a   |   b | c   |",
    "| :-- | --: | --- |",
    "| 4   |   5 | 6   |",
    "| 1   |   2 | 3   |",
  ]);
  assert.deepEqual(cursorAt(v), [5, 10]);
  await metaKeys(v, "j");
  assert.deepEqual(cursorAt(v), [5, 10]);
  await metaKeys(v, "k k");
  assert.deepEqual(tableLines(v)[2], "| 1   |   2 | 3   |");
  assert.deepEqual(cursorAt(v), [4, 10]);
  gotoCell(v, 2, "a");
  await metaKeys(v, "j");
  assert.deepEqual(tableLines(v)[0], "| a   |   b | c   |");
  gotoLine(v, 3);
  await metaKeys(v, "k j");
  assert.deepEqual(tableLines(v)[1], "| :-- | --: | --- |");
});

test("M-j and M-k move a later row of dashes, and other rows across it", async () => {
  const v = open("| h |\n|---|\n| 1 |\n| - |\n| 2 |");
  gotoLine(v, 3);
  await keys(v, "2<A-j>");
  assert.equal(text(v), "| h   |\n| --- |\n| -   |\n| 2   |\n| 1   |");
  assert.deepEqual(cursorAt(v), [5, 2]);
  gotoLine(v, 3);
  await keys(v, "<A-j>");
  assert.equal(text(v), "| h   |\n| --- |\n| 2   |\n| -   |\n| 1   |");
  assert.deepEqual(cursorAt(v), [4, 2]);
});

test("M-↓ and M-↑ move the row; 2<A-k> moves it two rows, . repeats", async () => {
  const v = open("| h |\n|---|\n| 1 |\n| 2 |\n| 3 |\n| 4 |");
  gotoLine(v, 3);
  await metaKeys(v, "Down");
  assert.equal(text(v), "| h   |\n| --- |\n| 2   |\n| 1   |\n| 3   |\n| 4   |");
  gotoLine(v, 6);
  await keys(v, "2<A-k>");
  assert.equal(text(v), "| h   |\n| --- |\n| 2   |\n| 4   |\n| 1   |\n| 3   |");
  assert.deepEqual(cursorAt(v), [4, 2]);
  await metaKeys(v, "Up");
  await keys(v, ".");
  assert.equal(text(v), "| h   |\n| --- |\n| 4   |\n| 2   |\n| 1   |\n| 3   |");
});

test("a table without a delimiter row moves any row", async () => {
  const v = open("| a |\n| b |");
  gotoLine(v, 2);
  await metaKeys(v, "k");
  assert.equal(text(v), "| b |\n| a |");
  assert.deepEqual(cursorAt(v), [1, 2]);
});

test("M-S-h deletes the column, its alignment too; the last column stays", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  await metaKeys(v, "S-h");
  assert.deepEqual(tableLines(v), ["| a   | c   |", "| :-- | --- |", "| 1   | 3   |", "| 4   | 6   |"]);
  assert.deepEqual(cursorAt(v), [4, 8]);
  await metaKeys(v, "S-Left");
  assert.deepEqual(tableLines(v), ["| a   |", "| :-- |", "| 1   |", "| 4   |"]);
  assert.deepEqual(cursorAt(v), [4, 2]);
  await metaKeys(v, "S-h");
  assert.deepEqual(tableLines(v), ["| a   |", "| :-- |", "| 1   |", "| 4   |"]);
});

test("M-S-l inserts an empty column left of the cursor's and goes to it", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  await metaKeys(v, "S-l");
  assert.deepEqual(tableLines(v), [
    "| a   |     |   b | c   |",
    "| :-- | --- | --: | --- |",
    "| 1   |     |   2 | 3   |",
    "| 4   |     |   5 | 6   |",
  ]);
  assert.deepEqual(cursorAt(v), [4, 8]);
  await metaKeys(v, "2 S-Right");
  assert.deepEqual(tableLines(v)[0], "| a   |     |     |     |   b | c   |");
  assert.deepEqual(cursorAt(v), [4, 8]);
});

test("M-S-k deletes the row; never the delimiter row or the only header row", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  await metaKeys(v, "S-k");
  assert.deepEqual(tableLines(v), ["| a   |   b | c   |", "| :-- | --: | --- |", "| 4   |   5 | 6   |"]);
  assert.deepEqual(cursorAt(v), [4, 10]);
  await metaKeys(v, "S-Up");
  assert.deepEqual(tableLines(v), ["| a   |   b | c   |", "| :-- | --: | --- |"]);
  assert.deepEqual(cursorAt(v), [3, 8]);
  assert.equal(text(v), "# T\n| a   |   b | c   |\n| :-- | --: | --- |\n\ntext");
  await metaKeys(v, "S-k");
  gotoLine(v, 2);
  await metaKeys(v, "S-k");
  assert.equal(text(v), "# T\n| a   |   b | c   |\n| :-- | --: | --- |\n\ntext");
});

test("M-S-k at the end goes up a row; with a count it deletes that many", async () => {
  let v = open(TBL);
  gotoCell(v, 5, "5");
  await metaKeys(v, "S-k");
  assert.deepEqual(cursorAt(v), [4, 10]);
  v = open("| h |\n|---|\n| 1 |\n| 2 |\n| 3 |\n| 4 |");
  gotoLine(v, 4);
  await metaKeys(v, "2 S-k");
  assert.equal(text(v), "| h   |\n| --- |\n| 1   |\n| 4   |");
  v = open("| a |\n| b |");
  await metaKeys(v, "S-k S-k");
  assert.equal(text(v), "| b |");
});

test("M-S-j inserts an empty row above the cursor's, or below the header", async () => {
  const v = open(TBL);
  gotoCell(v, 5, "5");
  await metaKeys(v, "S-j");
  assert.deepEqual(tableLines(v), [
    "| a   |   b | c   |",
    "| :-- | --: | --- |",
    "| 1   |   2 | 3   |",
    "|     |     |     |",
    "| 4   |   5 | 6   |",
  ]);
  assert.deepEqual(cursorAt(v), [5, 8]);
  gotoCell(v, 2, "a");
  await metaKeys(v, "S-Down");
  assert.deepEqual(tableLines(v).slice(0, 3), ["| a   |   b | c   |", "| :-- | --: | --- |", "|     |     |     |"]);
  assert.deepEqual(cursorAt(v), [4, 2]);
  gotoLine(v, 3);
  await metaKeys(v, "2 S-j");
  assert.equal(tableLines(v).length, 8);
  assert.deepEqual(cursorAt(v), [4, 2]);
});

test("u undoes each table edit in one step", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  await metaKeys(v, "l S-j S-h");
  await keys(v, "uuu");
  assert.equal(text(v), TBL);
});

test("macOS Option keys, with and without Shift, edit the table", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  const event = metaKey(v, "l", { option: true });
  await tick();
  assert.ok(event.defaultPrevented);
  assert.ok(!event.reachedEditor);
  assert.deepEqual(tableLines(v)[2], "| 1   | 3   |   2 |");
  await metaKeys(v, "S-l S-h j", { option: true });
  assert.deepEqual(tableLines(v).slice(2), ["| 4   | 6   |   5 |", "| 1   | 3   |   2 |"]);
});

test("off a table, Alt-h/l, the Alt arrows and the Shift forms are left alone", async () => {
  const v = open("## A\n## B\nx | y");
  for (const name of ["h", "l", "Left", "Right", "Up", "Down", "S-h", "S-j", "S-k", "S-l", "S-Left", "S-Down"]) {
    const event = metaKey(v, name);
    await tick();
    assert.ok(!event.defaultPrevented, name);
    assert.ok(event.reachedEditor, name);
  }
  assert.equal(text(v), "## A\n## B\nx | y");
  metaKey(v, "j");
  await tick();
  assert.equal(text(v), "## B\nx | y\n## A");
});

test("in a table, the table keys are left alone in insert and visual mode", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  await keys(v, "i");
  let event = metaKey(v, "l");
  assert.ok(event.reachedEditor);
  await keys(v, "<Esc>v");
  event = metaKey(v, "S-k");
  assert.ok(event.reachedEditor);
  await keys(v, "<Esc>");
  assert.equal(text(v), TBL);
});

// In Live Preview a table's cells are editors of their own, inside the
// note's editor; a keydown in one has that editor's content as its target.
test("in a table, Alt keys from inside the editor but not its content are left alone", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  const cellEditor = document.createElement("div");
  v.dom.appendChild(cellEditor);
  for (const [key, code] of [["∆", "KeyJ"], ["¬", "KeyL"], ["ArrowUp", "ArrowUp"]]) {
    const event = new window.KeyboardEvent("keydown", { key, code, altKey: true, bubbles: true, cancelable: true });
    cellEditor.dispatchEvent(event);
    await tick();
    assert.ok(!event.defaultPrevented, key);
  }
  assert.equal(text(v), TBL);
});

test("M-j in a table under a heading moves the row, not the subtree", async () => {
  const v = open("## A\n| x |\n| y |\n## B");
  gotoLine(v, 2);
  await keys(v, "<A-j>");
  assert.equal(text(v), "## A\n| y |\n| x |\n## B");
  gotoLine(v, 1);
  await keys(v, "<A-j>");
  assert.equal(text(v), "## B\n## A\n| y |\n| x |");
});

// --- yy, dd, p and P on table rows -------------------------------------------

const unnamed = () => Vim.getRegisterController().getRegister('"');

test("yy yanks a row as a line, and p and P paste it as a row and align the table", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  await keys(v, "yy");
  assert.equal(unnamed().toString(), "| 1 | 2 | 3 |\n");
  assert.ok(unnamed().linewise);
  gotoLine(v, 5);
  await keys(v, "p");
  assert.deepEqual(tableLines(v), [
    "| a   |   b | c   |",
    "| :-- | --: | --- |",
    "| 1   |   2 | 3   |",
    "| 4   |   5 | 6   |",
    "| 1   |   2 | 3   |",
  ]);
  assert.deepEqual(cursorAt(v), [6, 2]);
  gotoLine(v, 4);
  await keys(v, "P");
  assert.deepEqual(tableLines(v).slice(2, 4), ["| 1   |   2 | 3   |", "| 1   |   2 | 3   |"]);
  assert.deepEqual(cursorAt(v), [4, 2]);
  assert.ok(text(v).endsWith("\n\ntext"));
});

test("o and O in a table insert an empty row below or above, in the cursor's column", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  await keys(v, "o");
  assert.ok(insertMode(v));
  assert.deepEqual(tableLines(v), [
    "| a   |   b | c   |",
    "| :-- | --: | --- |",
    "| 1   |   2 | 3   |",
    "|     |     |     |",
    "| 4   |   5 | 6   |",
  ]);
  assert.deepEqual(cursorAt(v), [5, 8]);
  type(v, "x");
  await keys(v, "<Esc>");
  gotoCell(v, 6, "6");
  await keys(v, "O");
  type(v, "y");
  await keys(v, "<Esc>");
  assert.deepEqual(tableLines(v).slice(3), ["|     |   x |     |", "|     |     | y    |", "| 4   |   5 | 6   |"]);
  assert.ok(text(v).endsWith("\n\ntext"));
  const w = open(TBL);
  gotoLine(w, 5);
  await keys(w, "o<Esc>u");
  assert.equal(text(w), TBL);
});

test("o and O in the header or on the delimiter row insert below the delimiter row", async () => {
  for (const [line, key] of [[2, "o"], [2, "O"], [3, "o"], [3, "O"]]) {
    const v = open(TBL);
    gotoLine(v, line);
    await keys(v, key);
    assert.deepEqual(tableLines(v).slice(2, 4), ["|     |     |     |", "| 1   |   2 | 3   |"], `${key} on line ${line}`);
    assert.equal(v.state.doc.lineAt(v.state.selection.main.head).number, 4);
  }
});

test("o with a count in a table inserts that many rows, and . repeats it", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  await keys(v, "3o");
  type(v, "x");
  await keys(v, "<Esc>");
  const opened = [
    "| a   |   b | c   |",
    "| :-- | --: | --- |",
    "| 1   |   2 | 3   |",
    "|     |   x |     |",
    "|     |   x |     |",
    "|     | x    |     |",
    "| 4   |   5 | 6   |",
  ];
  assert.deepEqual(tableLines(v), opened);
  assert.ok(text(v).endsWith("\n\ntext"));
  await keys(v, ".");
  const repeated = tableLines(v);
  assert.equal(repeated.length, opened.length + 1);
  assert.deepEqual(repeated.slice(0, 5), opened.slice(0, 5));
  assert.equal(repeated[6].split("|")[2].trim(), "x");
  assert.deepEqual(repeated.at(-1), "| 4   |   5 | 6   |");
  assert.ok(text(v).endsWith("\n\ntext"));
  await keys(v, "u");
  assert.deepEqual(tableLines(v), opened);
  assert.ok(text(v).endsWith("\n\ntext"));
});

test("p and P in the header or on the delimiter row paste below the delimiter row", async () => {
  for (const [line, key] of [[2, "p"], [2, "P"], [3, "p"], [3, "P"]]) {
    const v = open(TBL);
    gotoLine(v, 5);
    await keys(v, "yy");
    gotoLine(v, line);
    await keys(v, key);
    assert.deepEqual(tableLines(v).slice(0, 4), [
      "| a   |   b | c   |",
      "| :-- | --: | --- |",
      "| 4   |   5 | 6   |",
      "| 1   |   2 | 3   |",
    ], `${key} on line ${line}`);
    assert.deepEqual(cursorAt(v), [4, 2]);
  }
});

test("a row pasted from another table takes this table's columns; a count pastes copies", async () => {
  const v = open("| x | y |\n|---|---|\n| long one | z |\n\n| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |");
  gotoLine(v, 3);
  await keys(v, "yy");
  gotoLine(v, 7);
  await keys(v, "2p");
  assert.deepEqual(text(v).split("\n").slice(4), [
    "| a        | b   | c   |",
    "| -------- | --- | --- |",
    "| 1        | 2   | 3   |",
    "| long one | z   |     |",
    "| long one | z   |     |",
  ]);
  await keys(v, "u");
  assert.equal(text(v).split("\n").slice(4).join("\n"), "| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |");
});

test("p of lines that aren't all table rows, or off a table, is vim's paste", async () => {
  let v = open("text\n| a |\n|---|\n| 1 |");
  gotoLine(v, 1);
  await keys(v, "yy");
  gotoLine(v, 4);
  await keys(v, "p");
  assert.equal(text(v), "text\n| a |\n|---|\n| 1 |\ntext");
  v = open("| a |\n|---|\n| 1 |\n\ntext");
  gotoLine(v, 3);
  await keys(v, "yy");
  gotoLine(v, 5);
  await keys(v, "p");
  assert.equal(text(v), "| a |\n|---|\n| 1 |\n\ntext\n| 1 |");
});

test("dd deletes the row, aligns the table, and p puts the row back", async () => {
  const v = open("| h | x |\n|---|:-:|\n| long cell | 1 |\n| 2 | 3 |\n\ntext");
  gotoCell(v, 3, "1");
  await keys(v, "dd");
  assert.equal(text(v), "| h   |  x  |\n| --- | :-: |\n| 2   |  3  |\n\ntext");
  assert.deepEqual(cursorAt(v), [3, 9]);
  assert.equal(unnamed().toString(), "| long cell | 1 |\n");
  assert.ok(unnamed().linewise);
  assert.equal(Vim.getRegisterController().getRegister("1").toString(), "| long cell | 1 |\n");
  await keys(v, "P");
  assert.equal(text(v), "| h         |  x  |\n| --------- | :-: |\n| long cell |  1  |\n| 2         |  3  |\n\ntext");
  await keys(v, "uu");
  assert.equal(text(v), "| h | x |\n|---|:-:|\n| long cell | 1 |\n| 2 | 3 |\n\ntext");
});

test("dd on the last row goes up a row; on the only body row it leaves the header", async () => {
  const v = open(TBL);
  gotoCell(v, 5, "5");
  await keys(v, "dd");
  assert.deepEqual(cursorAt(v), [4, 10]);
  await keys(v, "dd");
  assert.equal(text(v), "# T\n| a   |   b | c   |\n| :-- | --: | --- |\n\ntext");
  assert.deepEqual(cursorAt(v), [3, 8]);
});

test("dd on the delimiter row or the only header row does nothing", async () => {
  const v = open(TBL);
  unnamed().setText("kept");
  for (const line of [2, 3]) {
    gotoLine(v, line);
    await keys(v, "dd");
    assert.equal(text(v), TBL);
    assert.deepEqual(cursorAt(v), [line, 0]);
  }
  gotoLine(v, 2);
  await keys(v, "2dd");
  gotoLine(v, 3);
  await keys(v, "ma");
  gotoLine(v, 4);
  await keys(v, "d'aV'ad");
  assert.equal(text(v), TBL);
  assert.equal(unnamed().toString(), "kept");
});

test("a count stops at the table's last row; dd over the whole table deletes it", async () => {
  let v = open("| h |\n|---|\n| 1 |\n| 2 |\n| 3 |\n\ntext");
  gotoLine(v, 4);
  await keys(v, "9yy");
  assert.equal(unnamed().toString(), "| 2 |\n| 3 |\n");
  await keys(v, "9dd");
  assert.equal(text(v), "| h   |\n| --- |\n| 1   |\n\ntext");
  assert.equal(unnamed().toString(), "| 2 |\n| 3 |\n");
  await keys(v, "u");
  assert.equal(text(v), "| h |\n|---|\n| 1 |\n| 2 |\n| 3 |\n\ntext");
  gotoLine(v, 1);
  await keys(v, "9dd");
  assert.equal(text(v), "\ntext");
  v = open("| a |\n\ntext");
  await keys(v, "dd");
  assert.equal(text(v), "\ntext");
});

// jsdom has no layout for j and k, so these tests make linewise ranges with
// marks: `d'a` is a linewise delete to mark a, as dj or dk would be.
test("d to a line in the table or Vd delete rows and align; d past the table is vim's delete", async () => {
  let v = open("| h |\n|---|\n| 1 |\n| long |\n| 3 |\ntext");
  gotoLine(v, 4);
  await keys(v, "ma");
  gotoLine(v, 3);
  await keys(v, "d'a");
  assert.equal(text(v), "| h   |\n| --- |\n| 3   |\ntext");
  await keys(v, "u");
  gotoLine(v, 4);
  await keys(v, "ma");
  gotoLine(v, 3);
  await keys(v, "V'ad");
  assert.equal(text(v), "| h   |\n| --- |\n| 3   |\ntext");
  await keys(v, "u");
  gotoLine(v, 6);
  await keys(v, "ma");
  gotoLine(v, 5);
  await keys(v, "d'a");
  assert.equal(text(v), "| h |\n|---|\n| 1 |\n| long |");
  v = open("a\n\n| h |\n|---|\n| 1 |\n\nb");
  gotoLine(v, 4);
  await keys(v, "dap");
  assert.equal(text(v), "a\n\nb");
});

test("a pasted delimiter row is a row: dd deletes it", async () => {
  const v = open(TBL);
  gotoLine(v, 3);
  await keys(v, "yy");
  gotoLine(v, 4);
  await keys(v, "p");
  assert.deepEqual(tableLines(v).slice(1, 5), [
    "| :-- | --: | --- |", "| 1   |   2 | 3   |", "| :-  |  -: | --- |", "| 4   |   5 | 6   |",
  ]);
  assert.deepEqual(cursorAt(v), [5, 2]);
  await keys(v, "dd");
  assert.deepEqual(tableLines(v).slice(1), ["| :-- | --: | --- |", "| 1   |   2 | 3   |", "| 4   |   5 | 6   |"]);
});

test(". repeats dd and p on table rows", async () => {
  const v = open("| h |\n|---|\n| 1 |\n| 2 |\n| 3 |\n| 4 |");
  gotoLine(v, 3);
  await keys(v, "dd.");
  assert.equal(text(v), "| h   |\n| --- |\n| 3   |\n| 4   |");
  await keys(v, "p.");
  assert.equal(text(v), "| h   |\n| --- |\n| 3   |\n| 2   |\n| 2   |\n| 4   |");
});

// --- table cells: i| / a| and visual blocks -----------------------------------

const CELLS = "| a | bb | c |\n|---|----|---|\n|  one two  | x | y |\n| 1 |  | 3 |\n\ntext";

test("di| deletes a cell's text without its padding, da| the cell and its closing pipe", async () => {
  let v = open(CELLS);
  gotoCell(v, 3, "two");
  await keys(v, "di|");
  assert.equal(v.state.doc.line(3).text, "|    | x | y |");
  assert.equal(unnamed().toString(), "one two");
  await keys(v, "u");
  await keys(v, "da|");
  assert.equal(v.state.doc.line(3).text, "| x | y |");
  // On a pipe: the cell it closes. On the last cell of a row without a
  // closing pipe: to the end of the line.
  v = open("| a | b | c");
  v.dispatch({ selection: { anchor: 4 } });
  await keys(v, "da|");
  assert.equal(text(v), "| b | c");
  gotoCell(v, 1, "c");
  await keys(v, "da|");
  assert.equal(text(v), "| b |");
});

test("ci| changes the cell's text, also an empty cell; yi| yanks it; a count takes more cells", async () => {
  const v = open(CELLS);
  gotoCell(v, 3, "x");
  await keys(v, "ci|");
  type(v, "new");
  await keys(v, "<Esc>");
  assert.equal(v.state.doc.line(3).text, "|  one two  | new | y |");
  v.dispatch({ selection: { anchor: v.state.doc.line(4).from + 6 } });
  await keys(v, "ci|");
  type(v, "2");
  await keys(v, "<Esc>");
  assert.equal(v.state.doc.line(4).text, "| 1 | 2 | 3 |");
  gotoCell(v, 4, "1");
  await keys(v, "yi|");
  assert.equal(unnamed().toString(), "1");
  await keys(v, "y2i|");
  assert.equal(unnamed().toString(), "1 | 2");
  await keys(v, "d2a|");
  assert.equal(v.state.doc.line(4).text, "| 3 |");
});

test("di| on an empty cell or off a table does nothing; vi| and va| select the cell", async () => {
  let v = open(CELLS);
  unnamed().setText("kept");
  v.dispatch({ selection: { anchor: v.state.doc.line(4).from + 6 } });
  await keys(v, "di|");
  gotoLine(v, 6);
  await keys(v, "di|da|");
  assert.equal(text(v), CELLS);
  assert.equal(unnamed().toString(), "kept");
  gotoCell(v, 3, "one");
  await keys(v, "vi|y");
  assert.equal(unnamed().toString(), "one two");
  assert.ok(!unnamed().blockwise);
  gotoCell(v, 3, "one");
  await keys(v, "va|d");
  assert.equal(v.state.doc.line(3).text, "| x | y |");
});

test("v inside a cell yanks and deletes text as usual", async () => {
  const v = open(CELLS);
  gotoCell(v, 3, "one");
  await keys(v, "vey");
  assert.equal(unnamed().toString(), "one");
  await keys(v, "vlld");
  assert.equal(v.state.doc.line(3).text, "|   two  | x | y |");
});

// The block goes from the cursor to mark a: jsdom has no layout for j and k.
async function block(view, from, to, keySeq) {
  gotoCell(view, ...to);
  await keys(view, "ma");
  gotoCell(view, ...from);
  await keys(view, "<C-v>`a" + keySeq);
}

test("Ctrl-v y in a table copies the cells, past the delimiter row, as tab-separated text", async () => {
  const v = open(CELLS);
  await block(v, [1, "bb"], [4, "3"], "y");
  assert.equal(unnamed().toString(), "bb\tc\nx\ty\n\t3");
  assert.ok(unnamed().blockwise);
  assert.equal(text(v), CELLS);
  assert.deepEqual(cursorAt(v), [1, 6]);
  // Only the corners count: the cells they are in, in a table that isn't aligned.
  await block(v, [4, "1"], [3, "one"], "y");
  assert.equal(unnamed().toString(), "one two\n1");
});

test("Ctrl-v d and x in a table blank the cells, align it, and u undoes it in one step", async () => {
  const v = open(CELLS);
  await block(v, [3, "x"], [4, "3"], "d");
  assert.equal(text(v), [
    "| a       | bb  | c   |",
    "| ------- | --- | --- |",
    "| one two |     |     |",
    "| 1       |     |     |",
    "",
    "text",
  ].join("\n"));
  assert.deepEqual(cursorAt(v), [3, 12]);
  assert.equal(unnamed().toString(), "x\ty\n\t3");
  assert.ok(unnamed().blockwise);
  await keys(v, "u");
  assert.equal(text(v), CELLS);
  await block(v, [1, "a"], [3, "one"], "x");
  assert.deepEqual(text(v).split("\n").slice(0, 3), ["|     | bb  | c   |", "| --- | --- | --- |", "|     | x   | y   |"]);
  assert.deepEqual(cursorAt(v), [1, 2]);
});

test("Ctrl-v D, X and Y in a table take the cells to the end of the row", async () => {
  const v = open(CELLS);
  await block(v, [3, "x"], [3, "x"], "Y");
  assert.equal(unnamed().toString(), "x\ty");
  assert.ok(!unnamed().linewise);
  await block(v, [4, "1"], [4, "1"], "D");
  assert.equal(v.state.doc.line(4).text, "|         |     |     |");
  await keys(v, "u");
  await block(v, [3, "one"], [3, "one"], "X");
  assert.equal(v.state.doc.line(3).text, "|     |     |     |");
});

test("p puts copied cells over the cells from the cursor's, adding rows and columns", async () => {
  const v = open(CELLS);
  await block(v, [1, "bb"], [3, "y"], "y");
  gotoCell(v, 4, "3");
  await keys(v, "p");
  assert.equal(text(v), [
    "| a       | bb  | c   |     |",
    "| ------- | --- | --- | --- |",
    "| one two | x   | y   |     |",
    "| 1       |     | bb  | c   |",
    "|         |     | x   | y   |",
    "",
    "text",
  ].join("\n"));
  assert.deepEqual(cursorAt(v), [4, 18]);
  await keys(v, "u");
  assert.equal(text(v), CELLS);
});

test("p on the delimiter row pastes from the row below it; P pastes as p does", async () => {
  for (const key of ["p", "P"]) {
    const v = open(CELLS);
    await block(v, [4, "3"], [4, "3"], "y");
    gotoLine(v, 2);
    await keys(v, key);
    assert.equal(v.state.doc.line(3).text, "| 3   | x   | y   |", key);
  }
});

test("copied cells paste as tab-separated columns outside a table", async () => {
  const v = open(CELLS);
  await block(v, [3, "x"], [4, "3"], "y");
  gotoLine(v, 5);
  await keys(v, "P");
  // Vim's block paste; in jsdom, without layout, it puts only the first line.
  assert.equal(v.state.doc.line(5).text, "x\ty");
});

test("a block yanked off a table, or reaching past it, is vim's; it pastes as text in a table", async () => {
  const v = open(CELLS);
  await block(v, [4, "1"], [6, "text"], "y");
  // Vim's own block yank (in jsdom, without layout, only the last line's part).
  assert.ok(!unnamed().toString().includes("\t"));
  const yanked = unnamed().toString();
  await block(v, [6, "t"], [6, "x"], "d");
  assert.equal(text(v), CELLS.replace("text", "t"));
  gotoCell(v, 4, "3");
  await keys(v, "p");
  assert.equal(v.state.doc.line(4).text, `| 1 |  | 3${yanked} |`);
});

test("Ctrl-v d on the delimiter row alone does nothing; . repeats a block delete", async () => {
  const v = open(CELLS);
  unnamed().setText("kept");
  await block(v, [2, "---"], [2, "----"], "d");
  assert.equal(text(v), CELLS);
  assert.equal(unnamed().toString(), "kept");
  await block(v, [3, "x"], [3, "x"], "d");
  gotoCell(v, 4, "1");
  await keys(v, ".");
  assert.deepEqual(text(v).split("\n").slice(2, 4), ["| one two |     | y   |", "|         |     | 3   |"]);
});

// --- tables as text in Live Preview -----------------------------------------------

const LP = "above\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nbelow";

function openLP(doc, extra = []) {
  const v = open(doc, [highlightField, extra]);
  plugin.installVimOverrides();
  return v;
}

// The search highlights: [from, to, class].
function highlights(view) {
  const out = [];
  const it = view.state.field(highlightField).iter();
  for (; it.value; it.next()) out.push([it.from, it.to, it.value.spec.class]);
  return out;
}

const breakAfter = (view, n) => [view.state.doc.line(n).to, view.state.doc.line(n).to + 1, "obsidian-search-match-highlight"];

test("in a table the line break after it gets a search highlight, taken off when the cursor leaves", async () => {
  const v = openLP(LP);
  assert.deepEqual(highlights(v), []);
  gotoLine(v, 4);
  assert.deepEqual(highlights(v), [breakAfter(v, 5)]);
  gotoLine(v, 3);
  assert.deepEqual(highlights(v), [breakAfter(v, 5)]);
  await keys(v, "G");
  assert.deepEqual(highlights(v), []);
});

test("a visual selection that starts in a table keeps it as text", async () => {
  const v = openLP(LP);
  gotoLine(v, 5);
  await keys(v, "V");
  v.dispatch({ selection: { anchor: v.state.doc.line(5).from, head: v.state.doc.line(7).to } });
  assert.deepEqual(highlights(v), [breakAfter(v, 5)]);
});

test("a table at the end of the note gets the line break before it; a whole-note table none", async () => {
  let v = openLP("above\n| a |\n| - |");
  gotoLine(v, 3);
  assert.deepEqual(highlights(v), [[5, 6, "obsidian-search-match-highlight"]]);
  v = openLP("| a |\n| - |");
  gotoLine(v, 2);
  assert.deepEqual(highlights(v), []);
});

test("editing the table keeps one highlight on its line break", async () => {
  const v = openLP(LP);
  gotoCell(v, 5, "2");
  await keys(v, "x");
  assert.equal(text(v).split("\n")[4], "| 1 |  |");
  assert.deepEqual(highlights(v), [breakAfter(v, 5)]);
  await keys(v, "dd");
  assert.deepEqual(highlights(v), [breakAfter(v, 4)]);
});

test("the highlight is put back when Obsidian clears its search highlights, and the user's are kept", async () => {
  const v = openLP(LP);
  gotoLine(v, 4);
  editorFor(v).addHighlights([{ from: 0, to: 5 }], "obsidian-search-match-highlight", false);
  assert.equal(highlights(v).length, 2);
  v.dispatch({ effects: filterHighlights.of(() => false) });
  assert.deepEqual(highlights(v), [breakAfter(v, 5)]);
  editorFor(v).addHighlights([{ from: 0, to: 5 }], "obsidian-search-match-highlight", false);
  gotoLine(v, 1);
  assert.deepEqual(highlights(v), [[0, 5, "obsidian-search-match-highlight"]]);
});

// A stand-in for Vim Motions' view plugin that hides the cursor in a table
// while a table widget is drawn: as it does, it sets cursorInTable when the
// cursor enters a table, and its destroy resets that.
function vimMotionsTablePlugin() {
  const log = { hidden: 0, shown: 0, instance: null };
  const extension = ViewPlugin.fromClass(class {
    constructor(view) { this.view = view; this.cursorInTable = false; log.instance = this; }
    update(u) {
      if (!(u.selectionSet || u.focusChanged)) return;
      const inTable = /^\s*\|/.test(u.state.doc.lineAt(u.state.selection.main.head).text);
      if (inTable && !this.cursorInTable) [this.cursorInTable, log.hidden] = [true, log.hidden + 1];
      else if (!inTable && this.cursorInTable) this.cursorInTable = false;
    }
    destroy() { if (this.cursorInTable) [this.cursorInTable, log.shown] = [false, log.shown + 1]; }
  });
  return { extension, log };
}

test("Vim Motions' cursor isn't hidden in a table shown as text", async () => {
  const { extension: vm, log } = vimMotionsTablePlugin();
  const v = openLP(LP, vm);
  gotoLine(v, 4);
  assert.deepEqual([log.hidden, log.shown, log.instance.cursorInTable], [1, 1, false]);
  gotoLine(v, 5);
  assert.deepEqual([log.hidden, log.shown, log.instance.cursorInTable], [2, 2, false]);
  await keys(v, "x");
  assert.equal(log.instance.cursorInTable, false);
  await keys(v, "G");
  assert.deepEqual([log.hidden, log.shown, log.instance.cursorInTable], [3, 3, false]);
});

test("Vim Motions' cursor is left hidden in a table not shown as text", async () => {
  const { extension: vm, log } = vimMotionsTablePlugin();
  const v = openLP("| a |\n| - |", vm);
  gotoLine(v, 2);
  assert.deepEqual([log.hidden, log.shown, log.instance.cursorInTable], [1, 0, true]);
});

// Live Preview's table widget: a table of the rows but the delimiter row.
class CellsWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-embed-block cm-table-widget";
    el.innerHTML = "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><div class='table-cell-wrapper'><div class='cell-editor' tabindex='0'>2</div></div></td></tr></tbody></table>";
    return el;
  }
}
const cellsField = StateField.define({
  create: (state) => Decoration.set(Decoration.replace({ widget: new CellsWidget(), block: true })
    .range(state.doc.line(3).from, state.doc.line(5).to)),
  update: (deco, tr) => deco.map(tr.changes),
  provide: (f) => EditorView.decorations.from(f),
});

function press(el, type) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(event);
  return event;
}

test("a click on a table widget's cell puts vim's cursor on the cell's text", async () => {
  const v = openLP(LP, [cellsField]);
  const cell = v.contentDOM.querySelector(".table-cell-wrapper");
  const events = ["pointerdown", "mousedown", "click"].map((type) => press(cell, type));
  assert.ok(events.every((e) => e.defaultPrevented));
  assert.equal(v.state.selection.main.head, v.state.doc.line(5).from + 6);
  assert.deepEqual(highlights(v), [breakAfter(v, 5)]);
  press(v.contentDOM.querySelector("th"), "pointerdown");
  assert.equal(v.state.selection.main.head, v.state.doc.line(3).from + 2);
});

test("a table widget that focuses a cell by itself gives the focus back to the editor", async () => {
  const v = openLP(LP, [cellsField]);
  v.contentDOM.querySelector(".cell-editor").focus();
  assert.equal(document.activeElement, v.contentDOM);
  const plain = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: LP, extensions: [highlightField, cellsField] }),
  });
  try {
    const cell = plain.contentDOM.querySelector(".cell-editor");
    cell.focus();
    assert.equal(document.activeElement, cell);
  } finally {
    plain.destroy();
  }
});

test("a click outside a cell or in an editor without vim is left alone", async () => {
  const plain = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: LP, extensions: [highlightField, cellsField] }),
  });
  try {
    assert.ok(!press(plain.contentDOM.querySelector("td"), "pointerdown").defaultPrevented);
  } finally {
    plain.destroy();
  }
  const v = openLP(LP, [cellsField]);
  assert.ok(!press(v.contentDOM.querySelector(".cm-table-widget"), "pointerdown").defaultPrevented);
});

test("a click on a link in a table widget's cell is left to Obsidian", async () => {
  class LinksWidget extends WidgetType {
    toDOM() {
      const el = document.createElement("div");
      el.className = "cm-embed-block cm-table-widget";
      el.innerHTML = "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><div class='table-cell-wrapper'><a class='internal-link' href='2'><span>2</span></a> <a class='tag' href='#t'>#t</a> <input type='checkbox'></div></td></tr></tbody></table>";
      return el;
    }
  }
  const field = StateField.define({
    create: (state) => Decoration.set(Decoration.replace({ widget: new LinksWidget(), block: true })
      .range(state.doc.line(3).from, state.doc.line(5).to)),
    update: (deco, tr) => deco.map(tr.changes),
    provide: (f) => EditorView.decorations.from(f),
  });
  const v = openLP(LP, [field]);
  const head = v.state.selection.main.head;
  for (const el of v.contentDOM.querySelectorAll("a span, a.tag, input")) {
    const events = ["pointerdown", "mousedown", "click"].map((type) => press(el, type));
    assert.ok(events.every((e) => !e.defaultPrevented), el.outerHTML);
    assert.equal(v.state.selection.main.head, head);
  }
  assert.ok(press(v.contentDOM.querySelector(".table-cell-wrapper"), "pointerdown").defaultPrevented);
  assert.equal(v.state.selection.main.head, v.state.doc.line(5).from + 6);
});

test("a click below a later row of dashes goes to the row the widget draws", async () => {
  class DashesWidget extends WidgetType {
    toDOM() {
      const el = document.createElement("div");
      el.className = "cm-embed-block cm-table-widget";
      el.innerHTML = "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>-</td><td>-</td></tr><tr><td>1</td><td>2</td></tr></tbody></table>";
      return el;
    }
  }
  const field = StateField.define({
    create: (state) => Decoration.set(Decoration.replace({ widget: new DashesWidget(), block: true })
      .range(state.doc.line(3).from, state.doc.line(6).to)),
    update: (deco, tr) => deco.map(tr.changes),
    provide: (f) => EditorView.decorations.from(f),
  });
  const v = openLP("above\n\n| a | b |\n| - | - |\n| - | - |\n| 1 | 2 |\n\nbelow", [field]);
  press(v.contentDOM.querySelectorAll("td")[3], "pointerdown");
  assert.equal(v.state.selection.main.head, v.state.doc.line(6).from + 6);
  press(v.contentDOM.querySelectorAll("td")[0], "pointerdown");
  assert.equal(v.state.selection.main.head, v.state.doc.line(5).from + 2);
});

// --- ae / ie -------------------------------------------------------------------

const LIST = "# T\n- a\n  - a1\n  - a2\n    more\n- b\n\nafter";

// The text `y<obj>` yanks with the cursor on line n (and col).
async function yanked(doc, n, obj, col = 0) {
  const v = open(doc);
  v.dispatch({ selection: { anchor: v.state.doc.line(n).from + col } });
  Vim.getRegisterController().getRegister('"').setText("");
  await keys(v, "y" + obj);
  return Vim.getRegisterController().getRegister('"').toString();
}

test("dae on a list item deletes it and its sub-items, die its text", async () => {
  let v = open(LIST);
  gotoLine(v, 2);
  await keys(v, "dae");
  assert.equal(text(v), "# T\n- b\n\nafter");
  v = open(LIST);
  gotoLine(v, 4);
  await keys(v, "dae");
  assert.equal(text(v), "# T\n- a\n  - a1\n- b\n\nafter");
  v = open(LIST);
  gotoLine(v, 5); // a continuation line is part of its item
  await keys(v, "die");
  assert.equal(text(v), "# T\n- a\n  - a1\n  - \n- b\n\nafter");
});

test("cie on an item keeps the bullet, number and checkbox", async () => {
  for (const [doc, want] of [["- [x] done", "- [x] "], ["12. twelve", "12. "], ["\t* star", "\t* "]]) {
    const v = open(doc);
    await keys(v, "$cie");
    assert.ok(insertMode(v), doc);
    type(v, "new");
    assert.equal(text(v), want + "new", doc);
  }
});

test("ae on the last item takes the trailing blank lines", async () => {
  const v = open(LIST);
  gotoLine(v, 6);
  await keys(v, "dae");
  assert.equal(text(v), "# T\n- a\n  - a1\n  - a2\n    more\nafter");
});

test("d2ae deletes the list, d3ae the parent item, d4ae its list", async () => {
  const want = ["# T\n- a\n- b\n\nafter", "# T\n- b\n\nafter", "# T\nafter", ""];
  for (const [i, t] of want.entries()) {
    const v = open(LIST);
    gotoLine(v, 3);
    await keys(v, `d${i + 2}ae`);
    assert.equal(text(v), t, `d${i + 2}ae`);
  }
});

test("vae selects the item, ae again the list, then the parent item", async () => {
  const v = open(LIST);
  gotoLine(v, 3);
  await keys(v, "vae");
  assert.equal(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to), "  - a1");
  await keys(v, "ae");
  assert.equal(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to), "  - a1\n  - a2\n    more");
  await keys(v, "aed");
  assert.equal(text(v), "# T\n- b\n\nafter");
});

test("vie selects an item's text, ie again the text of the enclosing list", async () => {
  const v = open(LIST);
  gotoLine(v, 3);
  await keys(v, "vie");
  const selected = () => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
  assert.equal(selected(), "a1");
  await keys(v, "ie");
  assert.equal(selected(), "  - a1\n  - a2\n    more");
  await keys(v, "ie");
  assert.equal(selected(), "a\n  - a1\n  - a2\n    more");
  await keys(v, "d");
  assert.equal(text(v), "# T\n- \n- b\n\nafter");
});

test("a list ends at a different bullet or delimiter, and runs over blank lines", async () => {
  assert.equal(await yanked("- a\n- b\n* c", 1, "2ae"), "- a\n- b\n");
  assert.equal(await yanked("1. a\n\n2. b\n3) c", 1, "2ae"), "1. a\n\n2. b\n");
  assert.equal(await yanked("1. a\n\n2. b\n3) c", 1, "ae"), "1. a\n\n");
});

test("ae and ie on a fenced code block", async () => {
  const doc = "x\n\n```js\nlet a;\n\nlet b;\n```\n\ny";
  for (const n of [3, 4, 5, 7]) {
    assert.equal(await yanked(doc, n, "ae"), "```js\nlet a;\n\nlet b;\n```\n\n", `ae on line ${n}`);
    assert.equal(await yanked(doc, n, "ie"), "let a;\n\nlet b;\n", `ie on line ${n}`);
  }
  let v = open(doc);
  gotoLine(v, 4);
  await keys(v, "cie");
  type(v, "code");
  assert.equal(text(v), "x\n\n```js\ncode\n```\n\ny");
});

test("ie on an empty code block does nothing, on an unclosed one runs to the end", async () => {
  let v = open("```\n```\nx");
  await keys(v, "die");
  assert.equal(text(v), "```\n```\nx");
  await keys(v, "dae");
  assert.equal(text(v), "x");
  assert.equal(await yanked("```\na\n## not a heading\n- not an item", 3, "ie"), "a\n## not a heading\n- not an item\n");
  // Two blocks back to back are two elements.
  assert.equal(await yanked("```\na\n```\n~~~\nb\n~~~", 5, "ae"), "~~~\nb\n~~~\n");
});

test("a code block in a list item: ae, then the item, then the list", async () => {
  const doc = "- a\n  ```\n  - code\n  ```\n- b";
  assert.equal(await yanked(doc, 3, "ae"), "  ```\n  - code\n  ```\n");
  assert.equal(await yanked(doc, 3, "2ae"), "- a\n  ```\n  - code\n  ```\n");
  assert.equal(await yanked(doc, 3, "3ae"), doc + "\n");
});

test("ae and ie on a paragraph", async () => {
  const doc = "# T\none\ntwo\n\n\nthree";
  assert.equal(await yanked(doc, 3, "ae"), "one\ntwo\n\n\n");
  assert.equal(await yanked(doc, 3, "ie"), "one\ntwo\n");
  // A blank line belongs to the element above it.
  assert.equal(await yanked(doc, 4, "ae"), "one\ntwo\n\n\n");
  // A paragraph stops at a list, a quote and a heading.
  assert.equal(await yanked("a\nb\n- c", 1, "ae"), "a\nb\n");
  assert.equal(await yanked("> q\na\nb\n# H", 3, "ae"), "a\nb\n");
});

test("dae on a paragraph in an item deletes the paragraph, die its lines", async () => {
  const doc = "- a\n\n  para\n  more\n\n- b";
  let v = open(doc);
  gotoLine(v, 3);
  await keys(v, "dae");
  assert.equal(text(v), "- a\n\n- b");
  v = open(doc);
  gotoLine(v, 4);
  await keys(v, "die");
  assert.equal(text(v), "- a\n\n\n- b");
  assert.equal(await yanked(doc, 4, "ie"), "  para\n  more\n");
  // The item's first line and the lines that go on from it are the item.
  assert.equal(await yanked("- a\n  more\n\n  para\n- b", 2, "ae"), "- a\n  more\n\n  para\n");
  v = open(doc);
  await keys(v, "dae");
  assert.equal(text(v), "- b");
});

test("d2ae on a paragraph in an item deletes the item, vae ae grows to it", async () => {
  const doc = "- a\n\n  para\n- b";
  let v = open(doc);
  gotoLine(v, 3);
  await keys(v, "dae");
  assert.equal(text(v), "- a\n\n- b");
  v = open(doc);
  gotoLine(v, 3);
  await keys(v, "d2ae");
  assert.equal(text(v), "- b");
  assert.equal(await yanked(doc, 3, "3ae"), doc + "\n");
  v = open(doc);
  gotoLine(v, 3);
  await keys(v, "vae");
  const selected = () => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
  assert.equal(selected(), "  para");
  await keys(v, "ae");
  assert.equal(selected(), "- a\n\n  para");
  await keys(v, "d");
  assert.equal(text(v), "- b");
});

test("a paragraph in an item stops at a sub-item and at the end of the item", async () => {
  const doc = "- a\n\n  para\n  - a1\n- b";
  assert.equal(await yanked(doc, 3, "ae"), "  para\n");
  assert.equal(await yanked(doc, 3, "2ae"), "- a\n\n  para\n  - a1\n");
  assert.equal(await yanked("- a\n\n  para\n  > q", 3, "ae"), "  para\n");
  assert.equal(await yanked("- a\n\n  para\nout", 3, "ae"), "  para\n");
});

test("ae and ie on a block quote and a callout", async () => {
  const doc = "> [!note] Title\n> body\n> more\n\nx";
  assert.equal(await yanked(doc, 2, "ae"), "> [!note] Title\n> body\n> more\n\n");
  assert.equal(await yanked(doc, 2, "ie"), "> body\n> more\n");
  assert.equal(await yanked("> a\n> b\n\n> c", 1, "ie"), "> a\n> b\n");
  assert.equal(await yanked("> a\n> b\n\n> c", 4, "ae"), "> c\n");
});

test("ae and ie on front matter", async () => {
  const doc = "---\ntags: [a]\n# note: yaml\n---\n\n# A";
  assert.equal(await yanked(doc, 3, "ae"), "---\ntags: [a]\n# note: yaml\n---\n\n");
  assert.equal(await yanked(doc, 1, "ie"), "tags: [a]\n# note: yaml\n");
  const v = open(doc);
  await keys(v, "dae");
  assert.equal(text(v), "# A");
});

test("ae on a heading is the heading line, ie its text; a count takes the subtree", async () => {
  const doc = "# A\n## B  \n\nb\n## C";
  assert.equal(await yanked(doc, 2, "ae"), "## B  \n\n");
  assert.equal(await yanked(doc, 2, "ie"), "B  ");
  assert.equal(await yanked(doc, 2, "2ae"), "## B  \n\nb\n");
  assert.equal(await yanked(doc, 2, "2ie"), "b\n");
  assert.equal(await yanked(doc, 2, "3ae"), doc + "\n");
  const v = open(doc);
  gotoLine(v, 2);
  await keys(v, "cie");
  type(v, "New");
  assert.equal(text(v), "# A\n## New\n\nb\n## C");
});

test("after the innermost elements come the subtrees, as with ar", async () => {
  const doc = DOC + "\n# Z";
  assert.equal(await yanked(doc, 6, "2ae"), "### C\nc\n");
  assert.equal(await yanked(doc, 6, "3ae"), "## B\nb\n### C\nc\n");
  assert.equal(await yanked(doc, 6, "3ie"), "b\n### C\nc\n");
  let v = open(doc);
  gotoLine(v, 6);
  await keys(v, "vaeaeaed");
  assert.equal(text(v), "# A\na\n## D\nd\n# Z");
  // A count past the outermost element takes the outermost one.
  v = open(doc);
  gotoLine(v, 6);
  await keys(v, "d9ae");
  assert.equal(text(v), "# Z");
});

test("Vae and Vie pick the element, and ie switches to charwise", async () => {
  let v = open(LIST);
  gotoLine(v, 6);
  await keys(v, "Vae");
  assert.ok(getCM(v).state.vim.visualLine);
  await keys(v, "d");
  assert.equal(text(v), "# T\n- a\n  - a1\n  - a2\n    more\nafter");
  v = open(LIST);
  gotoLine(v, 6);
  await keys(v, "Vie");
  assert.ok(!getCM(v).state.vim.visualLine);
  await keys(v, "d");
  assert.equal(text(v), "# T\n- a\n  - a1\n  - a2\n    more\n- \n\nafter");
});

test("Vae on a heading line selects the line, ae again its subtree", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "Vae");
  assert.equal(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to), "## B");
  await keys(v, "aex");
  assert.equal(text(v), "# A\na\n## D\nd");
});

test("cae changes the lines, yae then p puts them back", async () => {
  let v = open("x\n\none\ntwo\n\ny");
  gotoLine(v, 3);
  await keys(v, "cae");
  assert.ok(insertMode(v));
  type(v, "new");
  assert.equal(text(v), "x\n\nnew\ny");
  v = open("- a\n- b");
  await keys(v, "yaejp");
  assert.equal(text(v), "- a\n- b\n- a");
});

test(">ae indents a list, >ae on a heading demotes it", async () => {
  let v = open("- a\n  - a1\n- b");
  await keys(v, ">ae");
  assert.equal(text(v), "  - a\n    - a1\n- b");
  v = open(DOC);
  gotoLine(v, 3);
  await keys(v, ">ae");
  assert.equal(text(v), "# A\na\n### B\nb\n### C\nc\n## D\nd");
  await keys(v, "<ae");
  assert.equal(text(v), DOC);
});

test("dae at the end of the note leaves no blank line, and u undoes it", async () => {
  const v = open("# A\npara\n\n- a\n- b");
  gotoLine(v, 5);
  await keys(v, "d2ae");
  assert.equal(text(v), "# A\npara\n");
  await keys(v, "u");
  assert.equal(text(v), "# A\npara\n\n- a\n- b");
  gotoLine(v, 2);
  await keys(v, "dae");
  assert.equal(text(v), "# A\n- a\n- b");
  await keys(v, ".");
  assert.equal(text(v), "# A\n- b");
});

test("dae on a folded heading deletes the subtree, and u restores it folded", async () => {
  const v = open(DOC);
  fold(v, 5);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "dae");
  assert.equal(text(v), "# A\na\n## D\nd");
  await keys(v, "u");
  assert.equal(text(v), DOC);
  assert.deepEqual(foldedLines(v), [3, 5]);
});

test("ae on a folded item takes the fold; cie keeps the heading folded", async () => {
  let v = open("- a\n\t- a1\n\t- a2\n- b");
  v.dispatch({ effects: foldEffect.of({ from: v.state.doc.line(1).to, to: v.state.doc.line(3).to }) });
  await keys(v, "dae");
  assert.equal(text(v), "- b");
  await keys(v, "u");
  assert.equal(text(v), "- a\n\t- a1\n\t- a2\n- b");
  assert.deepEqual(foldedLines(v), [1]);
  v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "cie");
  type(v, "X");
  await keys(v, "<Esc>");
  assert.equal(text(v), "# A\na\n## X\nb\n### C\nc\n## D\nd");
  assert.deepEqual(foldedLines(v), [3]);
});

test("Vae over a paragraph with a folded code block keeps the fold closed", async () => {
  const v = open("# A\n- x\n  ```\n  code\n  ```\n- y");
  fold(v, 3);
  gotoLine(v, 2);
  await keys(v, "Vae");
  assert.deepEqual(foldedLines(v), [3]);
  await keys(v, "d");
  assert.equal(text(v), "# A\n- y");
});

test("ae and ie with nothing around them do nothing", async () => {
  const v = open("\n\n# A");
  await keys(v, "daedie");
  assert.equal(text(v), "\n\n# A");
  const w = open("#\nx"); // a heading without text
  await keys(w, "die");
  assert.equal(text(w), "#\nx");
});

// --- gh ------------------------------------------------------------------------

test("gh from a body line goes to its heading, again to the parent", async () => {
  const v = open(DOC);
  gotoLine(v, 6);
  await keys(v, "l");
  await keys(v, "gh");
  assert.equal(v.state.selection.main.head, v.state.doc.line(5).from);
  await keys(v, "gh");
  assert.equal(cursorLine(v), 3);
  await keys(v, "gh");
  assert.equal(cursorLine(v), 1);
});

test("gh with a count goes up that many levels, stopping at the top", async () => {
  const v = open(DOC);
  gotoLine(v, 6);
  await keys(v, "2gh");
  assert.equal(cursorLine(v), 3);
  gotoLine(v, 6);
  await keys(v, "9gh");
  assert.equal(cursorLine(v), 1);
});

test("gh on a top-level heading or before the first heading stays", async () => {
  const v = open("intro\n# A\na");
  gotoLine(v, 2);
  await keys(v, "gh");
  assert.equal(cursorLine(v), 2);
  gotoLine(v, 1);
  await keys(v, "gh");
  assert.equal(cursorLine(v), 1);
});

test("gh skips # lines in code blocks", async () => {
  const v = open("# A\n```\n# not\n```\nx");
  gotoLine(v, 5);
  await keys(v, "gh");
  assert.equal(cursorLine(v), 1);
});

test("dgh deletes linewise from the heading to the cursor line", async () => {
  const v = open(DOC);
  gotoLine(v, 6);
  await keys(v, "dgh");
  assert.equal(text(v), "# A\na\n## B\nb\n## D\nd");
});

test("<C-o> after gh goes back", async () => {
  const v = open(DOC);
  gotoLine(v, 8);
  await keys(v, "gh<C-o>");
  assert.equal(cursorLine(v), 8);
});

// --- indent mode ---------------------------------------------------------------

// org-indent-mode: lines indented in display by their depth in the outline.

const toggleIndent = () => plugin.commands.find((c) => c.id === "toggle-indent").callback();

// Each line's indent in steps of --evil-org-indent, from the DOM.
function indentSteps(view) {
  return [...view.contentDOM.querySelectorAll(".cm-line")].map((el) => {
    const m = (el.getAttribute("style") || "").match(/calc\((\d+) \*/);
    return m ? Number(m[1]) : 0;
  });
}

test("every setting is off by default", async () => {
  assert.deepEqual(plugin.settings, {
    indent: false, compactHeadings: false, uniformHeadings: false, hideFoldArrows: false, metaModifier: "alt",
  });
  assert.equal(plugin.settingExtensions.length, 0);
  const v = open(DOC);
  assert.deepEqual(indentSteps(v), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("indent mode puts a heading at its parent's text and its text one step in", async () => {
  await toggleIndent();
  try {
    const v = open("intro\n" + DOC);
    assert.deepEqual(indentSteps(v), [0, 0, 1, 1, 2, 2, 3, 1, 2]);
  } finally {
    await toggleIndent();
  }
  assert.deepEqual(indentSteps(open(DOC)), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("indent mode follows edits and leaves # lines in code blocks alone", async () => {
  await toggleIndent();
  try {
    const v = open("# A\n```\n## x\n```\na");
    assert.deepEqual(indentSteps(v), [0, 1, 1, 1, 1]);
    v.dispatch({ changes: { from: v.state.doc.line(5).from, insert: "## " } });
    v.dispatch({ changes: { from: v.state.doc.length, insert: "\nb" } });
    assert.deepEqual(indentSteps(v), [0, 1, 1, 1, 1, 2]);
  } finally {
    await toggleIndent();
  }
});

// The bullet shown on each line, "" for none.
function bulletsShown(view) {
  return [...view.contentDOM.querySelectorAll(".cm-line")].map((el) => {
    const b = el.querySelector(".evil-org-bullet");
    return b ? b.textContent : "";
  });
}

test("indent mode shows org bullets in Live Preview, not on the cursor's line", async () => {
  await toggleIndent();
  try {
    const v = open("# A\na\n## B\n### C\n#### D\n##### E", [editorLivePreviewField]);
    gotoLine(v, 2);
    assert.deepEqual(bulletsShown(v), ["◉", "", "○", "✸", "✿", "◉"]);
    gotoLine(v, 3);
    assert.deepEqual(bulletsShown(v), ["◉", "", "", "✸", "✿", "◉"]);
  } finally {
    await toggleIndent();
  }
});

test("indent mode shows no bullets in Source mode", async () => {
  await toggleIndent();
  try {
    const v = open("# A\na\n## B");
    gotoLine(v, 2);
    assert.deepEqual(bulletsShown(v), ["", "", ""]);
  } finally {
    await toggleIndent();
  }
});

// A block widget standing in for a table that Live Preview draws over line 3.
class TableWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-embed-block cm-table-widget";
    return el;
  }
}
const tableField = StateField.define({
  create: (state) => Decoration.set(Decoration.replace({ widget: new TableWidget(), block: true })
    .range(state.doc.line(3).from, state.doc.line(4).to)),
  update: (deco, tr) => deco.map(tr.changes),
  provide: (f) => EditorView.decorations.from(f),
});

const frame = () => new Promise((r) => setTimeout(r, 50));

test("indent mode indents a table widget with its line, then drops it when turned off", async () => {
  await toggleIndent();
  let v, table;
  try {
    v = open("# A\n## B\n| x |\n| - |\nb", [tableField]);
    await frame();
    table = v.contentDOM.querySelector(".cm-table-widget");
    assert.match(table.style.getPropertyValue("margin-inline-start"), /^calc\(2 \* .* - var\(--size-4-4\)\)$/);
    // jsdom drops the !important that Obsidian's own !important margin needs,
    // so that part is only seen in Obsidian.
  } finally {
    await toggleIndent();
  }
  v.dispatch({ effects: StateEffect.reconfigure.of([vim(), markdown(), plugin.extensions, tableField]) });
  assert.equal(table.style.getPropertyValue("margin-inline-start"), "");
});

test("turning indent mode off before a queued measure runs leaves the table unindented", async () => {
  await toggleIndent();
  let v, table;
  try {
    v = open("# A\n## B\n| x |\n| - |\nb", [tableField]);
    await frame();
    table = v.contentDOM.querySelector(".cm-table-widget");
    // An edit queues a measure for the next frame.
    v.dispatch({ changes: { from: v.state.doc.length, insert: "c" } });
  } finally {
    await toggleIndent();
  }
  v.dispatch({ effects: StateEffect.reconfigure.of([vim(), markdown(), plugin.extensions, tableField]) });
  await frame();
  assert.equal(table.style.getPropertyValue("margin-inline-start"), "");
});

// The padding the editor's styles give a heading line, "" for none.
function headingPadding(view) {
  return getComputedStyle(view.contentDOM.querySelector(".cm-line.HyperMD-header")).paddingTop;
}

test("compact headings removes the space above headings, and only while on", async () => {
  // Obsidian's own rule, and the class its markdown mode gives a heading line.
  const style = document.createElement("style");
  style.textContent = ".cm-line.HyperMD-header { padding-top: 16px; }";
  document.head.appendChild(style);
  const heading = Decoration.line({ class: "HyperMD-header" });
  const headings = EditorView.decorations.of(Decoration.set([heading.range(0)]));
  try {
    assert.equal(headingPadding(open("# A\na", [headings])), "16px");
    await plugin.setSetting("compactHeadings", true);
    assert.equal(headingPadding(open("# A\na", [headings])), "0px");
    await plugin.setSetting("compactHeadings", false);
    assert.equal(headingPadding(open("# A\na", [headings])), "16px", "after turning it off");
  } finally {
    style.remove();
  }
});

// 1-based numbers of the lines compact headings hides.
function hiddenBlanks(view) {
  return [...view.contentDOM.querySelectorAll(".cm-line")]
    .map((el, i) => (el.classList.contains("evil-org-hidden-blank") ? i + 1 : 0)).filter(Boolean);
}

test("compact headings hides blank lines between headings, not next to text or the cursor", async () => {
  await plugin.setSetting("compactHeadings", true);
  try {
    const v = open("# A\n\n## B\n\n\n### C\n\nc\n\n## D\n```\n\n```");
    gotoLine(v, 8);
    assert.deepEqual(hiddenBlanks(v), [2, 4, 5]);
    gotoLine(v, 4);
    assert.deepEqual(hiddenBlanks(v), [2, 5]);
  } finally {
    await plugin.setSetting("compactHeadings", false);
  }
  assert.deepEqual(hiddenBlanks(open("# A\n\n## B")), []);
});

test("compact headings hides a long run of blank lines between headings, and follows edits", async () => {
  await plugin.setSetting("compactHeadings", true);
  try {
    const v = open("# A\n" + "\n".repeat(30) + "# B\nb");
    gotoLine(v, 33);
    const run = Array.from({ length: 30 }, (_, i) => i + 2);
    assert.deepEqual(hiddenBlanks(v), run);
    v.dispatch({ changes: { from: v.state.doc.line(32).from, insert: "a\n" } });
    assert.deepEqual(hiddenBlanks(v), []);
  } finally {
    await plugin.setSetting("compactHeadings", false);
  }
});

test("uniform heading size gives headings the size of body text, and only while on", async () => {
  // Obsidian's own rules, and the class its markdown mode gives a heading line.
  const style = document.createElement("style");
  style.textContent = ".cm-content { font-size: 16px; } .cm-line.HyperMD-header { font-size: 26px; }";
  document.head.appendChild(style);
  const heading = Decoration.line({ class: "HyperMD-header" });
  const headings = EditorView.decorations.of(Decoration.set([heading.range(0)]));
  const size = (view) => getComputedStyle(view.contentDOM.querySelector(".cm-line.HyperMD-header")).fontSize;
  try {
    assert.equal(size(open("# A\na", [headings])), "26px");
    await plugin.setSetting("uniformHeadings", true);
    assert.equal(size(open("# A\na", [headings])), "16px");
    await plugin.setSetting("uniformHeadings", false);
    assert.equal(size(open("# A\na", [headings])), "26px", "after turning it off");
  } finally {
    style.remove();
  }
});

test("hide heading fold arrows hides the arrows of headings only, and only while on", async () => {
  // Obsidian's fold arrow: a widget at the start of a heading or list item.
  class Arrow extends WidgetType {
    toDOM() {
      const el = document.createElement("span");
      el.className = "cm-fold-indicator";
      return el;
    }
  }
  const arrow = Decoration.widget({ widget: new Arrow() });
  const heading = Decoration.line({ class: "HyperMD-header" });
  const marks = EditorView.decorations.of(Decoration.set([heading.range(0), arrow.range(0), arrow.range(4)]));
  const shown = (view) => [...view.contentDOM.querySelectorAll(".cm-fold-indicator")]
    .map((el) => getComputedStyle(el).display !== "none");
  assert.deepEqual(shown(open("# A\n- a", [marks])), [true, true]);
  await plugin.setSetting("hideFoldArrows", true);
  try {
    assert.deepEqual(shown(open("# A\n- a", [marks])), [false, true]);
  } finally {
    await plugin.setSetting("hideFoldArrows", false);
  }
  assert.deepEqual(shown(open("# A\n- a", [marks])), [true, true]);
});

// --- o / O ---------------------------------------------------------------------

// Insert mode keys are the browser's, not vim's: type text as an edit.
function type(view, s) {
  view.dispatch(view.state.replaceSelection(s));
}

const insertMode = (view) => getCM(view).state.vim.insertMode;

test("o and O in a bullet list open a new item", async () => {
  const v = open("- a\n- b");
  await keys(v, "o");
  assert.equal(text(v), "- a\n- \n- b");
  assert.ok(insertMode(v));
  assert.equal(v.state.selection.main.head, v.state.doc.line(2).to);
  type(v, "x");
  await keys(v, "<Esc>");
  gotoLine(v, 1);
  await keys(v, "O");
  type(v, "y");
  await keys(v, "<Esc>");
  assert.equal(text(v), "- y\n- a\n- x\n- b");
});

test("o keeps the indent and bullet, and adds an empty checkbox", async () => {
  const v = open("# T\n\t* [x] done\n\t+ plus");
  gotoLine(v, 2);
  await keys(v, "o");
  gotoLine(v, 4);
  await keys(v, "<Esc>o");
  assert.equal(text(v), "# T\n\t* [x] done\n\t* [ ] \n\t+ plus\n\t+ ");
});

test("o in a numbered list numbers the new item and renumbers the rest", async () => {
  const v = open("1. a\n2. b\n3) c\n\n1. d");
  await keys(v, "o");
  assert.equal(text(v), "1. a\n2. \n3. b\n3) c\n\n1. d");
  await keys(v, "<Esc>");
  gotoLine(v, 3);
  await keys(v, "O");
  assert.equal(text(v), "1. a\n2. \n3. \n4. b\n3) c\n\n1. d");
});

test("o and O number the items after the new one in sequence", async () => {
  let v = open("1. a\n1. b\n1. c");
  await keys(v, "o");
  assert.equal(text(v), "1. a\n2. \n3. b\n4. c");
  v = open("1. a\n1. b\n1. c");
  gotoLine(v, 2);
  await keys(v, "O");
  assert.equal(text(v), "1. a\n1. \n2. b\n3. c");
});

test("O on the first item of a numbered list at the top of the note", async () => {
  const v = open("1. a\n2. b");
  await keys(v, "O");
  assert.equal(text(v), "1. \n2. a\n3. b");
  assert.equal(v.state.selection.main.head, 3);
});

test("a numbered list with blank lines between items is one list", async () => {
  const v = open("1. a\n\n2. b\n   more\n\n3. c\nafter");
  await keys(v, "o");
  assert.equal(text(v), "1. a\n2. \n\n3. b\n   more\n\n4. c\nafter");
});

test("o opens after the item's sub-items, as a sibling", async () => {
  const v = open("- a\n\t- a1\n\t\t- a2\n\n\tbody\n- b");
  await keys(v, "o");
  assert.equal(text(v), "- a\n\t- a1\n\t\t- a2\n\n\tbody\n- \n- b");
  await keys(v, "<Esc>");
  gotoLine(v, 2);
  await keys(v, "o");
  assert.equal(text(v), "- a\n\t- a1\n\t\t- a2\n\t- \n\n\tbody\n- \n- b");
});

test("o on an item's body line opens an item after that item", async () => {
  const v = open("- a\n  more\n- b");
  gotoLine(v, 2);
  await keys(v, "o");
  assert.equal(text(v), "- a\n  more\n- \n- b");
});

test("o and O in a code block in an item open plain lines", async () => {
  const doc = "1. a\n   ```\n   code\n   ```\n2. b";
  let v = open(doc);
  gotoLine(v, 3);
  await keys(v, "o");
  type(v, "x");
  await keys(v, "<Esc>");
  assert.equal(text(v), "1. a\n   ```\n   code\n   x\n   ```\n2. b");
  v = open(doc);
  gotoLine(v, 3);
  await keys(v, "O");
  type(v, "x");
  await keys(v, "<Esc>");
  assert.equal(text(v), "1. a\n   ```\n   x\n   code\n   ```\n2. b");
});

test("o in a tab-indented code block in an item opens a plain line", async () => {
  const v = open("- a\n\t```\n\t- code\n\t```\n- b");
  gotoLine(v, 3);
  await keys(v, "o");
  type(v, "x");
  await keys(v, "<Esc>");
  // Stock o keeps the indent, in spaces here: the harness's indent unit.
  assert.equal(text(v), "- a\n\t```\n\t- code\n    x\n\t```\n- b");
});

test("o in a code block in a nested item opens a plain line", async () => {
  const v = open("- a\n  - b\n    ```\n    - code\n    ```");
  gotoLine(v, 4);
  await keys(v, "o");
  type(v, "x");
  await keys(v, "<Esc>");
  assert.equal(text(v), "- a\n  - b\n    ```\n    - code\n    x\n    ```");
});

test(">> and << on a - line in a tab-indented code block shift it as text", async () => {
  const v = open("- a\n\t```\n\t- code\n\t```\n- b");
  gotoLine(v, 3);
  await keys(v, ">>");
  assert.equal(text(v), "- a\n\t```\n  \t- code\n\t```\n- b");
  await keys(v, "<<<<");
  assert.equal(text(v), "- a\n\t```\n- code\n\t```\n- b");
});

test("o on the last line of the note opens an item", async () => {
  const v = open("- a");
  await keys(v, "o");
  assert.equal(text(v), "- a\n- ");
  assert.equal(v.state.selection.main.head, 6);
});

test("o on a folded item opens after its sub-items and keeps it folded", async () => {
  const v = open("- a\n\t- a1\n- b");
  v.dispatch({ effects: foldEffect.of({ from: v.state.doc.line(1).to, to: v.state.doc.line(2).to }) });
  await keys(v, "o");
  assert.equal(text(v), "- a\n\t- a1\n- \n- b");
  assert.deepEqual(foldedLines(v), [1]);
});

test("a count opens that many items, and . opens more", async () => {
  const v = open("1. a\n2. b");
  await keys(v, "3o");
  type(v, "x");
  await keys(v, "<Esc>");
  assert.equal(text(v), "1. a\n2. x\n3. x\n4. x\n5. b");
  await keys(v, ".");
  assert.equal(text(v), "1. a\n2. x\n3. x\n4. x\n5. x\n6. b");
});

test("u undoes the new item and the renumbering in one step", async () => {
  const v = open("1. a\n2. b\n3. c");
  await keys(v, "o<Esc>u");
  assert.equal(text(v), "1. a\n2. b\n3. c");
});

test("o on a folded code block opens below the fold", async () => {
  const v = open("# A\n```\ncode\n```\nx");
  fold(v, 2);
  gotoLine(v, 2);
  await keys(v, "o");
  assert.equal(text(v), "# A\n```\ncode\n```\n\nx");
  assert.equal(cursorLine(v), 5);
  assert.deepEqual(foldedLines(v), [2]);
});

test("O below a folded heading opens above the line, not in the fold", async () => {
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 8);
  await keys(v, "O");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n## D\n\nd");
  assert.equal(cursorLine(v), 8);
  assert.deepEqual(foldedLines(v), [3]);
});

// --- o / O on headings ------------------------------------------------------------

test("o and O on a heading open a plain line", async () => {
  let v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "o");
  assert.equal(text(v), "# A\na\n## B\n\nb\n### C\nc\n## D\nd");
  assert.equal(cursorLine(v), 4);
  assert.ok(insertMode(v));
  v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "O");
  assert.equal(text(v), "# A\na\n\n## B\nb\n### C\nc\n## D\nd");
  assert.equal(cursorLine(v), 3);
});

test("o on a folded heading opens below the fold", async () => {
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "o");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n\n## D\nd");
  assert.equal(cursorLine(v), 7);
  assert.deepEqual(foldedLines(v), [3]);
});

test("O on a heading below a folded heading opens above it, not in the fold", async () => {
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 7);
  await keys(v, "O");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n\n## D\nd");
  assert.equal(cursorLine(v), 7);
  assert.deepEqual(foldedLines(v), [3]);
});

test("u undoes o on a folded heading, fold and all", async () => {
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "o<Esc>u");
  assert.equal(text(v), DOC);
  assert.deepEqual(foldedLines(v), [3]);
});

test("o and O outside lists open plain lines", async () => {
  const v = open("# A\ntext\n---\n- - -\n```\n- code\n```");
  for (const n of [2, 4]) {
    gotoLine(v, n);
    await keys(v, "o");
    assert.equal(v.state.doc.line(n + 1).text, "", `line ${n}`);
    await keys(v, "<Esc>u");
  }
  gotoLine(v, 6);
  await keys(v, "O");
  assert.equal(v.state.doc.line(6).text, "");
});

const runCommand = (id, view) => plugin.commands.find((c) => c.id === id).editorCallback({ cm: view });

// --- commands --------------------------------------------------------------------

test("the commands keep their ids", () => {
  assert.deepEqual(plugin.commands.map((c) => c.id), [
    "cycle-local", "cycle-global", "move-subtree-down", "move-subtree-up", "insert-heading", "insert-subheading",
    "up-heading", "toggle-indent",
  ]);
});

test("toggle-indent works while the settings are still loading", async () => {
  let resolve;
  const slow = new PluginClass(app);
  slow.loadData = () => new Promise((r) => (resolve = r));
  const loaded = slow.onload();
  slow.commands.find((c) => c.id === "toggle-indent").callback();
  assert.equal(slow.settings.indent, true);
  resolve(null);
  await loaded;
  slow.onunload();
});

test("go to heading moves to the line's heading, then to its parent", async () => {
  const v = open(DOC);
  gotoLine(v, 6);
  runCommand("up-heading", v);
  assert.equal(v.state.selection.main.head, v.state.doc.line(5).from);
  runCommand("up-heading", v);
  assert.equal(cursorLine(v), 3);
  runCommand("up-heading", v);
  runCommand("up-heading", v);
  assert.equal(cursorLine(v), 1);
});

test("insert heading opens a sibling after the subtree the cursor is in", async () => {
  const v = open("# A\n\n## B\nb\n### C\nc\n\n## D");
  gotoLine(v, 4);
  await keys(v, "i");
  runCommand("insert-heading", v);
  assert.equal(text(v), "# A\n\n## B\nb\n### C\nc\n\n## \n\n## D");
  assert.equal(v.state.selection.main.head, v.state.doc.line(8).to);
  assert.ok(insertMode(v));
});

test("insert heading in normal mode goes on to insert mode", async () => {
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  runCommand("insert-heading", v);
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n## \n## D\nd");
  assert.ok(insertMode(v));
  assert.equal(v.state.selection.main.head, v.state.doc.line(7).to);
  assert.deepEqual(foldedLines(v), [3]);
});

test("insert subheading opens a heading one deeper at the end of the subtree", async () => {
  let v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "i");
  runCommand("insert-subheading", v);
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n### \n## D\nd");
  assert.deepEqual(foldedLines(v), [3]);
  v = open("###### F\nf");
  gotoLine(v, 2);
  runCommand("insert-subheading", v);
  assert.equal(text(v), "###### F\nf\n###### ");
});

test("insert heading outside any heading opens a level-1 heading", async () => {
  let v = open("intro\n\n## A\na");
  await keys(v, "i");
  runCommand("insert-heading", v);
  assert.equal(text(v), "intro\n\n# \n\n## A\na");
  v = open("text");
  runCommand("insert-subheading", v);
  assert.equal(text(v), "text\n# ");
  v = open("");
  runCommand("insert-heading", v);
  assert.equal(text(v), "# \n");
  assert.equal(v.state.selection.main.head, 2);
});

test("insert heading treats # lines in a code block as body text", () => {
  const v = open(CODE);
  gotoLine(v, 3);
  runCommand("insert-heading", v);
  assert.equal(text(v), "## A\n```sh\n# comment\n```\n## \n## B\nb");
});

test("insert heading and subheading work without vim, and u undoes them", () => {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({ doc: DOC, extensions: [history(), markdown(), codeFolding(), plugin.extensions] }),
  });
  gotoLine(v, 4);
  runCommand("insert-heading", v);
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n## \n## D\nd");
  assert.equal(v.state.selection.main.head, v.state.doc.line(7).to);
  gotoLine(v, 9);
  runCommand("insert-subheading", v);
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n## \n## D\nd\n### ");
  undo(v);
  undo(v);
  assert.equal(text(v), DOC);
  v.destroy();
});

test("commands run in normal and insert mode, not in visual mode", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  runCommand("cycle-local", v);
  assert.deepEqual(foldedLines(v), [3]);
  await keys(v, "i");
  runCommand("move-subtree-down", v);
  assert.equal(text(v), "# A\na\n## D\nd\n## B\nb\n### C\nc");
  assert.deepEqual(foldedLines(v), [5]);
  await keys(v, "<Esc>V");
  runCommand("move-subtree-up", v);
  runCommand("cycle-global", v);
  assert.equal(text(v), "# A\na\n## D\nd\n## B\nb\n### C\nc");
  assert.deepEqual(foldedLines(v), [5]);
});

test("the move commands move list items, without vim too, and u undoes them", () => {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const doc = "1. a\n   - a1\n2. b\n3. c";
  const v = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [history(), markdown(), codeFolding(), plugin.extensions] }),
  });
  runCommand("move-subtree-down", v);
  assert.equal(text(v), "1. b\n2. a\n   - a1\n3. c");
  assert.equal(cursorLine(v), 2);
  runCommand("move-subtree-down", v);
  assert.equal(text(v), "1. b\n2. c\n3. a\n   - a1");
  runCommand("move-subtree-down", v);
  runCommand("move-subtree-up", v);
  assert.equal(text(v), "1. b\n2. a\n   - a1\n3. c");
  undo(v);
  undo(v);
  assert.equal(text(v), "1. b\n2. a\n   - a1\n3. c");
  undo(v);
  assert.equal(text(v), doc);
  v.destroy();
});

test("a command that throws logs the error instead", () => {
  const logged = [];
  const error = console.error;
  console.error = (...args) => logged.push(args);
  try {
    runCommand("move-subtree-down", {});
  } finally {
    console.error = error;
  }
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "Evil Org:");
});

// jsdom has no layout, so stand in for moveVertically: the next or previous
// visible line at the same column, except that down from a closed heading it
// comes back short, as Obsidian's can: at the fold's end, still on the
// heading's screen line, or with short "hidden", on the hidden line below it.
function stubMoveVertically(view, short = "end") {
  view.moveVertically = (range, forward) => {
    const { state } = view;
    const doc = state.doc;
    const folds = [];
    for (const it = foldedRanges(state).iter(); it.value; it.next()) folds.push({ from: it.from, to: it.to });
    const line = doc.lineAt(range.head);
    const covering = folds.find((f) => f.from >= line.from && f.from <= line.to);
    if (forward && covering && range.head < covering.from) {
      return EditorSelection.cursor(short === "end" ? covering.to : doc.line(line.number + 1).from, 1);
    }
    let n = line.number;
    do n += forward ? 1 : -1;
    while (n >= 1 && n <= doc.lines && folds.some((f) => f.from < doc.line(n).from && f.to >= doc.line(n).from));
    if (n < 1 || n > doc.lines) return EditorSelection.cursor(forward ? doc.length : 0, 1);
    const target = doc.line(n);
    return EditorSelection.cursor(Math.min(target.from + range.head - line.from, target.to), 1);
  };
}

for (const short of ["end", "hidden"]) test(`j over a closed heading goes to the next visible line in one step (${short})`, async () => {
  const v = open(DOC);
  stubMoveVertically(v, short);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "j");
  assert.equal(v.state.doc.lineAt(v.state.selection.main.head).number, 7);
  assert.deepEqual(foldedLines(v), [3]);
  gotoLine(v, 1);
  await keys(v, "3j");
  assert.equal(v.state.doc.lineAt(v.state.selection.main.head).number, 7);
  assert.deepEqual(foldedLines(v), [3]);
  await keys(v, "k");
  assert.equal(v.state.doc.lineAt(v.state.selection.main.head).number, 3);
  assert.deepEqual(foldedLines(v), [3]);
});

// Vim Motions bundles a fork of codemirror-vim with an adapter class of its
// own, and sets window.CodeMirrorAdapter to a plain object whose Vim getter
// returns the fork's engine. The fork's class is patched from the editor.
test("j over a closed heading goes past it with an adapter class of another plugin", async () => {
  const stock = CodeMirror.prototype.findPosV.stock || CodeMirror.prototype.findPosV;
  const forkClass = () => {
    class Fork extends CodeMirror {}
    Fork.prototype.findPosV = function (...args) { return stock.apply(this, args); };
    return Fork;
  };
  const adapter = window.CodeMirrorAdapter;
  const bridge = {};
  Object.defineProperty(bridge, "Vim", { get: () => Vim, configurable: true });
  window.CodeMirrorAdapter = bridge;
  try {
    // Found from the active editor when the overrides are installed.
    const Fork = forkClass();
    const v = open(DOC);
    Object.setPrototypeOf(v.cm, Fork.prototype);
    plugin.installVimOverrides();
    assert.ok(Fork.prototype.findPosV.stock);
    stubMoveVertically(v);
    fold(v, 3);
    gotoLine(v, 3);
    await keys(v, "j");
    assert.equal(v.state.doc.lineAt(v.state.selection.main.head).number, 7);
    assert.deepEqual(foldedLines(v), [3]);
    // Found when an editor with another class first updates.
    const Later = forkClass();
    const w = open(DOC);
    Object.setPrototypeOf(w.cm, Later.prototype);
    stubMoveVertically(w);
    fold(w, 3);
    assert.ok(Later.prototype.findPosV.stock);
    gotoLine(w, 3);
    await keys(w, "j");
    assert.equal(w.state.doc.lineAt(w.state.selection.main.head).number, 7);
  } finally {
    window.CodeMirrorAdapter = adapter;
  }
});

// Mobile has no Vim mode: window.CodeMirrorAdapter is missing and editors carry
// no vim extension. The plugin still loads, quietly, and its commands still run.
test("without a Vim engine the plugin loads quietly and commands still work", () => {
  const logged = [];
  const error = console.error;
  const adapter = window.CodeMirrorAdapter;
  delete window.CodeMirrorAdapter;
  console.error = (...args) => logged.push(args);
  let mobile;
  try {
    mobile = new PluginClass(app);
    mobile.onload();
    mobile.installVimOverrides();
  } finally {
    console.error = error;
    window.CodeMirrorAdapter = adapter;
  }
  assert.deepEqual(logged, []);
  assert.ok(!mobile.patchedVim);
  // Alt-j finds no engine to hand the key to, so it leaves the event alone.
  const press = new window.KeyboardEvent("keydown", { key: "j", altKey: true, cancelable: true });
  mobile.handleAltMove(press);
  assert.equal(press.defaultPrevented, false);
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({ doc: DOC, extensions: [history(), markdown(), codeFolding(), mobile.extensions] }),
  });
  gotoLine(v, 3);
  mobile.commands.find((c) => c.id === "cycle-local").editorCallback({ cm: v });
  assert.deepEqual(foldedLines(v), [3]);
  v.destroy();
  mobile.onunload();
});

test("a Vim engine whose API throws is logged, patched once, and restored on unload", () => {
  // A stand-in for an engine whose defineOperator a later vim has changed.
  const calls = [];
  const record = (kind) => (name) => calls.push(`${kind} ${name}`);
  const broken = { defineMotion: record("motion"), defineAction: record("action"), mapCommand: record("map"),
    defineOperator: () => { throw new Error("no defineOperator"); } };
  const logged = [];
  const error = console.error;
  const engine = window.CodeMirrorAdapter.Vim;
  window.CodeMirrorAdapter.Vim = broken;
  console.error = (...args) => logged.push(args);
  const other = new PluginClass(app);
  try {
    other.installVimOverrides();
    other.installVimOverrides();
    assert.equal(logged.length, 1);
    assert.equal(other.patchedVim, broken);
    assert.equal(other.vimRestorers.length, 1);
    assert.ok(calls.includes("motion expandToLine"));
    const installed = calls.length;
    other.onunload();
    assert.equal(calls[installed], "motion expandToLine");
  } finally {
    console.error = error;
    window.CodeMirrorAdapter.Vim = engine;
  }
});

// Must run last: these unload the plugin.
test("unload restores every Vim engine the plugin patched", async () => {
  // A stand-in for an engine that another plugin swaps in and out again.
  const calls = [];
  const record = (kind) => (name) => calls.push(`${kind} ${name}`);
  const other = { defineMotion: record("motion"), defineOperator: record("operator"),
    defineAction: record("action"), mapCommand: record("map") };
  window.CodeMirrorAdapter.Vim = other;
  plugin.installVimOverrides();
  assert.equal(plugin.patchedVim, other);
  window.CodeMirrorAdapter.Vim = Vim;
  plugin.installVimOverrides();
  assert.equal(plugin.patchedVim, Vim);
  const installed = calls.length;
  assert.ok(CodeMirror.prototype.findPosV.stock);
  assert.ok(Vim.getRegisterController().pushText.stock);
  const lp = openLP(LP);
  gotoLine(lp, 4);
  assert.equal(highlights(lp).length, 1);
  plugin.onunload();
  assert.deepEqual(highlights(lp), []);
  assert.ok(!CodeMirror.prototype.findPosV.stock);
  assert.ok(!Vim.getRegisterController().pushText.stock);
  assert.deepEqual(calls.slice(installed).sort(), [
    "action orgMoveSubtree", "action orgOpenLine", "action orgPaste", "action orgTableEdit", "motion expandToLine", "motion orgCell", "motion orgElement", "motion orgPasteAfter", "motion orgPasteBefore",
    "motion orgSubtree", "motion orgUpHeading", "operator orgDelete", "operator orgIndent",
  ]);
  // Vim, patched twice, is back to stock: dd on a folded heading deletes one line.
  const v = open(DOC);
  fold(v, 3);
  gotoLine(v, 3);
  await keys(v, "dd");
  assert.equal(text(v), "# A\na\nb\n### C\nc\n## D\nd");
});

test("after unload, >> on a heading indents as stock vim does", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, ">>");
  assert.match(v.state.doc.line(3).text, /^\s+## B$/);
});

test("after unload, > in visual block mode shifts the block as stock vim does", async () => {
  const v = open("abc\ndef");
  gotoLine(v, 1);
  await keys(v, "l<C-v>j>");
  assert.equal(text(v), "a    bc\nd    ef");
});

test("after unload, d deletes as stock vim does", async () => {
  const v = open(DOC);
  gotoLine(v, 8);
  await keys(v, "dd");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n## D");
  gotoLine(v, 6);
  await keys(v, "VGd");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\n");
});

test("after unload, o in a list opens a plain line", async () => {
  const v = open("- a\n- b");
  await keys(v, "o");
  assert.equal(text(v), "- a\n\n- b");
});

test("after unload, M-j, dar and dae do nothing", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "<A-j>dardaedie");
  assert.equal(text(v), DOC);
});

test("after unload, the table keys do nothing", async () => {
  const v = open(TBL);
  gotoCell(v, 4, "2");
  await keys(v, "<A-j><OrgTableMoveColumnLeft><OrgTableInsertRow>");
  const event = metaKey(v, "S-l");
  await tick();
  assert.ok(!event.defaultPrevented);
  assert.equal(text(v), TBL);
});

test("after unload, di| does nothing and a block in a table yanks its text", async () => {
  const v = open(CELLS);
  gotoCell(v, 3, "x");
  await keys(v, "di|");
  assert.equal(text(v), CELLS);
  await block(v, [3, "x"], [3, "y"], "y");
  assert.ok(!unnamed().toString().includes("\t"));
});

test("after unload, gh does not move", async () => {
  const v = open(DOC);
  gotoLine(v, 6);
  await keys(v, "gh");
  assert.equal(cursorLine(v), 6);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
