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

test('sidebar registers exactly the supplied agent provider with retained context', () => {
  const provider = { resolveWebviewView() {} };
  const context = { subscriptions: [] };
  let disposed = false;
  let calls = 0;
  registerAgentSidebar({ window: { registerWebviewViewProvider(id, actual, options) {
    calls++;
    assert.equal(id, AGENT_SIDEBAR_VIEW_ID);
    assert.equal(actual, provider);
    assert.equal(options.webviewOptions.retainContextWhenHidden, true);
    return { dispose() { disposed = true; } };
  } } }, context, provider);
  assert.equal(calls, 1);
  context.subscriptions[0].dispose();
  assert.equal(disposed, true);
});
