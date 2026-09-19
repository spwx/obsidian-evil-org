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

test("S-Tab cycles overview -> contents -> show all", async () => {
  const v = open(DOC);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [3, 5, 7]);
  await keys(v, "<S-Tab>");
  assert.deepEqual(foldedLines(v), [1, 3, 5, 7]);
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

test(">> and << on a body line still indent", async () => {
  const v = open(DOC);
  gotoLine(v, 4);
  await keys(v, ">>");
  assert.match(v.state.doc.line(4).text, /^\s+b$/);
  await keys(v, "<<");
  assert.equal(text(v), DOC);
});

// Must run last: it unloads the plugin.
test("after unload, >> on a heading indents as stock vim does", async () => {
  plugin.onunload();
  const v = open(DOC);
  gotoLine(v, 3);
  await keys(v, ">>");
  assert.match(v.state.doc.line(3).text, /^\s+## B$/);
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
