const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerCurrentPageScanning, SCAN_CURRENT_PAGE_COMMAND, SCAN_DEBOUNCE_MS } = require('../dist/currentPageScanning.js');
const { registerIssuePresentation, SHOW_SCAN_ISSUES_COMMAND, SHOW_ISSUE_COMMAND } = require('../dist/issuePresentation.js');

// Advance the debounce clock explicitly instead of waiting in real time.
beforeEach((t) => t.mock.timers.enable({ apis: ['setTimeout'] }));

function makeDocument(source, uriString = 'file:///demo/contact.cshtml') {
  return {
    uri: { path: decodeURIComponent(new URL(uriString).pathname), toString: () => uriString },
    version: 1,
    getText(range) {
      if (!range) return source;
      const lineStarts = [0];
      for (const match of source.matchAll(/\r\n|\r|\n/g)) {
        lineStarts.push(match.index + match[0].length);
      }
      return source.slice(lineStarts[range.start.line] + range.start.character,
        lineStarts[range.end.line] + range.end.character);
    },
  };
}

// Only the VS Code boundary is simulated. The real scanner processes the text.
function makeHost(document) {
  const commands = new Map();
  const messages = { info: [], warning: [], error: [] };
  const collection = {
    entries: new Map(), disposed: false,
    clear() { this.entries.clear(); },
    set(uri, diagnostics) { this.entries.set(uri, diagnostics); },
    dispose() { this.disposed = true; this.entries.clear(); },
  };
  class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  }
  class Diagnostic {
    constructor(range, message, severity) {
      Object.assign(this, { range, message, severity });
    }
  }
  class EventEmitter {
    listeners = new Set();
    event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  const events = {
    edits: new EventEmitter(), activeEditor: new EventEmitter(), closedDocument: new EventEmitter(),
  };
  const api = {
    Range, Diagnostic, EventEmitter,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    window: {
      activeTextEditor: document ? { document } : undefined,
      onDidChangeActiveTextEditor: events.activeEditor.event,
      showInformationMessage(message) { messages.info.push(message); return Promise.resolve(); },
      showWarningMessage(message) { messages.warning.push(message); return Promise.resolve(); },
      showErrorMessage(message) { messages.error.push(message); return Promise.resolve(); },
    },
    workspace: {
      onDidChangeTextDocument: events.edits.event,
      onDidCloseTextDocument: events.closedDocument.event,
    },
    languages: {
      createDiagnosticCollection(name) {
        assert.equal(name, 'ops-aoda');
        return collection;
      },
    },
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose() { commands.delete(id); } };
      },
    },
  };
  const context = { subscriptions: [] };
  const integration = registerCurrentPageScanning(api, context);
  return {
    api, collection, messages, context, commands, integration, events,
    run: () => commands.get(SCAN_CURRENT_PAGE_COMMAND)(),
    edit(source, edited = api.window.activeTextEditor.document) {
      edited.getText = makeDocument(source, edited.uri.toString()).getText;
      edited.version++;
      events.edits.fire({ document: edited, contentChanges: [{ text: source }] });
    },
    switchTo(next) {
      api.window.activeTextEditor = next ? { document: next } : undefined;
      events.activeEditor.fire(api.window.activeTextEditor);
    },
  };
}

