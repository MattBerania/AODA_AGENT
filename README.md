# OPS AODA Agent

OPS AODA Agent is a VS Code extension that helps developers find and fix common
accessibility issues in HTML and ASP.NET Razor (`.cshtml`) source, including
legacy applications. It highlights findings in the Problems panel and provides
remediation guidance tied to WCAG criteria.

## Run locally

Open this repository in VS Code 1.95 or newer with Node.js and npm available.
Run `npm ci` from the repository root, then press F5 using **Run OPS AODA Agent**.
VS Code builds the extension and opens the bundled demo workspace in an
Extension Development Host. You can scan the fixtures without an ASP.NET server.

## Try the demo

1. Open [01_service_portal.html](tests/aoda_test_pack/01_service_portal.html) in the
   demo workspace. Open the Command Palette and run **OPS AODA: Scan Current Page**.
   The Problems panel should show six findings for this file.
2. Run **OPS AODA: Show Scan Issues** and pick the unnamed button. VS Code selects
   the source tag and shows remediation guidance in the **OPS AODA Issues** output.
3. Add `Search` between the submit button's opening and closing tags. Pause
   briefly and watch the file's count drop to five without saving. Undo the edit.
4. Run **OPS AODA: Scan Repository**. The sample workspace should report five
   analyzed files and 16 diagnostics, including four contrast warnings.

## Commands

| Command Palette action | What it does |
| --- | --- |
| **OPS AODA: Scan Current Page** | Scans the current HTML or Razor buffer. The active supported file also rescans after a brief typing pause or when you switch to it. |
| **OPS AODA: Scan Repository** | Scans supported files across the open workspace and reports analyzed, skipped, and failed files. |
| **OPS AODA: Show Scan Issues** | Opens a finding from the current page's scan and displays its source and remediation guidance. |
| **OPS AODA: Open Agent UI** | Opens the side panel for scan findings and optional GitHub Copilot assistance. With a Copilot model available, you can review and approve proposed edits for structural findings. |

## Activity Bar sidebar integration

The shield-and-check icon opens a sidebar with **OPS AODA Agent** placeholder
text. The existing **Open Agent UI** command continues to open its existing panel.

| Contribution | Stable identifier |
| --- | --- |
| Activity Bar container | `opsAoda` |
| Webview view | `opsAoda.agentSidebar` |

`activate()` calls `registerAgentSidebar()`, which registers the placeholder
provider and its disposable. `resolveWebviewView()` supplies its content.

For integration, replace the placeholder rendering in `src/agentSidebar.ts`
using the supplied `view.webview`. Keep both identifiers and the `webview`
contribution type, and register only one provider for the view. Configure resource
URIs, scripts, content security policy, and messaging when connecting the real UI.

F5 smoke check: click the shield icon, confirm the placeholder appears, switch to
Explorer and back, and verify the existing Command Palette commands still work.

## Scan coverage

The structural checks look for missing image text alternatives, accessible names
for buttons, links, iframes and form controls, and a missing page language
declaration. A separate HTML check flags some low-contrast inline colour pairs
for review.

Unsupported Razor or malformed markup can cause an explicit file skip. A scan
with zero findings means the implemented checks found nothing in the analyzed
source. AODA and WCAG compliance still require review of the rendered page.

## Verify and contribute

Run `npm run typecheck` and `npm test` from the repository root. See the
[scanner reference](docs/scanner-reference.md) for detection limits, scan
outcomes, and integration contracts. See the
[legacy Razor fixtures](tests/fixtures/legacy/README.md) for additional smoke checks.
