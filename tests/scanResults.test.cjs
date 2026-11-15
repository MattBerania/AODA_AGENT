const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerWorkspaceScanResults } = require('../dist/scanResults.js');
const { registerRepositoryScanning, SCAN_REPOSITORY_COMMAND } = require('../dist/repositoryScanning.js');
const { registerCurrentPageScanning, SCAN_CURRENT_PAGE_COMMAND } = require('../dist/currentPageScanning.js');

function makeUri(value) {
  const url = new URL(value);
  return { scheme: url.protocol.slice(0, -1), authority: url.host,
    path: decodeURIComponent(url.pathname), toString: () => value };
}

function makeDocument(uri, source) {
  return {
    uri: makeUri(uri), version: 1, source,
    getText(range) {
      if (!range) return this.source;
      const offsets = [0];
      for (const match of this.source.matchAll(/\r\n|\r|\n/g)) offsets.push(match.index + match[0].length);
      return this.source.slice(offsets[range.start.line] + range.start.character,
        offsets[range.end.line] + range.end.character);
    },
  };
}

function makeHost() {
  class EventEmitter {
    listeners = new Set();
    event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  const events = Object.fromEntries(['edits', 'deleted', 'closed', 'editor'].map((key) => [key, new EventEmitter()]));
  const documents = new Map();
  const commands = new Map();
  const diagnostics = new Map();
  const messages = { info: [], warning: [], error: [] };
  const collection = {
    disposed: false,
    set: (uri, entries) => diagnostics.set(uri.toString(), entries),
    delete: (uri) => diagnostics.delete(uri.toString()),
    clear: () => diagnostics.clear(),
    dispose() { this.disposed = true; diagnostics.clear(); },
  };
  const api = {
    EventEmitter, Uri: { parse: makeUri },
    Range: class {
      constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; }
    },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    languages: { createDiagnosticCollection: () => collection },
    workspace: {
      workspaceFolders: [{ uri: makeUri('file:///demo') }],
      findFiles: async () => [...documents.values()].map((document) => document.uri),
      openTextDocument: async (uri) => {
        const document = documents.get(uri.toString());
        if (!document || document.fail) throw new Error('Cannot open file');
        return document;
      },
      onDidChangeTextDocument: events.edits.event,
      onDidDeleteFiles: events.deleted.event,
      onDidCloseTextDocument: events.closed.event,
    },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: events.editor.event,
      showInformationMessage: async (message) => { messages.info.push(message); },
      showWarningMessage: async (message) => { messages.warning.push(message); },
      showErrorMessage: async (message) => { messages.error.push(message); },
    },
    commands: { registerCommand(id, handler) { commands.set(id, handler); return { dispose: () => commands.delete(id) }; } },
  };
  const context = { subscriptions: [] };
  const results = registerWorkspaceScanResults(api, context);
  const scanner = registerCurrentPageScanning(api, context, results);
  registerRepositoryScanning(api, context, results);
  return {
    api, documents, diagnostics, messages, results, scanner, events, collection,
    add(uri, source) { const document = makeDocument(uri, source); documents.set(uri, document); return document; },
    repository: () => commands.get(SCAN_REPOSITORY_COMMAND)(),
    current(document) { api.window.activeTextEditor = { document }; return commands.get(SCAN_CURRENT_PAGE_COMMAND)(); },
    dispose() { for (const entry of context.subscriptions) entry.dispose(); },
  };
}

test('repository results preserve exact file locations, immutable contexts, and current-page compatibility', async () => {
  const host = makeHost();
  try {
    const first = host.add('vscode-remote://ssh-remote+server/demo/PAGE.HTML', '😀<img>');
    const second = host.add('file:///demo/Views/page.cshtml', '@model Demo\r\n<button></button>');
    await host.repository();
    assert.equal(host.results.getSnapshots().length, 2);
    assert.equal(host.diagnostics.size, 2);
    const snapshot = host.results.getSnapshot(first.uri.toString());
    const issue = snapshot.issues[0];
    const diagnostic = host.diagnostics.get(first.uri.toString())[0];
    assert.deepEqual(diagnostic.range.start, { line: 0, character: 2 });
    assert.deepEqual(diagnostic.range.end, { line: 0, character: 7 });
    assert.equal(diagnostic.code, 'image-text-alternative');
    assert.equal(diagnostic.source, 'OPS AODA');
    assert.equal(host.results.getIssueContext(issue.id).originalText, '<img>');
    assert.equal(host.results.getIssueContext(issue.id).documentVersion, 1);
    assert.ok(Object.isFrozen(snapshot.issues[0].range));
    assert.ok(Object.isFrozen(host.results.getIssueContext(issue.id).rule));
    host.current(first);
    assert.equal(host.scanner.getLatestScan().fileUri, first.uri.toString());
    assert.equal(host.scanner.getIssueContext(issue.id).originalText, '<img>');
    assert.equal(host.diagnostics.size, 2);
    assert.equal(host.diagnostics.get(first.uri.toString()).length, 1, 'no duplicate current/repository diagnostic');
    host.api.window.activeTextEditor = undefined;
    host.events.editor.fire(undefined);
    assert.equal(host.scanner.getLatestScan(), undefined);
    assert.equal(host.diagnostics.size, 2, 'switching focus preserves workspace findings');
    assert.equal(host.results.getSnapshot(second.uri.toString()).issues[0].range.startLine, 1);
  } finally { host.dispose(); }
});

