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
| **OPS AODA: Open Agent UI** | Opens the Activity Bar sidebar for scan findings and optional GitHub Copilot assistance. With a Copilot model available, you can review and approve proposed edits for structural findings. |

## Activity Bar sidebar integration

The Activity Bar shield-and-check opens the existing agent interface. **OPS AODA:
Open Agent UI** focuses the same sidebar; it does not create an editor panel.

| Contribution | Stable identifier |
| --- | --- |
| Activity Bar container | `opsAoda` |
| Webview view | `opsAoda.agentSidebar` |

`registerAgentUI()` returns the single provider used by `registerAgentSidebar()`.
It loads the existing `prototype/` assets and handles scan, chat, and fix messages.
The browser sends `ready` after installing its listeners. Responses received while
hidden are queued until the view is visible. Context is retained during Activity
Bar switching, preserving navigation, draft text, and pending fix review at the
cost of keeping this webview in memory. Chat history remains in workspace state;
draft text and the active chat session also use webview state. Explicit disposal
clears pending approvals and listeners. A new view starts fresh findings/navigation
and requires a new fix review; it never restores approval authority from browser state.

F5 smoke checks: open the sidebar at a narrow width, scan a demo page and the
repository, select a finding, review/copy/apply a suggestion, and send a chat
message if Copilot is available. Type a draft, switch to Explorer and back, resize,
and confirm the draft and selected view remain. Run **Open Agent UI** and confirm
it reveals the same interface. Use disposable fixture edits and undo afterward.

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
