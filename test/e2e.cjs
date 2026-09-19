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
const { history } = require("@codemirror/commands");
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
  assert.deepEqual(foldedLines(v), [3, 5, 7]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [1, 3, 5, 7]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), []);
});

test("S-Tab treats the shallowest heading level as top", async () => {
  const v = open("## A\na\n### A1\nx\n## B\nb");
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [3]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [1, 3, 5]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), []);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [3]);
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

// macOS Option-j: the key is "∆", the code "KeyJ". Obsidian's Vim would read
// it as plain `j`, so the event must not reach the editor's own handlers.
function optionKey(view, letter) {
  const event = new window.KeyboardEvent("keydown", {
    key: letter === "j" ? "∆" : "˚", code: letter === "j" ? "KeyJ" : "KeyK",
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

// --- commands --------------------------------------------------------------------

const runCommand = (id, view) => plugin.commands.find((c) => c.id === id).editorCallback({ cm: view });

test("the four commands keep their ids", () => {
  assert.deepEqual(plugin.commands.map((c) => c.id), ["cycle-local", "cycle-global", "move-subtree-down", "move-subtree-up"]);
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
    "action orgMoveSubtree", "motion expandToLine", "motion orgPasteAfter", "motion orgPasteBefore",
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

test("after unload, d deletes as stock vim does", async () => {
  const v = open(DOC);
  gotoLine(v, 8);
  await keys(v, "dd");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\nc\n## D");
  gotoLine(v, 6);
  await keys(v, "VGd");
  assert.equal(text(v), "# A\na\n## B\nb\n### C\n");
});

test("after unload, M-j and dar do nothing", async () => {
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, "<A-j>dar");
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