test('rescans replace resolved findings, remove missing files, and isolate failed files', async () => {
  const host = makeHost();
  try {
    const first = host.add('file:///demo/first.html', '<img>');
    const second = host.add('file:///demo/second.html', '<button></button>');
    const third = host.add('file:///demo/third.html', '<iframe></iframe>');
    await host.repository();
    const oldId = host.results.getSnapshot(first.uri.toString()).issues[0].id;
    first.source = '<img alt="Logo">'; first.version++;
    second.fail = true;
    host.documents.delete(third.uri.toString());
    await host.repository();
    assert.deepEqual(host.diagnostics.get(first.uri.toString()), []);
    assert.equal(host.results.getIssueContext(oldId), undefined);
    assert.equal(host.results.getSnapshot(first.uri.toString()).documentVersion, 2);
    assert.equal(host.results.getSnapshot(second.uri.toString()), undefined);
    assert.equal(host.results.getSnapshot(third.uri.toString()), undefined);
    assert.match(host.messages.warning[0], /second.html: Cannot open file/);
  } finally { host.dispose(); }
});

test('source edits invalidate only that URI and folder deletion respects path boundaries', async () => {
  const host = makeHost();
  try {
    const first = host.add('file:///demo/Views/first.html', '<img>');
    const second = host.add('file:///demo/ViewsExtra/second.html', '<img>');
    await host.repository();
    host.events.edits.fire({ document: first, contentChanges: [] });
    assert.equal(host.diagnostics.size, 2);
    host.events.edits.fire({ document: first, contentChanges: [{ text: 'changed' }] });
    assert.equal(host.results.getSnapshot(first.uri.toString()), undefined);
    assert.ok(host.results.getSnapshot(second.uri.toString()));
    await host.repository();
    host.events.deleted.fire({ files: [makeUri('file:///demo/Views')] });
    assert.equal(host.results.getSnapshot(first.uri.toString()), undefined);
    assert.ok(host.results.getSnapshot(second.uri.toString()));
  } finally { host.dispose(); }
  assert.equal(host.collection.disposed, true);
  assert.equal(host.results.getSnapshots().length, 0);
});

test('overlapping commands do not interleave scans and failure permits a later retry', async () => {
  const host = makeHost();
  try {
    let rejectDiscovery;
    host.api.workspace.findFiles = () => new Promise((_, reject) => { rejectDiscovery = reject; });
    const pending = host.repository();
    await host.repository();
    assert.match(host.messages.info[0], /already running/);
    rejectDiscovery(new Error('Search unavailable'));
    await pending;
    assert.match(host.messages.error[0], /Search unavailable/);
    host.api.workspace.findFiles = async () => [];
    await host.repository();
    assert.match(host.messages.info.at(-1), /0 files discovered/);
  } finally { host.dispose(); }
});

test('active-file edits and failed current scans preserve other repository findings', async () => {
  const host = makeHost();
  try {
    const first = host.add('file:///demo/first.html', '<img>');
    const second = host.add('file:///demo/second.html', '<button></button>');
    await host.repository();
    host.current(first);
    first.source = '<img alt="Logo">'; first.version++;
    host.events.edits.fire({ document: first, contentChanges: [{ text: first.source }] });
    assert.equal(host.scanner.getLatestScan(), undefined);
    assert.equal(host.results.getSnapshot(first.uri.toString()), undefined);
    assert.ok(host.results.getSnapshot(second.uri.toString()));
    const refreshed = host.scanner.refreshCurrentPage();
    assert.deepEqual(refreshed.issues, []);
    assert.deepEqual(host.diagnostics.get(first.uri.toString()), []);
    assert.equal(host.diagnostics.get(second.uri.toString()).length, 1);
    first.getText = () => { throw new Error('Cannot read buffer'); };
    host.current(first);
    assert.equal(host.results.getSnapshot(first.uri.toString()).status, 'failed');
    assert.ok(host.results.getSnapshot(second.uri.toString()));
    assert.match(host.messages.error[0], /Cannot read buffer/);
  } finally { host.dispose(); }
});

