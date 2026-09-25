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

const { EditorState } = require("@codemirror/state");
const { EditorView, runScopeHandlers } = require("@codemirror/view");
const { foldable, foldedRanges, foldEffect, codeFolding } = require("@codemirror/language");
const { markdown } = require("@codemirror/lang-markdown");
const { history, undo } = require("@codemirror/commands");
const { vim, Vim, getCM } = require("@replit/codemirror-vim");

let activeView = null;
class Plugin {
  constructor(app) { this.app = app; this.extensions = []; this.commands = []; }
  registerEditorExtension(ext) { this.extensions.push(ext); }
  registerEvent() {}
  registerDomEvent(el, type, fn, options) { el.addEventListener(type, fn, options); }
  addCommand(cmd) { this.commands.push(cmd); }
}
class MarkdownView {}
const app = {
  workspace: {
    getActiveViewOfType: () => (activeView ? { editor: { cm: activeView } } : null),
    onLayoutReady: (cb) => cb(),
    on: () => ({}),
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "obsidian") return { Plugin, MarkdownView };
  return origLoad.call(this, request, ...rest);
};
window.CodeMirrorAdapter = { Vim };
Vim.suppressErrorLogging = true;

const PluginClass = require(path.join(__dirname, "..", "main.js"));
const plugin = new PluginClass(app);
plugin.onload();

const tick = () => new Promise((r) => setTimeout(r, 0));

function open(text) {
  if (activeView) activeView.destroy();
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  activeView = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [vim(), history(), markdown(), codeFolding(), plugin.extensions],
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

test("Tab cycles folded -> children -> subtree", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "<Tab>");
  assert.deepEqual(foldedLines(v), [3]);
  await keys(v, "<Tab>");
  assert.deepEqual(foldedLines(v), [5]);
  await keys(v, "<Tab>");
  assert.deepEqual(foldedLines(v), []);
});

test("Tab after a pending operator is left to vim", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "d<Tab>");
  assert.deepEqual(foldedLines(v), []);
});

test("S-Tab cycles overview -> contents -> show all", async () => {
  const v = open(DOC);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [1]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [3, 5, 7]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), []);
});

test("S-Tab treats the shallowest heading level as top", async () => {
  const v = open("## A\na\n### A1\nx\n## B\nb");
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [1, 5]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [3]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), []);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [1, 5]);
});

test("S-Tab on headings all at one level cycles overview -> show all", async () => {
  const v = open("# A\na\n# B\nb\n# C\nc");
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [1, 3, 5]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), []);
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
  const event = new window.KeyboardEvent("keydown", {
    key: OPTION_KEYS[letter], code: `Key${letter.toUpperCase()}`,
    altKey: true, bubbles: true, cancelable: true,
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
  ]);
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
  plugin.onunload();
  assert.deepEqual(calls.slice(installed).sort(), [
    "action orgMoveSubtree", "action orgOpenLine", "motion expandToLine", "motion orgElement", "motion orgPasteAfter", "motion orgPasteBefore",
    "motion orgSubtree", "operator orgDelete", "operator orgIndent",
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
