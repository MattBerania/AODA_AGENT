# OPS AODA Agent

Independent TypeScript source scanner for an accessibility-assistant VS Code
extension. The scanner implements the six approved rules **`image-text-alternative`,
`button-name`, `link-name`, `document-language`, `iframe-name`, and
`form-control-name`** within the source-analysis limits below.

## Run and verify

```powershell
npm ci
npm run typecheck
npm test
```

`npm test` compiles TypeScript into the ignored `dist/` directory, then runs
focused tests using Node's built-in test runner. No test framework is installed.

`tests/fixtures/` contains synthetic full-page HTML examples and a Razor view.
The fixture tests exercise all six rules together, check that reported ranges
select the expected original tags, and verify repeated calls with changed source
clear resolved findings. Production legacy ASP.NET files still need validation.

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

## How the detectors work

1. Supported leading directives in `.cshtml` files are masked with spaces.
2. `parse5` parses the analysis copy with source locations enabled.
3. Safety gates exclude malformed HTML and unsupported Razor syntax.
4. Supported native HTML elements are inspected once per rule and source position.
5. Findings copy metadata from the existing rule catalog via `getRule`.

Any `alt` attribute, including `alt=""`, is accepted. Non-empty `aria-label`,
`aria-labelledby`, and `title` are also recognized. Referenced IDs and alternative
text quality are not validated. Dynamic naming values are unresolved rather than
assumed invalid. Empty or whitespace-only ARIA values alone do not supply a name.

Explicitly hidden elements/ancestors (`hidden`, `aria-hidden="true"`), image roles
`none`/`presentation`, inert template contents, and server-processed elements or
ancestors (`runat`, `asp-*`) are skipped conservatively. This does not verify the
validity of those declarations. Comments, scripts and styles are not scanned as
HTML image markup. Stylesheet visibility and generated markup are not analyzed.

### Button names

The `button-name` detector checks native `<button>` elements. It recognizes
non-empty `aria-label`, `aria-labelledby`, or `title`, nested text, and non-empty
child-image alternatives. It does not resolve ARIA references or implement the
full browser accessible-name computation. Empty/whitespace-only text and `alt=""`
on a child image do not supply a button name. A button with `aria-label="Close"`
can contain a decorative image with `alt=""` without either rule reporting it.

Comments, script/style/template contents and explicitly hidden descendants do
not contribute naming text. Presentation roles on text containers do not hide
their text. CSS visibility, pseudo-element content, JavaScript mutations and
rendered browser behavior are not evaluated, so findings describe the supported
static markup subset.

Conservative skips include unclosed buttons, changed roles, dynamic attributes,
SVG/custom-element content, embedded controls, and server-processed descendants.
Associated HTML labels (`for`/`id` or wrapping labels) are recognized as possible
names, but their content is not validated yet. A child image without `alt` is
left to the image rule: browser filename fallback makes the button name uncertain.
Inline Razor button text such as `@Model.ButtonText` continues to trigger the
existing whole-file skip; this detector does not expand Razor expression support.

Input buttons and non-native `role="button"` elements are outside this increment.

### Link names

The `link-name` detector checks native `<a>` elements with an `href` attribute,
including empty `href` and fragment-only destinations. Anchors without `href`
and custom `role="link"` elements are outside this detector. It reuses the button
content-naming helper for nested text, non-empty ARIA naming/title attributes,
child-image alternatives, hidden descendants and conservative uncertainty skips.
HTML labels are not naming mechanisms for hyperlinks.

A complete simple Razor destination such as `href="@Model.HelpUrl"` is supported:
its runtime value is unknown, but it supplies no link name. An otherwise empty
link still receives a finding. Razor-generated link text, method-call URLs and
Tag Helpers remain subject to the existing skips. Non-empty ARIA references are
recognized without resolving their targets. Link wording such as "Read more"
is not judged for purpose or quality; this is a missing-name check only.

Link and image rules remain independent. A named link containing an image without
an alternative receives an image finding. An unnamed link containing only
`<img alt="">` receives a link finding. A child image missing `alt` makes the link
name uncertain because of possible filename fallback; only the image is reported.
The shared content-naming helper retains the documented button limitations,
including no CSS or browser accessible-name computation.

### Document language

The `document-language` detector reports an explicit `<html>` opening tag with
a missing or whitespace-only `lang` attribute. Any nonblank value, including a
supported simple Razor value such as `lang="@Model.Language"`, avoids a finding.
Language-tag validity and whether the declaration matches the page content are
not checked. This scanner parses HTML, not XHTML; it checks `lang`, not `xml:lang`.

