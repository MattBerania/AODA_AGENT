const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { registerAgentUI, OPEN_AGENT_UI_COMMAND } = require('../dist/agentUI.js');
const { SCAN_DEBOUNCE_MS } = require('../dist/currentPageScanning.js');
const { registerRepositoryScanning } = require('../dist/repositoryScanning.js');
const { makeDocument, makeHost } = require('./helpers/scanHost.cjs');

// Exercise the registered webview message handlers, scanner, and scan store.
// Only VS Code's document/edit APIs, panel transport and Copilot are simulated.
function setup(t, source = '<img>', suggestion = '<img alt="Office">', fileUri) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = makeDocument(source, fileUri);
  const host = makeHost(document, true);
  const { api, context } = host;
  const [issue] = host.run();
  const requests = [];
  const messages = [];
  const edits = [];
  let receive;
  let dispose;
  const selections = new api.EventEmitter();
  const panel = {
    reveal() {},
    webview: {
      asWebviewUri: uri => uri,
      postMessage: msg => { messages.push(msg); },
      onDidReceiveMessage: listener => { receive = listener; },
    },
    onDidDispose: listener => { dispose = listener; },
  };
  api.window.createWebviewPanel = () => panel;
  api.window.onDidChangeTextEditorSelection = selections.event;
  api.TextEditorSelectionChangeKind = { Mouse: 2 };
  api.Uri.file = path => ({ toString: () => path });
  api.ViewColumn = { Beside: 2 };
  api.workspace.openTextDocument = async () => document;
  api.WorkspaceEdit = class {
    replace(uri, range, text) { Object.assign(this, { uri, range, text }); }
  };
  api.workspace.applyEdit = async edit => {
    assert.equal(edit.uri.toString(), document.uri.toString());
    edits.push(edit);
    const before = document.getText();
    host.edit(before.slice(0, document.offsetAt(edit.range.start)) + edit.text +
      before.slice(document.offsetAt(edit.range.end)), document);
    return true;
  };
  api.lm = { selectChatModels: async () => [{
    async sendRequest(prompt) {
      requests.push(prompt);
      return { text: [await (typeof suggestion === 'function' ? suggestion() : suggestion)] };
    },
  }] };
  api.LanguageModelChatMessage = { User: text => text };
  api.CancellationTokenSource = class { dispose() {} };
  context.extensionPath = join(__dirname, '..');
  registerAgentUI(api, context, host.integration);
  host.commands.get(OPEN_AGENT_UI_COMMAND)();
  t.after(() => { dispose(); for (const sub of context.subscriptions) sub.dispose(); });
  async function send(command) {
    await receive(command);
    return messages.at(-1);
  }
  const generate = (requestId = 'request', extra = {}) => send({
    command: 'generateFix', issueId: issue.id, documentVersion: 1, requestId, ...extra,
  });
  const approve = (proposalId, extra = {}) => send({ command: 'applyFix', proposalId, ...extra });
  return { ...host, document, issue, requests, messages, edits, send, generate, approve, selections,
    dispose: () => dispose() };
}

test('review and apply exactly the host proposal, including CRLF and UTF-16 offsets', async t => {
  const source = '😀\r\n  <img src="@Model.Logo"> tail <img>';
  const replacement = '<img src="@Model.Logo"\n    alt="Office">';
  const host = setup(t, source, '```html\n' + replacement + '\n```');
  const review = await host.generate('review-1', { context: { originalText: 'untrusted text' } });
  assert.equal(review.status, 'ready');
  assert.equal(review.originalText, '<img src="@Model.Logo">');
  assert.equal(review.replacementText, replacement.replace('\n', '\r\n'));
  assert.equal(review.requestId, 'review-1');
  assert.equal(host.edits.length, 0);
  assert.doesNotMatch(host.requests[0][0], /untrusted text/);
  const result = await host.approve(review.proposalId);
  assert.equal(result.status, 'verified');
  assert.equal(result.proposalId, review.proposalId);
  assert.equal(host.document.getText(), source.replace(review.originalText, review.replacementText));
  assert.equal(host.edits.length, 1);
  assert.equal(host.integration.getLatestScan().issues.length, 1); // another img remains
  assert.equal(host.integration.getLatestScan().documentVersion, 2);
});