test('real HTML fixtures publish all six rules while a named fixture remains empty', async () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const host = makeHost();
  try {
    const missing = host.add('file:///demo/missing-names.html',
      readFileSync(join(__dirname, 'fixtures', 'missing-names.html'), 'utf8'));
    const named = host.add('file:///demo/recognized-names.html',
      readFileSync(join(__dirname, 'fixtures', 'recognized-names.html'), 'utf8'));
    await host.repository();
    const snapshot = host.results.getSnapshot(missing.uri.toString());
    assert.equal(new Set(snapshot.issues.map((issue) => issue.ruleId)).size, 6);
    assert.equal(host.diagnostics.get(missing.uri.toString()).length, 6);
    assert.deepEqual(host.diagnostics.get(named.uri.toString()), []);
    for (const issue of snapshot.issues) {
      const details = host.results.getIssueContext(issue.id);
      assert.equal(details.rule.id, issue.ruleId);
      assert.match(details.originalText, /^</);
    }
  } finally { host.dispose(); }
});

test('outcome transitions clear stale contexts and preserve unrelated files', async () => {
  const host = makeHost();
  try {
    const first = host.add('file:///demo/first.cshtml', '<img>');
    const second = host.add('file:///demo/second.html', '<button></button>');
    await host.repository();
    host.current(first);
    const oldId = host.scanner.getLatestScan().issues[0].id;
    const other = host.results.getSnapshot(second.uri.toString());
    first.source = '@if (true) { <img> }'; first.version++;
    await host.repository();
    assert.equal(host.results.getSnapshot(first.uri.toString()).status, 'skipped');
    assert.equal(host.scanner.getLatestScan().status, 'skipped');
    assert.equal(host.scanner.getIssueContext(oldId), undefined);
    assert.deepEqual(host.diagnostics.get(first.uri.toString()), []);
    first.source = '<img>'; first.version++;
    host.current(first);
    assert.equal(host.scanner.getLatestScan().status, 'analyzed');
    assert.equal(host.scanner.getLatestScan().issues.length, 1);
    const read = first.getText;
    first.getText = () => { throw new Error('buffer unavailable'); };
    host.current(first);
    assert.equal(host.scanner.getLatestScan().status, 'failed');
    first.getText = read; first.source = '<img alt="">'; first.version++;
    host.current(first);
    assert.equal(host.scanner.getLatestScan().status, 'analyzed');
    assert.deepEqual(host.scanner.getLatestScan().issues, []);
    assert.deepEqual(host.results.getSnapshot(second.uri.toString()), other);
  } finally { host.dispose(); }
});
test('a delayed repository failure preserves a newer current-file result', async () => {
  const host = makeHost();
  try {
    const document = host.add('file:///demo/first.html', '<img>');
    let rejectOpen;
    let opened;
    const started = new Promise(resolve => { opened = resolve; });
    host.api.workspace.openTextDocument = () => new Promise((resolve, reject) => { rejectOpen = reject; opened(); });
    const pending = host.repository();
    await started;
    host.current(document);
    const newer = host.results.getSnapshot(document.uri.toString());
    rejectOpen(new Error('old open failed'));
    await pending;
    assert.equal(host.results.getSnapshot(document.uri.toString()), newer);
    assert.equal(host.scanner.getLatestScan(), newer);
  } finally { host.dispose(); }
});

test('an older successful repository open cannot overwrite a newer scan', async () => {
  const host = makeHost();
  try {
    const document = host.add('file:///demo/first.html', '<img>');
    let resolveOpen;
    let opened;
    const started = new Promise(resolve => { opened = resolve; });
    host.api.workspace.openTextDocument = () => new Promise(resolve => { resolveOpen = resolve; opened(); });
    const pending = host.repository();
    await started;
    document.source = '<img alt="Logo">'; document.version++;
    host.current(document);
    const newer = host.results.getSnapshot(document.uri.toString());
    resolveOpen(makeDocument(document.uri.toString(), '<img>'));
    await pending;
    assert.equal(host.results.getSnapshot(document.uri.toString()), newer);
    assert.deepEqual(newer.issues, []);
    assert.match(host.messages.warning[0], /Superseded/);
  } finally { host.dispose(); }
});
test('deleting a file during an asynchronous open prevents publication', async () => {
  const host = makeHost();
  try {
    const document = host.add('file:///demo/first.html', '<img>');
    let resolveOpen;
    let opened;
    const started = new Promise(resolve => { opened = resolve; });
    host.api.workspace.openTextDocument = () => new Promise(resolve => { resolveOpen = resolve; opened(); });
    const pending = host.repository();
    await started;
    host.events.deleted.fire({ files: [document.uri] });
    resolveOpen(document);
    await pending;
    assert.equal(host.results.getSnapshot(document.uri.toString()), undefined);
    assert.equal(host.diagnostics.size, 0);
  } finally { host.dispose(); }
});

test('shared current-file publication emits one completed event', () => {
  const host = makeHost();
  try {
    const document = host.add('file:///demo/first.html', '<img>');
    const events = [];
    host.scanner.onDidChangeScan(snapshot => events.push(snapshot));
    host.current(document);
    assert.deepEqual(events, [host.scanner.getLatestScan()]);
  } finally { host.dispose(); }
});
