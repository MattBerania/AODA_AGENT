const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { AGENT_SIDEBAR_VIEW_ID, registerAgentSidebar } = require('../dist/agentSidebar.js');

test('manifest connects the stable sidebar identifiers to a packaged icon and webview', () => {
  const { contributes } = require('../package.json');
  const container = contributes.viewsContainers.activitybar.find(item => item.id === 'opsAoda');
  assert.ok(container);
  assert.equal(container.title, 'OPS AODA Agent');
  assert.ok(existsSync(join(__dirname, '..', container.icon)));
  assert.equal(AGENT_SIDEBAR_VIEW_ID, 'opsAoda.agentSidebar');
  const view = contributes.views[container.id].find(item => item.id === AGENT_SIDEBAR_VIEW_ID);
  assert.ok(view);
  assert.equal(view.type, 'webview');
  assert.equal(view.name, 'OPS AODA Agent');
  assert.equal(view.icon, container.icon);
});

test('sidebar renders a placeholder and disposes with the extension', () => {
  let provider;
  let disposed = false;
  const context = { subscriptions: [] };
  registerAgentSidebar({ window: { registerWebviewViewProvider(id, value) {
    assert.equal(id, AGENT_SIDEBAR_VIEW_ID);
    provider = value;
    return { dispose() { disposed = true; } };
  } } }, context);
  for (let attempt = 0; attempt < 2; attempt++) {
    const view = { webview: {} };
    provider.resolveWebviewView(view);
    assert.match(view.webview.html, /<p>OPS AODA Agent<\/p>/);
    assert.deepEqual(view.webview.options, { enableScripts: false, localResourceRoots: [] });
  }
  assert.equal(context.subscriptions.length, 1);
  context.subscriptions[0].dispose();
  assert.equal(disposed, true);
});
