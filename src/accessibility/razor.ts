// Deliberately accepts only simple or dotted ASCII names, not arbitrary C# types.
const qualifiedName = "[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*";
const headerDirective = new RegExp(
  `^[ \\t\\uFEFF]*@(?:(?:model|inherits|namespace)[ \\t]+${qualifiedName}|using[ \\t]+${qualifiedName};?)[ \\t]*$`,
);

/**
 * Mask supported leading Razor directives for analysis without moving source.
 * Stop at the first nonblank, unsupported line: we do not parse HTML or C# here.
 * Split with captured separators so CRLF, LF and CR survive exactly as supplied.
 */
export function maskRazorDirectives(source: string): string {
  const parts = source.split(/(\r\n|\r|\n)/);
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    if (/^[ \t\uFEFF]*$/.test(line)) continue;
    if (!headerDirective.test(line)) break;
    // No Unicode flag: replace each UTF-16 code unit with one space.
    parts[index] = line.replace(/[^\r\n]/g, " ");
  }
  return parts.join("");
}
