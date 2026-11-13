# Legacy Razor fixtures

These synthetic views resemble ASP.NET MVC source files. They can be opened
individually in VS Code and do not require an ASP.NET application or server.

| File | Razor features | Expected current result |
| --- | --- | --- |
| `contact.cshtml` | Leading `@model`/`@using`, simple dynamic image attributes, native HTML form | Five findings for image, phone input, button, link and iframe |
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
from the Command Palette. Inspect findings in Problems. Zero-result messages
mention the current parser coverage limits.
