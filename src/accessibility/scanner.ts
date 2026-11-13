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

function isExcluded(node: Element, includePresentationRole = true): boolean {
  let current: Node | null = node;
  while (current && "tagName" in current) {
    if (current.attrs.some(({ name, value }) =>
      name === "hidden" ||
      (name === "aria-hidden" && value.trim().toLowerCase() === "true") ||
      name === "runat" || name.startsWith("asp-"),
    )) return true;
    current = current.parentNode;
  }
  return includePresentationRole && node.attrs.some(({ name, value }) =>
    name === "role" && /^(none|presentation)$/i.test(value.trim()),
  );
}

function hasNamingAttribute(node: Element): boolean {
  return node.attrs.some(({ name, value }) =>
    ["aria-label", "aria-labelledby", "title"].includes(name) && value.trim() !== "",
  );
}

/** True means recognized naming OR uncertainty: neither warrants an error. */
function buttonMayHaveName(button: Element, nodes: Element[]): boolean {
  if (hasNamingAttribute(button)) return true;
  // HTML buttons are labelable. Defer label-content validation for this increment.
  const id = button.attrs.find(({ name }) => name === "id")?.value;
  if (id && nodes.some((node) => node.tagName === "label" &&
    node.attrs.some(({ name, value }) => name === "for" && value === id))) return true;
  let parent = button.parentNode;
  while (parent && "tagName" in parent) {
    if (parent.tagName === "label") return true;
    parent = parent.parentNode;
  }

  // An unclosed button or changed/dynamic semantics is outside this subset.
  if (!button.sourceCodeLocation?.endTag || button.attrs.some(({ name }) => name === "role")) return true;
  const pending: Node[] = [button];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if ("value" in node && node.value.trim() !== "") return true;
    if (!("tagName" in node)) continue;
    if (["script", "style", "template"].includes(node.tagName)) continue;
    // Tag Helpers/server controls and dynamic attributes may generate names or
    // alter visibility. They are uncertain, not confirmed empty content.
    if (node.attrs.some(({ name, value }) =>
      name === "runat" || name.startsWith("asp-") || value.includes("@"),
    )) return true;
    // Presentation roles remove semantics, not the text of a nested span.
    if (isExcluded(node, false)) continue;
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || node.tagName.includes("-")) return true;
    if (["input", "select", "textarea", "object", "iframe", "canvas", "audio", "video"].includes(node.tagName)) return true;
    if (node.tagName === "img" && isExcluded(node)) continue;
    if (node !== button && hasNamingAttribute(node)) return true;
    if (node.tagName === "img") {
      const alt = node.attrs.find(({ name }) => name === "alt");
      // Missing alt has possible filename fallback; the image rule handles it.
      if (!alt || alt.value.trim() !== "") return true;
      continue;
    }
    for (const child of node.childNodes) pending.push(child);
  }
  return false;
}

/**
 * MVP detectors: native HTML images and buttons missing recognized alternatives.
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

  const issues: AccessibilityIssue[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!["img", "button"].includes(node.tagName) || node.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
    const location = node.sourceCodeLocation?.startTag;
    if (!location || isExcluded(node)) continue;
    let ruleId: string;
    let message: string;
    if (node.tagName === "img") {
      // Presence suffices for alt: alt="" can mean decorative.
      if (node.attrs.some(({ name }) => name === "alt") || hasNamingAttribute(node)) continue;
      ruleId = "image-text-alternative";
      message = "Image has no recognized text alternative. ";
    } else {
      if (buttonMayHaveName(node, nodes)) continue;
      ruleId = "button-name";
      message = "Button has no recognized accessible name. ";
    }
    const rule = getRule(ruleId);
    if (!rule) throw new Error(`Missing ${ruleId} rule metadata`);
    const id = JSON.stringify([fileUri, rule.id, location.startOffset, location.endOffset]);
    if (seen.has(id)) continue;
    seen.add(id);
    issues.push({
      id,
      ruleId: rule.id,
      title: rule.title,
      message: message + rule.remediation,
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