test('extension manifest points to the compiled entry point and registered command', () => {
  const manifest = require('../package.json');
  assert.match(manifest.name, /^[a-z0-9][a-z0-9-]*$/);
  assert.match(manifest.publisher, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(manifest.engines.vscode, '^1.95.0');
  assert.ok(manifest.activationEvents.includes('onStartupFinished'));
  assert.equal(manifest.main, './dist/extension.js');
  assert.ok(existsSync(join(__dirname, '..', manifest.main)));
  assert.ok(manifest.contributes.commands.some((command) => command.command === SCAN_CURRENT_PAGE_COMMAND));
  assert.ok(manifest.contributes.commands.some((command) => command.command === SHOW_SCAN_ISSUES_COMMAND));
});

test('command explains when there is no active editor', () => {
  const host = makeHost();
  assert.deepEqual(host.run(), []);
  assert.match(host.messages.info[0], /Open an .html or .cshtml/);
  assert.equal(host.collection.entries.size, 0);
});

test('unsupported documents are rejected before reading their contents', () => {
  const document = makeDocument('', 'file:///demo/app.ts');
  document.getText = () => { throw new Error('Unsupported document must not be read'); };
  const host = makeHost(document);
  assert.deepEqual(host.run(), []);
  assert.equal(host.messages.warning.length, 1);
  assert.equal(host.messages.error.length, 0);
  assert.equal(host.collection.entries.size, 0);
});

test('an unnamed unsaved document is handled as unsupported', () => {
  const host = makeHost(makeDocument('<img>', 'untitled:Untitled-1'));
  assert.deepEqual(host.run(), []);
  assert.equal(host.messages.warning.length, 1);
});

test('current-page scan uses the editor buffer, including unsaved changes', () => {
  const fixture = join(__dirname, 'fixtures', 'recognized-names.html');
  // Disk has named elements. The unsaved editor buffer has a missing alternative.
  const document = makeDocument('<img>', pathToFileURL(fixture).href);
  document.isDirty = true;
  const host = makeHost(document);
  const issues = host.run();
  assert.deepEqual(issues.map((issue) => issue.ruleId), ['image-text-alternative']);
  assert.equal(issues[0].fileUri, document.uri.toString());
  assert.equal(host.collection.entries.get(document.uri).length, 1);
});

for (const fileUri of [
  'file:///demo/PAGE.HTML', 'file:///demo/PAGE.CSHTML',
  'file:///demo/Legacy%20Views/%C3%A9dit.cshtml',
  'vscode-remote://ssh-remote+server/app/view.cshtml',
  'untitled:Scratch.html',
]) {
  test(`preserves the document URI: ${fileUri}`, () => {
    const document = makeDocument('<img>', fileUri);
    const host = makeHost(document);
    const [issue] = host.run();
    assert.equal(issue.fileUri, fileUri);
    assert.equal(JSON.parse(issue.id)[0], fileUri);
    assert.ok(host.collection.entries.has(document.uri));
  });
}

test('Problems entries retain exact UTF-16 and CRLF scanner ranges', () => {
  const document = makeDocument('😀\r\n  <img\r\n src="x">', 'file:///demo/page.html');
  const host = makeHost(document);
  const [issue] = host.run();
  const [diagnostic] = host.collection.entries.get(document.uri);
  assert.deepEqual(issue.range, { startLine: 1, startCharacter: 2, endLine: 2, endCharacter: 9 });
  assert.deepEqual(diagnostic.range.start, { line: 1, character: 2 });
  assert.deepEqual(diagnostic.range.end, { line: 2, character: 9 });
  assert.equal(diagnostic.code, 'image-text-alternative');
  assert.equal(diagnostic.source, 'OPS AODA');
  assert.equal(diagnostic.severity, host.api.DiagnosticSeverity.Error);
  assert.equal(diagnostic.message, issue.message);
});

test('legacy contact fixture findings identify the original document and exact opening tags', () => {
  const fixture = join(__dirname, 'fixtures', 'legacy', 'contact.cshtml');
  const source = readFileSync(fixture, 'utf8');
  const document = makeDocument(source, pathToFileURL(fixture).href);
  const host = makeHost(document);
  const findings = host.run();
  const expected = [
    ['image-text-alternative', '<img src="/Content/Images/office.jpg">'],
    ['form-control-name', '<input id="phone" name="Phone" type="tel">'],
    ['button-name', '<button type="submit">'],
    ['link-name', '<a href="/Contact/Directions">'],
    ['iframe-name', '<iframe src="/Contact/Map">'],
  ];
  assert.deepEqual(findings.map((issue) => issue.ruleId), expected.map(([ruleId]) => ruleId));
  const diagnostics = host.collection.entries.get(document.uri);
  const lines = source.split(/\r\n|\r|\n/);
  for (let index = 0; index < findings.length; index++) {
    const issue = findings[index];
    const diagnostic = diagnostics[index];
    assert.equal(issue.fileUri, document.uri.toString());
    assert.equal(issue.range.startLine, issue.range.endLine);
    assert.equal(lines[issue.range.startLine].slice(issue.range.startCharacter, issue.range.endCharacter), expected[index][1]);
    assert.deepEqual(diagnostic.range.start, { line: issue.range.startLine, character: issue.range.startCharacter });
    assert.deepEqual(diagnostic.range.end, { line: issue.range.endLine, character: issue.range.endCharacter });
    const [, , start, end] = JSON.parse(issue.id);
    assert.equal(source.slice(start, end), expected[index][1]);
  }
  assert.match(host.messages.info[0], /5 accessibility findings/);
});

test('HTML fixture runs all six detectors through the registered command', () => {
  const fixture = join(__dirname, 'fixtures', 'missing-names.html');
  const document = makeDocument(readFileSync(fixture, 'utf8'), pathToFileURL(fixture).href);
  const host = makeHost(document);
  const findings = host.run();
  assert.equal(findings.length, 6);
  assert.equal(new Set(findings.map((issue) => issue.ruleId)).size, 6);
  assert.equal(host.collection.entries.get(document.uri).length, 6);
});

for (const name of ['_Layout.cshtml', 'orders.cshtml']) {
  test(`unsupported legacy Razor remains a conservative whole-file skip: ${name}`, () => {
    const fixture = join(__dirname, 'fixtures', 'legacy', name);
    const host = makeHost(makeDocument(readFileSync(fixture, 'utf8'), pathToFileURL(fixture).href));
    assert.deepEqual(host.run(), []);
    assert.match(host.messages.info[0], /Unsupported Razor or malformed HTML may have been skipped/);
    assert.equal(host.messages.error.length, 0);
  });
}

test('a supported page with no findings publishes an empty diagnostic list', () => {
  const document = makeDocument('<img alt="">');
  const host = makeHost(document);
  assert.deepEqual(host.run(), []);
  assert.deepEqual(host.collection.entries.get(document.uri), []);
  assert.match(host.messages.info[0], /No confirmed findings/);
});

test('each explicit invocation uses the currently active page and replaces the displayed snapshot', () => {
  const first = makeDocument('<img>', 'file:///demo/first.html');
  const second = makeDocument('<button></button>', 'file:///demo/second.cshtml');
  const host = makeHost(first);
  host.run();
  host.api.window.activeTextEditor = { document: second };
  assert.equal(host.run()[0].fileUri, second.uri.toString());
  assert.equal(host.collection.entries.size, 1);
  assert.ok(!host.collection.entries.has(first.uri));
  assert.equal(host.collection.entries.get(second.uri)[0].code, 'button-name');
});

test('unexpected read failures are reported and clear the previous snapshot', () => {
  const document = makeDocument('<img>');
  const host = makeHost(document);
  host.run();
  document.getText = () => { throw new Error('Test read failure'); };
  assert.deepEqual(host.run(), []);
  assert.match(host.messages.error[0], /could not scan.*Test read failure/);
  assert.equal(host.collection.entries.size, 0);
});

test('command and diagnostics are registered for disposal with the extension', () => {
  const host = makeHost();
  assert.equal(host.context.subscriptions.length, 6);
  for (const disposable of host.context.subscriptions) disposable.dispose();
  assert.equal(host.collection.disposed, true);
  assert.equal(host.commands.size, 0);
});

test('scanner integration starts without a snapshot or issue context', () => {
  const host = makeHost();
  assert.equal(host.integration.getLatestScan(), undefined);
  assert.equal(host.integration.getIssueContext('missing'), undefined);
});

test('published scan context contains metadata, exact source and document version', () => {
  const document = makeDocument('prefix\r\n  <img\r\n src="office.png">');
  document.version = 7;
  const host = makeHost(document);
  const events = [];
  host.integration.onDidChangeScan((snapshot) => {
    assert.equal(snapshot, host.integration.getLatestScan());
    assert.equal(host.collection.entries.get(document.uri).length, snapshot.issues.length);
    events.push(snapshot);
  });
  const issues = host.run();
  const snapshot = host.integration.getLatestScan();
  assert.deepEqual(events, [snapshot]);
  assert.equal(snapshot.fileUri, document.uri.toString());
  assert.equal(snapshot.documentVersion, 7);
  const details = host.integration.getIssueContext(issues[0].id);
  assert.equal(details.issue, snapshot.issues[0]);
  assert.equal(details.originalText, '<img\r\n src="office.png">');
  assert.equal(details.documentVersion, 7);
  assert.equal(details.rule.id, 'image-text-alternative');
  assert.ok(details.rule.description.length > 0);
  assert.ok(details.rule.remediation.includes('alt'));
});

test('shared snapshots are isolated from command return values and consumer mutations', () => {
  const host = makeHost(makeDocument('<img>'));
  const returned = host.run();
  const snapshot = host.integration.getLatestScan();
  const details = host.integration.getIssueContext(returned[0].id);
  returned[0].range.startLine = 99;
  returned.pop();
  assert.equal(snapshot.issues.length, 1);
  assert.equal(snapshot.issues[0].range.startLine, 0);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.issues[0]));
  assert.ok(Object.isFrozen(details));
  assert.ok(Object.isFrozen(details.rule));
  assert.throws(() => snapshot.issues.push(snapshot.issues[0]), TypeError);
  assert.throws(() => snapshot.issues[0].wcagCriteria.push('other'), TypeError);
  assert.throws(() => details.rule.wcagCriteria.push('other'), TypeError);
});

