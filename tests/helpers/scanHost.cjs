const assert = require('node:assert/strict');
const { registerCurrentPageScanning, SCAN_CURRENT_PAGE_COMMAND } = require('../../dist/currentPageScanning.js');
const { registerWorkspaceScanResults } = require('../../dist/scanResults.js');

function makeDocument(source, uriString = 'file:///demo/contact.cshtml') {
  return {
    uri: { path: decodeURIComponent(new URL(uriString).pathname), toString: () => uriString },
    version: 1,
    eol: source.includes('\r\n') ? 2 : 1,
    validateRange(range) {
      const lines = this.getText().split(/\r\n|\r|\n/);
      const clamp = ({ line, character }) => {
        if (line >= lines.length) return { line: lines.length - 1, character: lines.at(-1).length };
        return { line, character: Math.min(character, lines[line].length) };
      };
      return { start: clamp(range.start), end: clamp(range.end) };
    },
    offsetAt({ line, character }) {
      const lines = this.getText().split(/(?<=\n)/);
      return lines.slice(0, line).join('').length + character;
    },
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
function makeHost(document, sharedResults = false) {
  const commands = new Map();
  const messages = { info: [], warning: [], error: [] };
  const collection = {
    entries: new Map(), disposed: false,
    clear() { this.entries.clear(); },
    delete(uri) {
      for (const key of this.entries.keys()) {
        if (key.toString() === uri.toString()) this.entries.delete(key);
      }
    },
    set(uri, diagnostics) { this.entries.set(uri, diagnostics); },
    dispose() { this.disposed = true; this.entries.clear(); },
  };
  class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
    isEqual(other) {
      return this.start.line === other.start.line && this.start.character === other.start.character &&
        this.end.line === other.end.line && this.end.character === other.end.character;
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
    Uri: { parse: (value) => ({ path: new URL(value).pathname, toString: () => value }) },
    Range, Diagnostic, EventEmitter, EndOfLine: { LF: 1, CRLF: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    window: {
      activeTextEditor: document ? { document } : undefined,
      visibleTextEditors: [],
      onDidChangeActiveTextEditor: events.activeEditor.event,
      showInformationMessage(message) { messages.info.push(message); return Promise.resolve(); },
      showWarningMessage(message) { messages.warning.push(message); return Promise.resolve(); },
      showErrorMessage(message) { messages.error.push(message); return Promise.resolve(); },
    },
    workspace: {
      onDidDeleteFiles: new EventEmitter().event,
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
      executeCommand: async () => undefined,
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose() { commands.delete(id); } };
      },
    },
  };
  const context = { subscriptions: [] };
  const results = sharedResults ? registerWorkspaceScanResults(api, context) : undefined;
  const integration = registerCurrentPageScanning(api, context, results);
  return {
    api, collection, messages, context, commands, integration, events, results,
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

module.exports = { makeDocument, makeHost };
