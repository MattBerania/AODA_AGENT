# OPS AODA Agent

Independent TypeScript source scanner for an accessibility-assistant VS Code
extension. This first increment implements **only `image-text-alternative`**.
The existing six-rule catalog is retained for subsequent detectors.

## Run and verify

```powershell
npm ci
npm run typecheck
npm test
```

`npm test` compiles TypeScript into the ignored `dist/` directory, then runs
focused tests using Node's built-in test runner. No test framework is installed.

After building, try it from the repository root:

```powershell
node -e 'const {scanAccessibility} = require("./dist/accessibility/scanner.js"); console.log(scanAccessibility("<img>", "file:///example.html"));'
```

Or call it from TypeScript:

```typescript
import { scanAccessibility } from "./accessibility/scanner";

const findings = scanAccessibility('<img src="logo.png">', 'file:///example.html');
```

The function accepts original source text and a serialized file URI; it performs
no file I/O and has no VS Code dependency. The caller is responsible for selecting
supported `.html` and `.cshtml` files. Scan again with updated source when needed;
there is no cached state.

## How the first detector works

1. `parse5` parses the source with source locations enabled.
2. Safety gates exclude malformed HTML and unsupported Razor syntax.
3. Native HTML `<img>` elements are inspected once per source position.
4. Findings copy metadata from `getRule("image-text-alternative")`.

Any `alt` attribute, including `alt=""`, is accepted. Non-empty `aria-label`,
`aria-labelledby`, and `title` are also recognized. Referenced IDs and alternative
text quality are not validated. Dynamic naming values are unresolved rather than
assumed invalid. Empty or whitespace-only ARIA values alone do not supply a name.

Explicitly hidden elements/ancestors (`hidden`, `aria-hidden="true"`), image roles
`none`/`presentation`, inert template contents, and server-processed elements or
ancestors (`runat`, `asp-*`) are skipped conservatively. This does not verify the
validity of those declarations. Comments, scripts and styles are not scanned as
HTML image markup. Stylesheet visibility and generated markup are not analyzed.

Ranges cover the complete opening tag in the **original source**, using zero-based
lines and UTF-16 characters with an exclusive end. parse5's one-based line/column
positions are converted by subtracting one. LF, CRLF, CR and emoji are tested.
Findings are returned in source order. IDs serialize `[fileUri, ruleId,
startOffset, endOffset]` as JSON: distinct occurrences have distinct IDs, and an
unchanged source produces the same IDs. Edits that move an occurrence change its
ID; these are not persistent identities across document versions.

## Parser and Razor limits

parse5 was chosen for HTML parsing behavior, source locations and TypeScript
types. Version 7 supports this project's CommonJS/Node16 module settings. It adds
one direct runtime dependency and its transitive entity-decoding dependency.
htmlparser2 offers speed and source indices but takes HTML parsing shortcuts;
regex alone would require maintaining HTML tokenization and quoting logic.
Neither library parses Razor.

The initial Razor subset permits only complete quoted attribute values of the
form `@identifier` or `@identifier.property`, including longer property chains.
For example, `src="@Model.ImageUrl" alt="@Model.ImageDescription"` is supported;
the runtime values are not evaluated. A dynamic `src` alone still lacks an
alternative.

**Any other `@` occurrence causes the entire source to be skipped.** This includes
`@model` directives, Razor comments, C# blocks, helpers, method calls, interpolated
attribute values, and even literal email addresses. The same conservative gate
applies to both HTML and Razor input. This deliberately narrow first increment
does not yet provide broad Razor-view coverage. Supporting common directives and
isolating opaque C# regions without changing source offsets is a useful next
parser increment before expanding coverage.

HTML parse errors also cause a whole-file skip, except for a missing doctype
(normal in fragments). Ordinary omitted container end tags accepted by the HTML
parser can still be scanned. The scanner uses an HTML document parse, so it does
not model every context in which a fragment might later be inserted.

The current `AccessibilityIssue[]` interface cannot distinguish skipped source
from source without findings. Consumers must preserve that limitation in their
wording; a future richer scan result could expose coverage information.

These are partial automated checks. An empty result does **not** establish WCAG
or AODA compliance. No VS Code UI, file scanning, Copilot integration, fixes, or
other rule detectors are implemented in this increment.

## Next increments

Expand safe Razor coverage, then add the remaining approved detectors one at a
time: form controls, buttons, links, document language, and iframes. Reuse the
parser and metadata catalog; add focused tests with each detector. Active-editor
integration remains a separate task.