test('new scans replace issue contexts and subscription disposal stops notifications', () => {
  const host = makeHost(makeDocument('<img>', 'file:///first.html'));
  const events = [];
  const subscription = host.integration.onDidChangeScan((snapshot) => events.push(snapshot));
  const [oldIssue] = host.run();
  host.api.window.activeTextEditor = { document: makeDocument('<button></button>', 'file:///second.html') };
  const [newIssue] = host.run();
  assert.equal(host.integration.getIssueContext(oldIssue.id), undefined);
  assert.equal(host.integration.getIssueContext(newIssue.id).issue.ruleId, 'button-name');
  assert.equal(events.length, 2);
  subscription.dispose();
  host.run();
  assert.equal(events.length, 2);
});

test('unsupported command requests retain the latest successful shared snapshot', () => {
  const host = makeHost(makeDocument('<img>'));
  host.run();
  const snapshot = host.integration.getLatestScan();
  host.api.window.activeTextEditor = { document: makeDocument('', 'file:///app.ts') };
  host.run();
  assert.equal(host.integration.getLatestScan(), snapshot);
});

test('failed scans clear shared results and notify consumers without partial contexts', () => {
  const document = makeDocument('<img><button></button>');
  const host = makeHost(document);
  const [previous] = host.run();
  const events = [];
  host.integration.onDidChangeScan((snapshot) => events.push(snapshot));
  const getText = document.getText;
  let rangedReads = 0;
  document.getText = (range) => {
    if (range && ++rangedReads === 2) throw new Error('Failed to capture second occurrence');
    return getText(range);
  };
  assert.deepEqual(host.run(), []);
  assert.deepEqual(events, [undefined]);
  assert.equal(host.integration.getLatestScan(), undefined);
  assert.equal(host.integration.getIssueContext(previous.id), undefined);
  assert.equal(host.collection.entries.size, 0);
});

