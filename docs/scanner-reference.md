# Scanner reference

The scanner accepts source text and a serialized document URI. It uses parse5
source locations and runs independently of VS Code, with no file I/O. The
extension passes the current document buffer, including unsaved edits, to the
scanner and publishes the results as diagnostics in Problems.

## Supported checks

| Rule | WCAG criterion | What the scanner checks |
| --- | --- | --- |
| `image-text-alternative` | 1.1.1 | An `img` needs an `alt` attribute or a recognized naming attribute. An empty `alt` is accepted for decorative images. |
| `button-name` | 4.1.2 | A native `button` needs naming text, a recognized naming attribute, a named child image, or an associated HTML label. The check treats the label association as a possible name. |
| `link-name` | 2.4.4, 4.1.2 | An anchor with `href` needs naming text, a recognized naming attribute, or a named child image. A dynamic `href` supplies a destination only. The check covers missing names and leaves link purpose for review. |
| `document-language` | 3.1.1 | An explicit `html` opening tag needs a nonblank `lang`. A fragment or Razor view can inherit its language from a layout. Language-tag validity and applicability require review. |
| `iframe-name` | 4.1.2 | An `iframe` needs a nonblank `title` or ARIA naming attribute. The check covers the frame element itself. |
| `form-control-name` | 4.1.2 | Supported inputs, selects and textareas need a recognized naming attribute or a label with naming content. The scanner checks explicit `for`/`id` and wrapping labels. Placeholder-only fields are reported under the project's labeling policy. |
| `inline-text-contrast` | 1.4.3 | A limited HTML-only review check for declared foreground and background colours on paragraphs. |

The naming checks recognize nonblank `aria-label`, `aria-labelledby`, and
`title`. They leave ARIA reference resolution, naming quality, and the full
browser accessible-name computation for rendered review. Static exclusions
include explicitly hidden markup, inert template contents, and elements affected
by server processing such as `runat` and `asp-*`. Individual detectors also
defer cases with uncertain runtime semantics. A child image missing `alt`, for
example, is reported by the image rule while the surrounding button or link
name is treated as uncertain because of possible browser filename fallback.

The contrast check requires direct nonblank text in an HTML paragraph, no child
elements or inline-styled ancestors, and a quoted style containing exactly one
`color` and one `background-color` declaration. Both colours must use opaque
`#rgb` or `#rrggbb` notation. Detectable stylesheets disable the contrast check.
A ratio below 3:1 produces a warning at the foreground colour token. Review
the rendered colours, text size, and weight for WCAG 1.4.3.

## Razor and markup limits

For `.cshtml` files, the scanner masks supported leading directives and
`ViewData` setup blocks in its analysis copy. Directives include `@model`,
`@using`, `@inherits`, and `@namespace` with simple or dotted names. A
supported setup block consists solely of literal string-to-string assignments
such as `@{ ViewData["Title"] = "Service Request"; }`. Masking stops at markup
or unsupported syntax and preserves every UTF-16 offset and line ending.

The scanner accepts a complete quoted attribute value such as
`src="@Model.ImageUrl"` and simple dotted `@Model.Property` expressions in
eligible text within explicit HTML elements. It also accepts common ASCII
email literals in HTML text and quoted attributes. A supported dynamic naming
value is treated as uncertain, and unrelated static issues can still be reported.

An unsupported `@` occurrence causes a whole-file skip. Examples include
Razor comments, conditionals, loops, method calls, compound attribute values,
and Tag Helper directives. HTML style blocks are treated as opaque for this
check, so CSS at-rules in `.html` files can coexist with structural findings.
HTML parse errors also cause a skip except for a missing doctype.

## Outcomes and diagnostics

- `scanAccessibilityOutcome(source, fileUri)` returns `analyzed` with a
  possibly empty findings list, or `skipped` or `failed` with a reason and an
  empty list. Use this API when reporting scan coverage.
- The compatibility API `scanAccessibility(source, fileUri)` returns an
  `AccessibilityIssue[]`, with an empty array for skipped input, and throws on
  failure. The `opsAoda.scanCurrentPage` command also returns an
  `AccessibilityIssue[]`.
- Ranges use the original source, with zero-based lines and UTF-16 columns and
  an exclusive end. Structural findings highlight the opening tag. Occurrence
  IDs use the serialized URI, rule ID, and source offsets, so moving a finding
  can change its ID.
- The repository command discovers case-insensitive `.html` and `.cshtml`
  filenames across workspace folders. Its exclusion pattern covers
  `node_modules`, `bin`, `obj`, `dist`, `.git`, and `.vs` directories.
  The summary counts analyzed, skipped, and failed files and reports reasons
  for files it could not analyze.
- Diagnostics and scan snapshots are stored by URI and tied to a document
  version. Editing a document invalidates its results. A supported active
  editor rescans after a 400 ms pause, and rescanning one file preserves other
  files' diagnostics.

## Extension integration

The VS Code extension exports a `ScannerIntegration` from `activate()`.
The local extension identifier is `ops-aoda-local.ops-aoda-agent`.
The versioned snapshots and issue contexts are immutable.
[Integration types](../src/types/scannerIntegration.ts)

| Member | Contract |
| --- | --- |
| `getLatestScan()` | Returns the current-page snapshot when one is available, including the URI, document version, and structured outcome. |
| `onDidChangeScan` | Publishes current-page snapshot changes. An `undefined` event invalidates the previous snapshot. |
| `getIssueContext(issueId)` | Looks up a retained occurrence by ID and returns the finding, rule metadata, original text, and document version. |
| `refreshCurrentPage()` | Rescans the supported active buffer and returns its snapshot when available. |
| `refreshDocument(document)` | Rescans a specific supported open buffer and returns its snapshot when available. |

Findings and proposed edits are tied to their source version. Issue navigation
checks the current snapshot, document version, and original source text. When
reviewing a Copilot proposal, inspect the target file, original tag, and
replacement before choosing **Apply fix**. **Verified** means the target buffer
matched the approved edit and a fresh scan cleared the finding at that location.
**Applied** reports a confirmed edit alongside the scan outcome. **Unverified**
means VS Code accepted the edit but the resulting buffer could not be confirmed.

## Legacy Razor smoke check

Use the **Run OPS AODA Agent** launch configuration and open
[`contact.cshtml`](../tests/fixtures/legacy/contact.cshtml) in its Extension
Development Host. Run **OPS AODA: Scan Current Page** and expect four findings
for the file. Use **OPS AODA: Show Scan Issues** to select the unnamed submit
button. Add `Send` before the closing `</button>` tag and pause. Expect three
findings and the old issue details to clear. Undo the edit to restore all four.
The legacy fixture notes list further smoke checks and expected skip outcomes.
[Legacy Razor fixtures](../tests/fixtures/legacy/README.md)
