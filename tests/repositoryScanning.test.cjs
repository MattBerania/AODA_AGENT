const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  discoverSupportedFiles, scanRepositoryFiles, registerRepositoryScanning, SCAN_REPOSITORY_COMMAND,
} = require('../dist/repositoryScanning.js');

function makeHost({ folders = [{ uri: 'file:///demo' }], discover = async () => [],
  open = async (uri) => ({ uri, version: 1, getText: () => '' }) } = {}) {
  const commands = new Map();
  const messages = { info: [], error: [], warning: [] };
  const calls = [];
  const api = {
    workspace: {
      workspaceFolders: folders,
      findFiles(...args) { calls.push(args); return discover(...args); },
      openTextDocument: open,
    },
    window: {
      async showInformationMessage(message) { messages.info.push(message); },
      async showErrorMessage(message) { messages.error.push(message); },
      async showWarningMessage(message) { messages.warning.push(message); },
    },
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose() { commands.delete(id); } };
      },
    },
  };
  const context = { subscriptions: [] };
  registerRepositoryScanning(api, context);
  return { api, context, commands, messages, calls, run: () => commands.get(SCAN_REPOSITORY_COMMAND)() };
}

test('discovery passes workspace-wide patterns and preserves remote URI objects', async () => {
  const files = [{ toString: () => 'vscode-remote://ssh-remote+server/app/PAGE.HTML' }];
  const host = makeHost({ discover: async () => files });
  assert.equal(await discoverSupportedFiles(host.api), files);
  assert.deepEqual(host.calls, [[
    '**/*.{[hH][tT][mM][lL],[cC][sS][hH][tT][mM][lL]}',
    '**/{node_modules,bin,obj,dist,.git,.vs}/**',
  ]]);
});

for (const folders of [undefined, []]) {
  test(`no workspace (${JSON.stringify(folders)}) avoids discovery`, async () => {
    const host = makeHost();
    host.api.workspace.workspaceFolders = folders;
    await host.run();
    assert.equal(host.calls.length, 0);
    assert.deepEqual(host.messages.info, ['Open a workspace folder to discover supported files.']);
  });
}

test('an empty workspace result reports zero files', async () => {
  const host = makeHost();
  await host.run();
  assert.match(host.messages.info[0], /0 files discovered, 0 processed, 0 confirmed findings, 0 failed/);
  assert.deepEqual(host.messages.error, []);
});

test('the command awaits discovery and counts results across workspace roots', async () => {
  let resolveFiles;
  const host = makeHost({
    folders: [{ uri: 'file:///one' }, { uri: 'file:///two' }],
    discover: () => new Promise((resolve) => { resolveFiles = resolve; }),
  });
  const pending = host.run();
  assert.deepEqual(host.messages.info, []);
  resolveFiles([makeUri('file:///one/index.html'), makeUri('file:///two/Views/contact.cshtml')]);
  await pending;
  assert.equal(host.calls.length, 1);
  assert.match(host.messages.info[0], /2 files discovered, 2 processed, 0 confirmed findings, 0 failed/);
});

for (const [error, expected] of [
  [new Error('Search unavailable'), 'Search unavailable'],
  ['unknown failure', 'Unexpected file discovery error.'],
]) {
  test(`discovery failure reports: ${expected}`, async () => {
    const host = makeHost({ discover: async () => { throw error; } });
    await host.run();
    assert.deepEqual(host.messages.info, []);
    assert.deepEqual(host.messages.error, [`OPS AODA could not scan workspace files: ${expected}`]);
  });
}

test('the manifest exposes the command and subscriptions own its cleanup', () => {
  const manifest = require('../package.json');
  assert.ok(manifest.contributes.commands.some((command) => command.command === SCAN_REPOSITORY_COMMAND));
  const host = makeHost();
  assert.equal(host.context.subscriptions.length, 1);
  assert.ok(host.commands.has(SCAN_REPOSITORY_COMMAND));
  host.context.subscriptions[0].dispose();
  assert.equal(host.commands.has(SCAN_REPOSITORY_COMMAND), false);
});

function makeUri(value) {
  return { path: new URL(value).pathname, toString: () => value };
}

test('real detector reads document buffers sequentially and preserves URI, version and UTF-16 ranges', async () => {
  const files = [makeUri('vscode-remote://ssh-remote+server/app/PAGE.HTML'), makeUri('file:///two/page.cshtml')];
  const opened = [];
  let active = 0;
  const host = makeHost({ open: async (uri) => {
    assert.equal(active++, 0);
    opened.push(uri);
    await Promise.resolve();
    active--;
    return { uri, version: 7, isDirty: true, getText: () => '😀\r\n<img>' };
  } });
  const result = await scanRepositoryFiles(host.api, files);
  assert.deepEqual(opened, files);
  assert.deepEqual(result.failures, []);
  for (const [index, snapshot] of result.snapshots.entries()) {
    assert.equal(snapshot.fileUri, files[index].toString());
    assert.equal(snapshot.documentVersion, 7);
    assert.deepEqual(snapshot.issues.map((issue) => issue.ruleId), ['image-text-alternative']);
    assert.equal(snapshot.issues[0].fileUri, snapshot.fileUri);
    assert.deepEqual(snapshot.issues[0].range, {
      startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5,
    });
  }
});