test('empty successful scans publish their URI and version and replace previous findings', () => {
  const host = makeHost(makeDocument('<img>'));
  const [previous] = host.run();
  const document = makeDocument('<img alt="">');
  document.version = 2;
  host.api.window.activeTextEditor = { document };
  host.run();
  assert.deepEqual(host.integration.getLatestScan(), {
    fileUri: document.uri.toString(), documentVersion: 2, issues: [],
  });
  assert.equal(host.integration.getIssueContext(previous.id), undefined);
});

test('deactivation disposes scan listeners and clears retained results', () => {
  const host = makeHost(makeDocument('<img>'));
  const [issue] = host.run();
  for (const disposable of host.context.subscriptions) disposable.dispose();
  assert.equal(host.integration.getLatestScan(), undefined);
  assert.equal(host.integration.getIssueContext(issue.id), undefined);
});

function makePresentationHost(document = makeDocument('<img>')) {
  const host = makeHost(document);
  const state = { pickIndex: 0, items: [], navigation: [], documents: new Map(), onPick: undefined, beforeOpen: undefined };
  state.documents.set(document.uri.toString(), document);
  const output = {
    text: '', shown: false, disposed: false,
    replace(text) { this.text = text; },
    clear() { this.text = ''; },
    show() { this.shown = true; },
    dispose() { this.disposed = true; },
  };
  host.api.Uri = { parse: (uri) => makeDocument('', uri).uri };
  host.api.workspace = {
    ...host.api.workspace,
    async openTextDocument(uri) {
      if (state.beforeOpen) await state.beforeOpen();
      const found = state.documents.get(uri.toString());
      if (!found) throw new Error('Document unavailable');
      return found;
    },
  };
  host.api.window.createOutputChannel = (name) => {
    assert.equal(name, 'OPS AODA Issues');
    return output;
  };
  host.api.window.showQuickPick = async (items) => {
    state.items = items;
    if (state.onPick) state.onPick();
    return items[state.pickIndex];
  };
  host.api.window.showTextDocument = async (opened, options) => state.navigation.push({ document: opened, options });
  registerIssuePresentation(host.api, host.context, host.integration);
  return {
    ...host, state, output,
    pick: () => host.commands.get(SHOW_SCAN_ISSUES_COMMAND)(),
    showIssue: (id) => host.commands.get(SHOW_ISSUE_COMMAND)(id),
  };
}

