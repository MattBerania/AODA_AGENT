import { randomUUID } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type * as VSCode from "vscode";
import { INLINE_TEXT_CONTRAST_RULE_ID } from "./accessibility/rules";
import type { ProposedFix, SourceRange } from "./types/accessibility";
import type { IssueContext, ScannerIntegration } from "./types/scannerIntegration";

type Result = { status: "rejected" | "failed" | "applied" | "unverified" | "verified"; message: string };
type Review = { status: "ready"; proposalId: string; replacementText: string; originalText: string };
type Pending = {
  id: string;
  fix: ProposedFix;
  ruleId: string;
  document: VSCode.TextDocument;
};

function checkedRange(api: typeof VSCode, document: VSCode.TextDocument, source: SourceRange) {
  const { startLine, startCharacter, endLine, endCharacter } = source;
  if (![startLine, startCharacter, endLine, endCharacter].every(n => Number.isSafeInteger(n) && n >= 0) ||
      startLine > endLine || (startLine === endLine && startCharacter >= endCharacter)) return;
  const range = new api.Range(startLine, startCharacter, endLine, endCharacter);
  // VS Code normally clamps invalid positions. A proposal must match exactly.
  if (range.isEqual(document.validateRange(range))) return range;
}

function sourceMatches(document: VSCode.TextDocument, fileUri: string, version: number,
  range: VSCode.Range | undefined, original: string): range is VSCode.Range {
  return !document.isClosed && document.uri.toString() === fileUri && document.version === version &&
    !!range && original.length > 0 && document.getText(range) === original;
}

// Fixable structural findings highlight opening tags. A whole element, prose, or extra
// sibling from Copilot cannot safely replace that range.
function isOpeningTagReplacement(original: string, replacement: string): boolean {
  const tag = /^<([a-z][\w-]*)/i.exec(original)?.[1]?.toLowerCase();
  if (!tag || !replacement.startsWith("<") || !replacement.endsWith(">") || replacement === original) return false;
  const closing = tag === "input" || tag === "img" ? "" : `</${tag}>`;
  let malformed = false;
  const tree = parse(replacement + closing, {
    sourceCodeLocationInfo: true,
    onParseError: ({ code }) => { if (code !== "missing-doctype") malformed = true; },
  });
  if (malformed) return false;
  function matches(node: DefaultTreeAdapterMap["node"]): boolean {
    if ("tagName" in node && node.tagName === tag) {
      const location = node.sourceCodeLocation?.startTag;
      if (location?.startOffset === 0 && location.endOffset === replacement.length) return true;
    }
    return "childNodes" in node && node.childNodes.some(matches);
  }
  return matches(tree);
}
function isHexColorReplacement(original: string, replacement: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(replacement) &&
    replacement.toLowerCase() !== original.toLowerCase();
}