for (const [caseName, change] of [
  ['document version changed outside the selected range', h => h.edit('<img> extra')],
  ['new document version before scan invalidation', h => { h.document.version++; }],
  ['incorrect URI', h => { h.document.uri = makeDocument('', 'file:///wrong.html').uri; }],
  ['incorrect original text at the same version', h => { h.document.getText = makeDocument('<IMG>').getText; }],
  ['closed document even with matching version and source', h => { h.document.isClosed = true; }],
  ['range that VS Code would clamp', h => { h.document.validateRange = () => new h.api.Range(0, 0, 0, 4); }],
]) {
  test('approval rejects ' + caseName, async t => {
    const host = setup(t);
    const review = await host.generate();
    assert.equal(review.status, 'ready');
    change(host);
    const before = host.document.getText();
    assert.equal((await host.approve(review.proposalId)).status, 'rejected');
    assert.equal(host.document.getText(), before);
    assert.equal(host.edits.length, 0);
  });
}

test('approval rejects unknown IDs and webview-supplied edits', async t => {
  const host = setup(t);
  const review = await host.generate();
  assert.equal((await host.approve('unknown')).status, 'rejected');
  assert.equal((await host.approve(review.proposalId, { fileUri: 'file:///other.html', fixCode: '<p>' })).status, 'rejected');
  assert.equal(host.edits.length, 0);
  assert.equal((await host.approve(review.proposalId)).status, 'verified');
});

test('older Copilot completion for the same finding cannot replace the latest review', async t => {
  const started = Promise.withResolvers();
  const older = Promise.withResolvers();
  let count = 0;
  const host = setup(t, '<img>', () => {
    if (++count === 1) { started.resolve(); return older.promise; }
    return '<img alt="Second">';
  });
  const slow = host.generate('older');
  await started.promise;
  const review = await host.generate('newer');
  older.resolve('<img alt="First">');
  await slow;
  assert.deepEqual(host.messages.filter(m => m.type === 'FIX_RESPONSE').map(m => m.requestId), ['newer']);
  assert.equal((await host.approve(review.proposalId)).status, 'verified');
  assert.equal(host.document.getText(), '<img alt="Second">');
});

test('a newer review or dismissal invalidates an already displayed approval ID', async t => {
  const host = setup(t);
  const first = await host.generate('first');
  const second = await host.generate('second');
  assert.notEqual(first.proposalId, second.proposalId);
  assert.equal((await host.approve(first.proposalId)).status, 'rejected');
  await host.send({ command: 'dismissFix' });
  assert.equal((await host.approve(second.proposalId)).status, 'rejected');
  assert.equal(host.edits.length, 0);
});

test('double approval while WorkspaceEdit is in flight submits exactly once', async t => {
  const host = setup(t);
  const review = await host.generate();
  const gate = Promise.withResolvers();
  const apply = host.api.workspace.applyEdit;
  let attempts = 0;
  host.api.workspace.applyEdit = async edit => { attempts++; await gate.promise; return apply(edit); };
  const first = host.approve(review.proposalId);
  assert.equal((await host.approve(review.proposalId)).status, 'rejected');
  gate.resolve();
  assert.equal((await first).status, 'verified');
  assert.equal((await host.approve(review.proposalId)).status, 'rejected');
  assert.equal(attempts, 1);
});

test('apply after switching editors rescans the target and preserves the other pending scan', async t => {
  const host = setup(t);
  const review = await host.generate();
  const other = makeDocument('<button></button>', 'file:///other.html');
  host.switchTo(other);
  assert.equal((await host.approve(review.proposalId)).status, 'verified');
  assert.equal(other.getText(), '<button></button>');
  assert.equal(host.document.getText(), '<img alt="Office">');
  assert.deepEqual(host.results.getSnapshot(host.document.uri.toString()).issues, []);
  assert.equal(host.integration.getLatestScan(), undefined);
  t.mock.timers.tick(SCAN_DEBOUNCE_MS);
  assert.equal(host.integration.getLatestScan().fileUri, other.uri.toString());
  assert.equal(host.integration.getLatestScan().issues[0].ruleId, 'button-name');
});

for (const [name, apply] of [
  ['declined', () => false],
  ['thrown', () => { throw Error('write failed'); }],
]) {
  test('failed WorkspaceEdit (' + name + ') is reported and cannot be replayed', async t => {
    const host = setup(t);
    const review = await host.generate();
    host.api.workspace.applyEdit = apply;
    assert.equal((await host.approve(review.proposalId)).status, 'failed');
    assert.equal((await host.approve(review.proposalId)).status, 'rejected');
    assert.equal(host.document.getText(), '<img>');
  });
}

test('acknowledged WorkspaceEdit with unexpected buffer contents is unverified and still rescanned', async t => {
  const host = setup(t);
  const review = await host.generate();
  host.api.workspace.applyEdit = () => { host.edit('<img alt="different">'); return true; };
  assert.equal((await host.approve(review.proposalId)).status, 'unverified');
  assert.equal(host.integration.getLatestScan().documentVersion, 2);
});