test('issue presentation explains when a scan is needed or has no findings', async () => {
  const host = makePresentationHost(makeDocument('<img alt="">'));
  await host.pick();
  assert.match(host.messages.info.at(-1), /Scan Current Page/);
  host.run();
  await host.pick();
  assert.match(host.messages.info.at(-1), /no confirmed findings/);
  assert.equal(host.state.items.length, 0);
});

test('issue selection navigates to the occurrence and shows catalog guidance', async () => {
  const document = makeDocument('<img><img>', 'file:///demo/Legacy%20Views/contact.cshtml');
  document.version = 4;
  const host = makePresentationHost(document);
  const issues = host.run();
  host.state.pickIndex = 1;
  await host.pick();
  assert.equal(host.state.items[1].issueId, issues[1].id);
  assert.equal(host.state.items[1].description, 'contact.cshtml:1');
  assert.equal(host.state.navigation[0].document, document);
  const selection = host.state.navigation[0].options.selection;
  assert.deepEqual(selection.start, { line: 0, character: 5 });
  assert.deepEqual(selection.end, { line: 0, character: 10 });
  assert.match(host.output.text, /Image Text Alternative/);
  assert.match(host.output.text, /Remediation/);
  assert.match(host.output.text, /Document version: 4/);
  assert.match(host.output.text, /Source at scan time\n<img>$/);
  assert.equal(host.output.shown, true);
});

test('internal issue command accepts occurrence IDs for component-driven navigation', async () => {
  const host = makePresentationHost();
  const [issue] = host.run();
  await host.showIssue(issue.id);
  assert.equal(host.state.navigation.length, 1);
  await host.showIssue('unknown');
  await host.showIssue(undefined);
  assert.equal(host.state.navigation.length, 1);
  assert.match(host.messages.warning.at(-1), /finding is unavailable/);
});