test('open and read failures are isolated while later files still produce findings', async () => {
  const files = ['open', 'read', 'good'].map((name) => makeUri(`file:///demo/${name}.html`));
  const host = makeHost({ discover: async () => files, open: async (uri) => {
    if (uri === files[0]) throw new Error('Permission denied');
    return { uri, version: 1, getText: () => {
      if (uri === files[1]) throw 'read failed';
      return '<img>';
    } };
  } });
  const result = await scanRepositoryFiles(host.api, files);
  assert.equal(result.snapshots.length, 1);
  assert.deepEqual(result.failures, [
    { fileUri: files[0].toString(), message: 'Permission denied' },
    { fileUri: files[1].toString(), message: 'Unexpected file scan error.' },
  ]);
  await host.run();
  assert.match(host.messages.info[0], /3 files discovered, 1 processed, 1 confirmed findings, 2 failed/);
});

test('unsupported Razor is processed without claiming a clean result', async () => {
  const uri = makeUri('file:///demo/page.cshtml');
  const host = makeHost({ discover: async () => [uri], open: async () => ({
    uri, version: 1, getText: () => '@if (true) { <img> }',
  }) });
  await host.run();
  assert.match(host.messages.info[0], /1 processed, 0 confirmed findings, 0 failed/);
  assert.match(host.messages.info[0], /analyzed 0, skipped 1/);
});

test('repository coverage includes emails and Model text but still skips conditionals and loops', async () => {
  const files = ['email.html', 'expressions.cshtml', 'conditional.cshtml', 'loop.cshtml'].map(name => makeUri('file:///demo/' + name));
  const sources = [
    '<p>support@example.com</p>\r\n  <img>',
    readFileSync(join(__dirname, 'fixtures', 'simple-expressions.cshtml'), 'utf8'),
    '@if (Model.Show) { <img> }',
    '@foreach (var item in Model.Items) { <button></button> }',
  ];
  const host = makeHost({ discover: async () => files, open: async uri => ({
    uri, version: 1, getText: () => sources[files.indexOf(uri)],
  }) });
  const result = await scanRepositoryFiles(host.api, files);
  assert.deepEqual(result.outcomes.map(entry => entry.status), ['analyzed', 'analyzed', 'skipped', 'skipped']);
  assert.deepEqual(result.outcomes.map(entry => entry.issues.length), [1, 2, 0, 0]);
  assert.equal(result.failures.length, 0);
  for (const [index, snapshot] of result.snapshots.entries()) {
    const source = sources[index];
    const lines = source.split(/\r\n|\r|\n/);
    for (const issue of snapshot.issues) {
      const [, , start, end] = JSON.parse(issue.id);
      const fromRange = lines[issue.range.startLine].slice(issue.range.startCharacter, issue.range.endCharacter);
      assert.equal(source.slice(start, end), fromRange);
      assert.equal(issue.fileUri, files[index].toString());
    }
  }
  await host.run();
  assert.match(host.messages.info[0], /3 confirmed findings, 0 failed/);
  assert.match(host.messages.info[0], /Files attempted 4, analyzed 2, skipped 2/);
  assert.match(host.messages.warning[0], /conditional.cshtml/);
  assert.match(host.messages.warning[0], /loop.cshtml/);
});

test('mixed outcomes report exact coverage totals and reasons', async () => {
  const files = ['issue.html', 'clean.html', 'skip.cshtml', 'failed.html'].map(name => makeUri('file:///demo/' + name));
  const host = makeHost({ discover: async () => files, open: async uri => {
    if (uri === files[3]) throw new Error('Permission denied');
    return { uri, version: 1, getText: () => uri === files[0] ? '<img>' : uri === files[1] ? '<img alt="">' : '@if (true) { <img> }' };
  } });
  const result = await scanRepositoryFiles(host.api, files);
  assert.deepEqual(result.outcomes.map(entry => entry.status), ['analyzed', 'analyzed', 'skipped', 'failed']);
  assert.equal(result.outcomes.reduce((sum, entry) => sum + entry.issues.length, 0), 1);
  await host.run();
  assert.match(host.messages.info[0], /Files attempted 4, analyzed 2, skipped 1/);
  assert.match(host.messages.info[0], /1 failed/);
  assert.match(host.messages.warning[0], /skip.cshtml/);
  assert.match(host.messages.warning[0], /Permission denied/);
});
