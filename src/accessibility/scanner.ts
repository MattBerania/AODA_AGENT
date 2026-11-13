import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { AccessibilityIssue } from "../types/accessibility";
import { getRule } from "./rules";
import { maskRazorDirectives } from "./razor";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

/** Collect source-backed elements; template contents are inert and excluded. */
function elements(root: Node): Element[] {
  const result: Element[] = [];
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if ("tagName" in node) result.push(node);
    if ("childNodes" in node) {
      for (const child of node.childNodes) pending.push(child);
    }
  }
  return result;
}

/**
 * This is a Razor safety gate, not a Razor parser. Only a complete, quoted
 * @identifier.property value is supported. Anything else containing @ causes
 * the entire file to be skipped, including unmasked directives, helpers and comments.
 * Removing accepted attribute spans here never changes the parsed source.
 */
function hasUnsupportedRazor(source: string, nodes: Element[]): boolean {
  if (!source.includes("@")) return false;
  const spans: { start: number; end: number }[] = [];
  for (const node of nodes) {
    for (const location of Object.values(node.sourceCodeLocation?.attrs ?? {})) {
      const attribute = source.slice(location.startOffset, location.endOffset);
      if (/^[^\s=]+\s*=\s*(["'])@[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\1$/.test(attribute)) {
        spans.push({ start: location.startOffset, end: location.endOffset });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let end = 0;
  for (const span of spans) {
    if (source.slice(end, span.start).includes("@")) return true;
    end = span.end;
  }
  return source.slice(end).includes("@");
}

function isExcluded(node: Element): boolean {
  let current: Node | null = node;
  while (current && "tagName" in current) {
    if (current.attrs.some(({ name, value }) =>
      name === "hidden" ||
      (name === "aria-hidden" && value.trim().toLowerCase() === "true") ||
      name === "runat" || name.startsWith("asp-"),
    )) return true;
    current = current.parentNode;
  }
  return node.attrs.some(({ name, value }) =>
    name === "role" && /^(none|presentation)$/i.test(value.trim()),
  );
}

/**
 * First MVP detector: native HTML images missing a recognized text alternative.
 * Empty results mean no confirmed finding in the supported subset, not compliance.
 * Positions refer to the original source using UTF-16 editor coordinates.
 */
export function scanAccessibility(source: string, fileUri: string): AccessibilityIssue[] {
  // Mask only Razor files. The copy has the original length and line endings,
  // so parser locations and occurrence IDs still refer to the original source.
  const analysisSource = /\.cshtml(?:[?#]|$)/i.test(fileUri)
    ? maskRazorDirectives(source)
    : source;
  let malformed = false;
  const document = parse(analysisSource, {
    sourceCodeLocationInfo: true,
    onParseError: ({ code }) => {
      if (code !== "missing-doctype") malformed = true;
    },
  });
  const nodes = elements(document);
  if (malformed || hasUnsupportedRazor(analysisSource, nodes)) return [];

  const rule = getRule("image-text-alternative");
  if (!rule) throw new Error("Missing image-text-alternative rule metadata");
  const issues: AccessibilityIssue[] = [];
  const seen = new Set<number>();
  for (const node of nodes) {
    if (node.tagName !== "img" || node.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
    const location = node.sourceCodeLocation?.startTag;
    if (!location || seen.has(location.startOffset) || isExcluded(node)) continue;
    // Attribute presence suffices for alt: alt="" can mean decorative.
    // ARIA references and dynamic values are acknowledged, not runtime-validated.
    const named = node.attrs.some(({ name, value }) =>
      name === "alt" ||
      (["aria-label", "aria-labelledby", "title"].includes(name) && value.trim() !== ""),
    );
    if (named) continue;
    seen.add(location.startOffset);
    issues.push({
      id: JSON.stringify([fileUri, rule.id, location.startOffset, location.endOffset]),
      ruleId: rule.id,
      title: rule.title,
      message: "Image has no recognized text alternative. " + rule.remediation,
      fileUri,
      range: {
        startLine: location.startLine - 1,
        startCharacter: location.startCol - 1,
        endLine: location.endLine - 1,
        endCharacter: location.endCol - 1,
      },
      category: rule.category,
      severity: rule.severity,
      wcagCriteria: rule.wcagCriteria,
    });
  }
  // Stack traversal and HTML tree correction need not preserve source order.
  return issues.sort((a, b) => a.range.startLine - b.range.startLine ||
    a.range.startCharacter - b.range.startCharacter);
}