test('cancelling the issue picker has no navigation or detail side effects', async () => {
  const host = makePresentationHost();
  host.run();
  host.state.pickIndex = undefined;
  await host.pick();
  assert.equal(host.state.navigation.length, 0);
  assert.equal(host.output.shown, false);
});

test('document-version changes prevent stale issue presentation', async () => {
  const document = makeDocument('<img>');
  const host = makePresentationHost(document);
  host.run();
  document.version++;
  await host.pick();
  assert.equal(host.state.navigation.length, 0);
  assert.match(host.messages.warning.at(-1), /source or scan has changed/);
});

test('changed source is detected even if a reopened document has the same version', async () => {
  const host = makePresentationHost();
  host.run();
  const replacement = makeDocument('<img alt="Map">');
  host.state.documents.set(replacement.uri.toString(), replacement);
  await host.pick();
  assert.equal(host.state.navigation.length, 0);
  assert.match(host.messages.warning.at(-1), /source or scan has changed/);
});

test('a new scan while the picker is open rejects its old selection', async () => {
  const host = makePresentationHost();
  host.run();
  host.state.onPick = () => host.run();
  await host.pick();
  assert.equal(host.state.navigation.length, 0);
  assert.match(host.messages.warning.at(-1), /scan changed while selecting/);
});

test('a new scan while opening a document rejects stale presentation', async () => {
  const host = makePresentationHost();
  const [issue] = host.run();
  host.state.beforeOpen = () => host.run();
  await host.showIssue(issue.id);
  assert.equal(host.state.navigation.length, 0);
  assert.match(host.messages.warning.at(-1), /source or scan has changed/);
});

test('new scan events clear previously displayed issue details', async () => {
  const host = makePresentationHost();
  host.run();
  await host.pick();
  assert.ok(host.output.text.length > 0);
  host.run();
  assert.equal(host.output.text, '');
});

test('document and picker failures are reported without losing scan results', async () => {
  const host = makePresentationHost();
  const [issue] = host.run();
  host.state.documents.clear();
  await host.showIssue(issue.id);
  assert.match(host.messages.error.at(-1), /could not show this finding/);
  host.api.window.showQuickPick = async () => { throw new Error('Picker unavailable'); };
  await host.pick();
  assert.match(host.messages.error.at(-1), /could not list scan issues/);
  assert.equal(host.integration.getLatestScan().issues.length, 1);
});

test('presentation commands, result subscriptions and output channel are disposed', () => {
  const host = makePresentationHost();
  for (const disposable of host.context.subscriptions) disposable.dispose();
  assert.equal(host.output.disposed, true);
  assert.equal(host.commands.size, 0);
});

test('initial active document is scanned automatically without a command or success notification', (t) => {
  const host = makeHost(makeDocument('<img>'));
  assert.equal(host.integration.getLatestScan(), undefined);
  t.mock.timers.tick(SCAN_DEBOUNCE_MS - 1);
  assert.equal(host.integration.getLatestScan(), undefined);
  t.mock.timers.tick(1);
  assert.equal(host.integration.getLatestScan().issues[0].ruleId, 'image-text-alternative');
  assert.equal(host.messages.info.length, 0);
});

test('rapid typing resets one timer and scans only after the last edit settles', (t) => {
  const host = makeHost(makeDocument('<img>'));
  const completed = [];
  host.integration.onDidChangeScan((snapshot) => { if (snapshot) completed.push(snapshot); });
  host.edit('<img alt="');
  t.mock.timers.tick(150);
  host.edit('<img alt="Map');
  t.mock.timers.tick(150);
  host.edit('<img alt="Map">');
  t.mock.timers.tick(SCAN_DEBOUNCE_MS - 1);
  assert.equal(completed.length, 0);
  t.mock.timers.tick(1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].documentVersion, 4);
  assert.deepEqual(completed[0].issues, []);
  t.mock.timers.tick(5000);
  assert.equal(completed.length, 1);
});