test('skipped Razor scan reports its reason after confirming the edit', async t => {
  const host = setup(t, '<img>', '<img alt="@GetName()">');
  const review = await host.generate();
  const result = await host.approve(review.proposalId);
  assert.equal(result.status, 'applied');
  assert.match(result.message, /skipped.*Unsupported Razor/);
  assert.equal(host.integration.getLatestScan().status, 'skipped');
});

for (const [name, refresh, explanation] of [
  ['failed', d => ({ fileUri: d.uri.toString(), documentVersion: d.version, status: 'failed', reason: 'read failed' }), /read failed/],
  ['unavailable', () => undefined, /unavailable/],
  ['wrong URI', d => ({ fileUri: 'file:///other.html', documentVersion: d.version, status: 'analyzed', issues: [] }), /unavailable/],
  ['exception', () => { throw Error(); }, /scan failed/],
]) {
  test('post-edit scan ' + name + ' preserves the confirmed applied state', async t => {
    const host = setup(t);
    const review = await host.generate();
    host.integration.refreshDocument = refresh;
    const result = await host.approve(review.proposalId);
    assert.equal(result.status, 'applied');
    assert.match(result.message, explanation);
    assert.equal(host.edits.length, 1);
  });
}

test('a changed occurrence ID cannot hide a persistent finding', async t => {
  const host = setup(t, '<img>', '<img class="logo">');
  const result = await host.approve((await host.generate()).proposalId);
  assert.equal(result.status, 'applied');
  assert.match(result.message, /still reports/);
  assert.notEqual(host.integration.getLatestScan().issues[0].id, host.issue.id);
});

for (const reply of ['plain explanation', '<img>', '<img><p>', '<img alt="x"></img>', '<button>', '<img alt="x" alt="y">']) {
  test('invalid Copilot replacement is never offered: ' + reply, async t => {
    const host = setup(t, '<img>', reply);
    const result = await host.generate();
    assert.equal(result.status, 'rejected');
    assert.equal(result.proposalId, undefined);
    assert.equal(host.edits.length, 0);
  });
}

test('unavailable Copilot yields an explicit failure without a template proposal', async t => {
  const host = setup(t);
  host.api.lm.selectChatModels = async () => [];
  const result = await host.generate();
  assert.equal(result.status, 'failed');
  assert.match(result.message, /Copilot/);
  assert.equal(result.proposalId, undefined);
  assert.equal(host.edits.length, 0);
});

test('a scan result for the wrong URI cannot supply a host proposal context', t => {
  const host = setup(t);
  const other = makeDocument('<img>', 'file:///other.html');
  assert.throws(() => host.results.set(other, [host.issue]), /URI does not match/);
  assert.equal(host.results.getSnapshot(other.uri.toString()), undefined);
  assert.equal(host.results.getIssueContext(host.issue.id).issue.fileUri, host.document.uri.toString());
});

test('inline contrast publishes a foreground-token warning for manual review', async t => {
  const host = setup(t, '<p style="color:#aaa; background-color:#fff">Notice</p>', undefined,
    'file:///demo/contrast.html');
  const [diagnostic] = host.collection.entries.get(host.document.uri);
  assert.equal(diagnostic.severity, host.api.DiagnosticSeverity.Warning);
  assert.equal(host.document.getText(diagnostic.range), '#aaa');
  assert.equal(host.integration.getIssueContext(host.issue.id).originalText, '#aaa');
  const result = await host.generate();
  assert.equal(result.status, 'rejected');
  assert.match(result.message, /manual review/);
  assert.equal(host.requests.length, 0);
  assert.equal(host.edits.length, 0);
});

test('Agent displays structural findings while contrast stays in the scan and Problems', t => {
  const host = setup(t, '<p style="color:#aaa; background-color:#fff">Notice</p><img>',
    undefined, 'file:///demo/contrast.html');
  const issues = host.integration.getLatestScan().issues;
  assert.deepEqual(issues.map(issue => issue.ruleId), ['inline-text-contrast', 'image-text-alternative']);
  assert.equal(host.collection.entries.get(host.document.uri).length, 2);

  t.mock.timers.tick(300);
  const sidebar = host.messages.find(message => message.type === 'SCAN_RESULTS');
  assert.deepEqual(sidebar.payload.map(context => context.issue.ruleId), ['image-text-alternative']);

  for (const issue of issues) {
    host.selections.fire({
      kind: host.api.TextEditorSelectionChangeKind.Mouse,
      textEditor: host.api.window.activeTextEditor,
      selections: [{ active: { line: issue.range.startLine, character: issue.range.startCharacter } }],
    });
    t.mock.timers.tick(1);
  }
  assert.deepEqual(host.messages.filter(message => message.type === 'SELECT_ISSUE')
    .map(message => message.payload.issue.ruleId), ['image-text-alternative']);
});

