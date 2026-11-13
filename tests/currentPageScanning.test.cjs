const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerCurrentPageScanning, SCAN_CURRENT_PAGE_COMMAND } = require('../dist/currentPageScanning.js');

function makeDocument(source, uriString = 'file:///demo/contact.cshtml') {
  return {
    uri: { path: decodeURIComponent(new URL(uriString).pathname), toString: () => uriString },
    getText: () => source,
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
  const api = {
    Range, Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    window: {
      activeTextEditor: document ? { document } : undefined,
      showInformationMessage(message) { messages.info.push(message); return Promise.resolve(); },
      showWarningMessage(message) { messages.warning.push(message); return Promise.resolve(); },
      showErrorMessage(message) { messages.error.push(message); return Promise.resolve(); },
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
  registerCurrentPageScanning(api, context);
  return {
    api, collection, messages, context, commands,
    run: () => commands.get(SCAN_CURRENT_PAGE_COMMAND)(),
  };
}

test('extension manifest points to the compiled entry point and registered command', () => {
  const manifest = require('../package.json');
  assert.match(manifest.name, /^[a-z0-9][a-z0-9-]*$/);
  assert.match(manifest.publisher, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(manifest.engines.vscode, '^1.95.0');
  assert.equal(manifest.main, './dist/extension.js');
  assert.ok(existsSync(join(__dirname, '..', manifest.main)));
  assert.ok(manifest.contributes.commands.some((command) => command.command === SCAN_CURRENT_PAGE_COMMAND));
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
  assert.equal(host.context.subscriptions.length, 2);
  for (const disposable of host.context.subscriptions) disposable.dispose();
  assert.equal(host.collection.disposed, true);
  assert.equal(host.commands.size, 0);
});