test('editing invalidates stale diagnostics and contexts immediately, then publishes fresh ranges', (t) => {
  const document = makeDocument('<img>');
  const host = makeHost(document);
  const [oldIssue] = host.run();
  const events = [];
  host.integration.onDidChangeScan((snapshot) => events.push(snapshot));
  host.edit('\r\n  <img>\r\n');
  assert.equal(host.integration.getLatestScan(), undefined);
  assert.equal(host.integration.getIssueContext(oldIssue.id), undefined);
  assert.equal(host.collection.entries.size, 0);
  assert.deepEqual(events, [undefined]);
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  const snapshot = host.integration.getLatestScan();
  assert.equal(snapshot.fileUri, document.uri.toString());
  assert.equal(snapshot.documentVersion, 2);
  assert.deepEqual(snapshot.issues[0].range,
    { startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 7 });
  assert.equal(events[1], snapshot);
  assert.equal(host.collection.entries.get(document.uri).length, 1);
});

test('background edits do not replace the active page snapshot', (t) => {
  const host = makeHost(makeDocument('<img>', 'file:///active.html'));
  host.run();
  const snapshot = host.integration.getLatestScan();
  const background = makeDocument('<button></button>', 'file:///background.html');
  host.edit('<button>Save</button>', background);
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(host.integration.getLatestScan(), snapshot);
});

test('non-content editor notifications do not trigger another scan', (t) => {
  const document = makeDocument('<img>');
  const host = makeHost(document);
  host.run();
  const snapshot = host.integration.getLatestScan();
  host.events.edits.fire({ document, contentChanges: [] });
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(host.integration.getLatestScan(), snapshot);
});

test('switching pages cancels the previous timer and scans the new active document', (t) => {
  const first = makeDocument('<img>', 'file:///first.html');
  const second = makeDocument('<button></button>', 'file:///second.cshtml');
  const host = makeHost(first);
  const completed = [];
  host.integration.onDidChangeScan((snapshot) => { if (snapshot) completed.push(snapshot); });
  t.mock.timers.tick(150);
  host.switchTo(second);
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].fileUri, second.uri.toString());
  assert.equal(completed[0].issues[0].ruleId, 'button-name');
  assert.ok(!host.collection.entries.has(first.uri));
});

test('switching to unsupported content or no editor clears the previous page results', (t) => {
  const document = makeDocument('<img>');
  const host = makeHost(document);
  host.run();
  host.switchTo(makeDocument('const x = 1;', 'file:///app.ts'));
  assert.equal(host.integration.getLatestScan(), undefined);
  assert.equal(host.collection.entries.size, 0);
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(host.integration.getLatestScan(), undefined);
  assert.equal(host.messages.warning.length, 0);
  host.switchTo(document);
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(host.integration.getLatestScan().issues.length, 1);
  host.switchTo(undefined);
  assert.equal(host.integration.getLatestScan(), undefined);
});

test('unsupported initial documents and their edits stay idle', (t) => {
  const document = makeDocument('const x = 1;', 'file:///app.ts');
  const host = makeHost(document);
  document.getText = () => { throw new Error('Unsupported content must not be scanned'); };
  host.events.edits.fire({ document, contentChanges: [{ text: 'x' }] });
  t.mock.timers.tick(5000);
  assert.equal(host.integration.getLatestScan(), undefined);
  assert.equal(host.messages.error.length, 0);
});

test('closing a document cancels pending work and clears its existing snapshot', (t) => {
  const document = makeDocument('<img>');
  const host = makeHost(document);
  host.run();
  host.edit('<img src="x">');
  document.isClosed = true;
  host.events.closedDocument.fire(document);
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(host.integration.getLatestScan(), undefined);
  assert.equal(host.collection.entries.size, 0);

  const reopened = makeDocument('<img>', document.uri.toString());
  host.switchTo(reopened);
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(host.integration.getLatestScan().issues.length, 1);
  reopened.isClosed = true;
  host.events.closedDocument.fire(reopened);
  assert.equal(host.integration.getLatestScan(), undefined);
  assert.equal(host.collection.entries.size, 0);
});