parse5 can create an implicit HTML root for fragments, so this detector requires
a source-backed opening tag. A Razor view without `<html>` receives no language
finding: its shared layout may declare the language. Existing malformed-input,
unsupported-Razor and server-processing skips still apply. Findings cover the
original opening tag and reuse catalog metadata for WCAG 3.1.1.

### Iframe names

The `iframe-name` detector checks native `<iframe>` elements for a non-empty
`title`, `aria-label`, or `aria-labelledby`. Blank values receive a finding when
no other recognized naming attribute is present. Referenced labels and naming
quality are not validated. Supported simple Razor naming values are treated as
unresolved, while a dynamic `src` alone still leaves the frame unnamed.

Fallback text between iframe tags, `name`/`id`, and a title inside `srcdoc` do not
supply the iframe's accessible name. Embedded document content is not scanned.
Explicitly hidden elements, server processing, changed roles and dynamic
`aria-hidden` on the iframe are skipped conservatively. Existing whole-file HTML
parse-error and unsupported-Razor skips apply. Findings cover the opening tag
and use the existing WCAG 4.1.2 catalog metadata.

### Form control names

The `form-control-name` detector checks ordinary input fields, selects and
textareas. It recognizes nonblank ARIA naming/title attributes, exact `for`/`id`
label associations, and wrapping labels. Explicit labels may precede or follow
the field. Label content uses the existing content-naming helper with the field
itself excluded, so input values, textarea contents and selected option text do
not supply label text. Multiple associated labels are checked until one provides
text or uncertainty. Empty labels alone still produce findings.

Supported input types are text (including omitted/empty type), password, email,
search, tel, url, number, checkbox, radio, file, range, color, date, datetime-local,
month, time and week. Hidden, button, submit, reset, image, unknown and dynamic
input types are skipped. Disabled and readonly fields remain in scope.

Dynamic IDs, label targets, roles, custom-element ancestors and other runtime
attributes are handled conservatively. Duplicate field IDs and hidden or
server-processed associated labels are unresolved. Complex label content retains
the content helper's uncertainty skips. CSS visibility is not evaluated.

Following the project's requested labeling policy, placeholder-only fields
receive a finding for lacking a recognized label. Browsers can use placeholder
text as a fallback accessible name, so this policy does not claim their computed
browser name is empty. The detector checks source naming mechanisms without
implementing the full browser accessible-name algorithm.

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

For `.cshtml` file URIs, `src/accessibility/razor.ts` masks standalone directives
in the leading header before parsing:

```cshtml
@model MyApp.Models.ProductViewModel
@using MyApp.Models
@inherits MyApp.BaseView
@namespace MyApp.Views

<img src="@Model.ImageUrl">
```

Each directive must use a simple or dotted ASCII name. Indentation, blank lines,
an initial BOM and an optional trailing semicolon on `@using` are supported.
Generic types, aliases, inline comments, and multiline directives are not.
Masking stops at the first line that is neither blank nor a supported directive,
so directive-like text inside HTML attributes, comments or scripts is not masked.
It replaces each directive character with a space, preserving source length and
LF/CRLF/CR line endings. Findings and IDs therefore retain original positions.
The source is never edited. `.html` inputs do not receive directive masking.

**Any remaining unsupported `@` occurrence causes the entire source to be
skipped.** This includes directives outside the supported leading header, Razor
comments, C# blocks (including `@using (...) { ... }`), helpers, method calls,
interpolated attribute values, and even literal email addresses. Tag-helper
directives such as `@addTagHelper` remain unsupported because they can change
rendered markup. This is still a limited source-analysis subset of Razor.

HTML parse errors also cause a whole-file skip, except for a missing doctype
(normal in fragments). Ordinary omitted container end tags accepted by the HTML
parser can still be scanned. The scanner uses an HTML document parse, so it does
not model every context in which a fragment might later be inserted.

The current `AccessibilityIssue[]` interface cannot distinguish skipped source
from source without findings. Consumers must preserve that limitation in their
wording; a future richer scan result could expose coverage information.

These are partial automated checks. An empty result does **not** establish WCAG
or AODA compliance. No VS Code UI, file scanning, Copilot integration, or fixes
are implemented. All six approved detectors have focused tests for their
documented subsets.

## Next increments

Validate production legacy application files and expand safe Razor coverage as
needed. Active-editor integration remains a separate task.
