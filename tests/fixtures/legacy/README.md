# Legacy Razor fixtures

These synthetic views resemble ASP.NET MVC source files. They can be opened
individually in VS Code and do not require an ASP.NET application or server.

| File | Razor features | Expected current result |
| --- | --- | --- |
| `contact.cshtml` | Leading `@model`/`@using`, simple dynamic image attributes, native HTML form | Four findings for phone input, button, link and iframe |
| `_Layout.cshtml` | `Layout` code block, `ViewBag`, `Url.Action`, bundles, `RenderBody`, `RenderSection` | Entire file skipped by the current Razor safety gate |
| `orders.cshtml` | Generic model, Razor comment, `Html.BeginForm`, `TextBox`, `DisplayFor`, `foreach`, `if`, `Url.Action` | Entire file skipped by the current Razor safety gate |

The layout intentionally lacks `lang`, its logo lacks an alternative, and its
header link lacks a name. The orders view includes an empty button and an
image-only link with an empty alternative. Those intentional source problems
remain undetected while unsupported Razor causes the whole-file skips.
Helper-generated fields are unresolved.

`tests/currentPageScanning.test.cjs` checks these expectations through the command
handler using a simulated VS Code API and the real scanner. It verifies findings'
serialized document URIs and exact opening-tag ranges for `contact.cshtml`.

To inspect the command in VS Code, press F5 using `Run OPS AODA Agent`, open a
fixture in the Extension Development Host, then run `OPS AODA: Scan Current Page`
from the Command Palette. Inspect findings in Problems. Scan messages distinguish analyzed files from skipped files and include skip reasons.

## Scan outcome regression examples

| File | Expected outcome | Findings | What to inspect |
| --- | --- | --- | --- |
| `missing-accessible-names.cshtml` | Analyzed | 6 | One finding for each implemented rule, including missing document language |
| `recognized-accessible-names.cshtml` | Analyzed | 0 | Named equivalents of the six elements and an explicit language |
| `unsupported-conditional.cshtml` | Skipped | 0 | Unsupported Razor reason, despite an unnamed image and button |
| `malformed-markup.cshtml` | Skipped | 0 | Malformed HTML reason caused by a duplicate attribute, despite an unnamed button |
| `literal-email.cshtml` | Skipped | 0 | Existing literal-email limitation is reported explicitly, despite an image missing alt |

Previously, the last three examples returned the same empty findings array as a
successfully analyzed zero-finding file. These examples verify explicit skip
reporting. The email example documents the deferred literal-at-sign limitation.

For a manual rescan test, open `missing-accessible-names.cshtml`, scan it, then
replace its contents with `recognized-accessible-names.cshtml`. Its six Problems
entries should disappear. Replace its contents with `unsupported-conditional.cshtml`
to check the skipped status, then restore the original contents to recover six findings.

Run Scan Repository with only these five files in a temporary workspace folder to
expect 5 attempted, 2 analyzed, 3 skipped, 0 failed, and 6 findings. Scanning this
legacy directory also includes its three original fixtures.

Unexpected scanner failures require a runtime error and are covered by automated
failure-injection tests. These fixtures exercise normal source-file inputs.