test('repository sidebar uses shared findings and versioned proposals from another file', async t => {
  const host = setup(t);
  const background = makeDocument('<p style="color:#aaa; background-color:#fff">Notice</p><img>',
    'file:///demo/views/notice.html');
  background.version = 4;
  const { api, context, commands, results } = host;
  api.workspace.workspaceFolders = [{ name: 'demo' }];
  api.workspace.findFiles = async () => [background.uri];
  api.workspace.getWorkspaceFolder = () => api.workspace.workspaceFolders[0];
  api.workspace.asRelativePath = () => 'views/notice.html';
  api.workspace.openTextDocument = async () => background;
  api.commands.executeCommand = async (command, ...args) => commands.get(command)(...args);
  registerRepositoryScanning(api, context, results);

  const sidebar = await host.send({ command: 'scanRepository' });
  assert.equal(sidebar.type, 'REPO_SCAN_RESULTS');
  assert.equal(sidebar.payload.length, 1);
  const [entry] = sidebar.payload;
  assert.equal(entry.issue.ruleId, 'image-text-alternative');
  assert.equal(entry.documentVersion, background.version);
  assert.equal(entry.originalText, '<img>');
  assert.equal(entry.folderPath, 'demo/views');
  assert.equal(entry.fileName, 'notice.html');
  assert.deepEqual(results.getSnapshot(background.uri.toString()).issues.map(issue => issue.ruleId),
    ['inline-text-contrast', 'image-text-alternative']);
  t.mock.timers.tick(300);
  assert.equal(host.messages.at(-1), sidebar);

  const review = await host.generate('repository-review', {
    issueId: entry.issue.id, documentVersion: entry.documentVersion,
  });
  assert.equal(review.status, 'ready');
});

test('webview reviews the current reply and sends only the reviewed ID on Apply', async t => {
  const host = setup(t);
  const outbound = [];
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) {
      const listeners = {};
      elements.set(selector, {
        classList: { add() {}, remove() {} }, setAttribute() {},
        appendChild(child) { return child; },
        addEventListener: (name, callback) => { listeners[name] = callback; },
        click: () => listeners.click(),
      });
    }
    return elements.get(selector);
  }
  const webDocument = {
    addEventListener: (_, callback) => callback(),
    querySelector: element,
    getElementById: id => element('#' + id),
  };
  let deliver;
  const webWindow = { addEventListener: (_, callback) => { deliver = data => callback({ data }); } };
  const script = require('node:fs').readFileSync(join(__dirname, '../prototype/JS/AODA_Agent.js'), 'utf8');
  require('node:vm').runInNewContext(script, {
    document: webDocument, window: webWindow, crypto: require('node:crypto'),
    acquireVsCodeApi: () => ({ postMessage: message => outbound.push({ ...message }) }),
  });

  assert.deepEqual(outbound.shift(), { command: 'getChatHistory' });

  const selection = { type: 'SELECT_ISSUE', payload: host.integration.getIssueContext(host.issue.id) };
  deliver(selection);
  const older = await host.send(outbound.pop());
  deliver(selection);
  const newer = await host.send(outbound.pop());
  deliver(newer);
  deliver(older);
  assert.match(element('.code-diff-viewer').innerHTML, /Apply fix/);
  assert.match(element('.code-diff-viewer').innerHTML, /&lt;img alt=&quot;Office&quot;&gt;/);
  assert.equal(host.edits.length, 0);
  element('#applyFixBtn').click();
  element('#applyFixBtn').click();
  assert.deepEqual(outbound, [{ command: 'applyFix', proposalId: newer.proposalId }]);
  deliver(await host.send(outbound.pop()));
  assert.equal(element('#applyFixBtn').textContent, 'Verified');
  assert.match(element('.fix-status').textContent, /no longer reports this finding/);
});

for (const [source, replacement] of [
  ['<html></html>', '<html lang="fr">'],
  ['<button></button>', '<button aria-label="Save">'],
  ['<a href="/"></a>', '<a href="/" aria-label="Home">'],
  ['<iframe></iframe>', '<iframe title="Office map">'],
  ['<input>', '<input aria-label="Phone">'],
  ['<select></select>', '<select aria-label="City">'],
  ['<textarea></textarea>', '<textarea aria-label="Message">'],
]) {
  test('apply keeps the existing content and closing markup for ' + source, async t => {
    const host = setup(t, source, replacement);
    const review = await host.generate();
    assert.equal(review.status, 'ready');
    assert.equal((await host.approve(review.proposalId)).status, 'verified');
    assert.equal(host.document.getText(), source.replace(review.originalText, replacement));
  });
}