/** One review slot per panel. Only its opaque identifier crosses back on approval. */
export function createFixProposals(api: typeof VSCode, scanner: ScannerIntegration,
  generateFix: (context: IssueContext) => Promise<string | null>) {
  let generation: symbol | undefined;
  let pending: Pending | undefined;

  function clear(): void {
    pending = undefined;
    generation = undefined;
  }

  async function generate(issueId: unknown, version: unknown): Promise<Review | Result | undefined> {
    clear();
    const request = Symbol();
    generation = request;
    const context = typeof issueId === "string" ? scanner.getIssueContext(issueId) : undefined;
    if (!context || context.documentVersion !== version) {
      return { status: "rejected", message: "The selected finding is outdated. Select it from a fresh scan." };
    }
    const { issue, documentVersion, originalText } = context;
    const stale = { status: "rejected", message: "The source changed. Review a fresh scan." } as const;
    try {
      const document = await api.workspace.openTextDocument(api.Uri.parse(issue.fileUri));
      if (generation !== request) return;
      const range = checkedRange(api, document, issue.range);
      if (!sourceMatches(document, issue.fileUri, documentVersion, range, originalText)) return stale;

      const reply = await generateFix(context);
      if (generation !== request) return;
      if (!sourceMatches(document, issue.fileUri, documentVersion, range, originalText)) return stale;
      if (!reply) return { status: "failed", message: "Copilot returned no suggestion. Check Copilot and reopen the finding to retry." };
      const eol = document.eol === api.EndOfLine.CRLF ? "\r\n" : "\n";
      const replacementText = reply.replace(/\r\n|\r|\n/g, eol);
      const isContrast = issue.ruleId === INLINE_TEXT_CONTRAST_RULE_ID;
      const isValid = isContrast
        ? isHexColorReplacement(originalText, replacementText)
        : isOpeningTagReplacement(originalText, replacementText);
      if (!isValid) {
        return {
          status: "rejected",
          message: isContrast
            ? "Copilot must suggest a different 3- or 6-digit hex colour (e.g. #595959). Reopen the finding to retry."
            : "Copilot must suggest a changed opening tag for this element. Reopen the finding to retry."
        };
      }
      const id = randomUUID();
      const fix: ProposedFix = { issueId: issue.id, fileUri: issue.fileUri, range: issue.range,
        documentVersion, originalText, replacementText, explanation: issue.message };
      pending = { id, fix, ruleId: issue.ruleId, document };
      return { status: "ready", proposalId: id, originalText, replacementText };
    } catch {
      if (generation === request) return { status: "failed", message: "Could not prepare the Copilot proposal. Review a fresh scan." };
    }
  }

  async function approve(id: unknown): Promise<Result> {
    if (!pending || pending.id !== id) {
      return { status: "rejected", message: "This proposal is unavailable or has already been used." };
    }
    const { fix, document, ruleId } = pending;
    clear(); // Consume before any asynchronous operation, including applyEdit.
    let expected: string;
    try {
      const range = checkedRange(api, document, fix.range);
      if (!sourceMatches(document, fix.fileUri, fix.documentVersion, range, fix.originalText) ||
          !scanner.getIssueContext(fix.issueId)) {
        return { status: "rejected", message: "The target or finding changed. Review a fresh scan." };
      }
      const before = document.getText();
      expected = before.slice(0, document.offsetAt(range.start)) + fix.replacementText +
        before.slice(document.offsetAt(range.end));
      const edit = new api.WorkspaceEdit();
      edit.replace(document.uri, range, fix.replacementText);
      if (!await api.workspace.applyEdit(edit)) {
        return { status: "failed", message: "VS Code declined the edit. Review a fresh proposal." };
      }
    } catch {
      return { status: "failed", message: "VS Code could not apply the edit. Review the target document." };
    }

    const unverified = { status: "unverified",
      message: "VS Code accepted the edit, but the approved result could not be confirmed in the target buffer." } as const;
    let editConfirmed = false;
    try {
      editConfirmed = !document.isClosed && document.uri.toString() === fix.fileUri && document.getText() === expected;
    } catch {
      // Still attempt the target scan when reading back the edit fails.
    }
    try {
      const scan = scanner.refreshDocument(document);
      if (!editConfirmed) return unverified;
      if (!scan || scan.fileUri !== fix.fileUri || scan.documentVersion !== document.version) {
        return { status: "applied", message: "Edit applied. A current scan of the target is unavailable." };
      }
      if (scan.status !== "analyzed") {
        return { status: "applied", message: `Edit applied. Target scan ${scan.status}. ${scan.reason}` };
      }
      // The end of an opening tag (and hence the occurrence ID) can move.
      const remains = scan.issues.some(issue => issue.ruleId === ruleId &&
        issue.range.startLine === fix.range.startLine && issue.range.startCharacter === fix.range.startCharacter);
      return remains
        ? { status: "applied", message: "Edit applied. The target scan still reports this finding." }
        : { status: "verified", message: "Edit verified. The target scan no longer reports this finding." };
    } catch {
      return editConfirmed
        ? { status: "applied", message: "Edit applied. The target scan failed." }
        : unverified;
    }
  }

  return { generate, approve, clear };
}
