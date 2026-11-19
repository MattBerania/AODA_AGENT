// Deliberately accepts only simple or dotted ASCII names, not arbitrary C# types.
const qualifiedName = "[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*";
const headerDirective = new RegExp(
  `^[ \\t\\uFEFF]*@(?:(?:model|inherits|namespace)[ \\t]+${qualifiedName}|using[ \\t]+${qualifiedName};?)[ \\t]*$`,
);

// A deliberately closed grammar for non-rendering ViewData setup, not C# blocks
// in general. Normal quoted strings may contain braces/markup and escaped quotes.
// Verbatim, interpolated and raw strings, comments and other statements stay unsupported.
const setupString = String.raw`"(?:[^"\\\r\n]|\\(?:['"\\0abfnrtv]|u[0-9A-Fa-f]{4}))*"`;
const setupBlock = new RegExp(
  String.raw`^[ \t\uFEFF]*@\{\s*(?:ViewData\s*\[\s*${setupString}\s*\]\s*=\s*${setupString}\s*;\s*)+\}[ \t]*(?=\r|\n|$)`,
);

/**
 * Classify only text already identified as HTML text or a quoted attribute value.
 * This copy is for the safety gate, never for parsing or accessible-name evidence.
 * Deliberately narrow: common ASCII emails and dotted Model properties only.
 */
export function hasUnsupportedRazorText(text: string, allowModelExpression = false): boolean {
  const withoutEmails = text.replace(
    /(?<![A-Za-z0-9_@.+-])[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+\b/g,
    (email) => " ".repeat(email.length),
  );
  const remaining = allowModelExpression ? withoutEmails.replace(
    /(?<![A-Za-z0-9_@.])@Model(?:\.[A-Za-z_]\w*)+(?=$|[\s,;!:])/g,
    (expression) => " ".repeat(expression.length),
  ) : withoutEmails;
  return remaining.includes("@");
}

/**
 * Mask supported leading directives and literal ViewData setup blocks.
 * Stop at markup or unsupported syntax; never search inside HTML for blocks.
 * Preserve every UTF-16 offset and newline in the analysis copy.
 */
export function maskRazorDirectives(source: string): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const remaining = source.slice(offset);
    const block = setupBlock.exec(remaining);
    if (block) {
      parts.push(block[0].replace(/[^\r\n]/g, " "));
      offset += block[0].length;
      continue;
    }
    const [, line, newline] = /^([^\r\n]*)(\r\n|\r|\n|$)/.exec(remaining)!;
    const blank = /^[ \t\uFEFF]*$/.test(line!);
    if (!blank && !headerDirective.test(line!)) break;
    // No Unicode flag: replace each UTF-16 code unit with one space.
    parts.push((blank ? line! : line!.replace(/[^\r\n]/g, " ")) + newline!);
    offset += line!.length + newline!.length;
  }
  return parts.join("") + source.slice(offset);
}