test('queued callbacks verify the document is still active and open', (t) => {
  const first = makeDocument('<img>');
  const host = makeHost(first);
  host.api.window.activeTextEditor = { document: makeDocument('<button></button>') };
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(host.integration.getLatestScan(), undefined);
  host.switchTo(first);
  first.isClosed = true;
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(host.integration.getLatestScan(), undefined);
});

test('manual scanning runs immediately and cancels a pending automatic scan', (t) => {
  const host = makeHost(makeDocument('<img>'));
  const completed = [];
  host.integration.onDidChangeScan((snapshot) => { if (snapshot) completed.push(snapshot); });
  host.edit('<img src="x">');
  assert.equal(host.run().length, 1);
  assert.equal(completed.length, 1);
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(completed.length, 1);
  assert.equal(host.messages.info.length, 1);
});

test('an approved-edit consumer can refresh immediately and avoid a duplicate delayed scan', (t) => {
  const host = makeHost(makeDocument('<img>'));
  const [issue] = host.run();
  const completed = [];
  host.integration.onDidChangeScan((snapshot) => { if (snapshot) completed.push(snapshot); });
  // Simulate source changed by an approved edit. Applying edits belongs to its consumer.
  host.edit('<img alt="Office">');
  const refreshed = host.integration.refreshCurrentPage();
  assert.equal(refreshed.documentVersion, 2);
  assert.deepEqual(refreshed.issues, []);
  assert.equal(host.integration.getIssueContext(issue.id), undefined);
  assert.equal(completed.length, 1);
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(completed.length, 1);
  assert.equal(host.messages.info.length, 1);
});

test('immediate refresh handles missing and unsupported active documents', () => {
  const host = makeHost();
  assert.equal(host.integration.refreshCurrentPage(), undefined);
  host.switchTo(makeDocument('', 'file:///app.ts'));
  assert.equal(host.integration.refreshCurrentPage(), undefined);
  assert.equal(host.messages.info.length, 0);
  assert.equal(host.messages.warning.length, 0);
});

test('automatic scan failures are caught once without retrying on a loop', (t) => {
  const document = makeDocument('<img>');
  const host = makeHost(document);
  document.getText = () => { throw new Error('Read failed'); };
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(host.messages.error.length, 1);
  assert.equal(host.integration.getLatestScan(), undefined);
  t.mock.timers.tick(5000);
  assert.equal(host.messages.error.length, 1);
});

test('deactivation cancels pending timers and removes editor listeners', (t) => {
  const host = makeHost(makeDocument('<img>'));
  for (const disposable of host.context.subscriptions) disposable.dispose();
  host.edit('<img src="x">');
  t.mock.timers.tick(5000);
  assert.equal(host.integration.getLatestScan(), undefined);
  assert.equal(host.integration.refreshCurrentPage(), undefined);
  assert.equal(host.events.edits.listeners.size, 0);
  assert.equal(host.events.activeEditor.listeners.size, 0);
  assert.equal(host.events.closedDocument.listeners.size, 0);
});

test('navigating an issue in the same editor retains its snapshot and detail display', async (t) => {
  const document = makeDocument('<img>');
  const host = makePresentationHost(document);
  host.run();
  await host.pick();
  const snapshot = host.integration.getLatestScan();
  const detail = host.output.text;
  host.events.activeEditor.fire({ document });
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(host.integration.getLatestScan(), snapshot);
  assert.equal(host.output.text, detail);
});

test('editing clears displayed details while waiting for updated findings', async () => {
  const host = makePresentationHost();
  host.run();
  await host.pick();
  assert.ok(host.output.text.length > 0);
  host.edit('<img alt="Office">');
  assert.equal(host.output.text, '');
  assert.equal(host.integration.getLatestScan(), undefined);
});
