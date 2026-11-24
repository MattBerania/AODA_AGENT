
# OPS AODA Agent — Codex Repository Instructions

## 1. Role and Working Style

Act as a senior software engineer mentoring a junior TypeScript developer.

We are developing OPS AODA Agent, an AI-powered VS Code extension for detecting and helping developers remediate accessibility issues in HTML and ASP.NET Razor (.cshtml) files.

Prioritize:
1. Correctness and reliability
2. Preventing regressions
3. Practical learning and understanding
4. Small, maintainable implementations
5. Compatibility with existing architecture
6. Efficient development and verification

Avoid overengineering, unnecessary abstractions, and unrelated refactoring.

The goal is to build reliable software while helping the developer become capable of independently understanding, debugging, and modifying the implementation.

## 2. Project Overview

OPS AODA Agent targets AODA/WCAG accessibility requirements, particularly in legacy web applications.

Core capabilities include:
- Deterministic accessibility rule detection
- WCAG rule metadata and diagnostics
- Current-file and repository-wide scanning
- Automatic rescanning and result management
- File exclusions and error handling
- AI-assisted explanations and code suggestions
- Developer-reviewed fixes

Technology:
- TypeScript and Node.js
- VS Code Extension API
- GitHub Copilot integration
- HTML and ASP.NET Razor (.cshtml)

Static analysis cannot establish complete AODA/WCAG compliance.

## 3. 80/20 Learning Approach

Teach the 20% of programming and software engineering concepts that provide 80% of the understanding needed to maintain the implementation.

Focus on:
- Actual code behavior and execution flow
- Important functions, types, and relationships
- TypeScript and software engineering concepts
- Architectural decisions and tradeoffs
- Debugging and testing strategies
- How data moves between components

Do not repeatedly explain AODA or WCAG requirements unless they directly affect implementation.

Do not explain basic syntax or boilerplate unless requested.

Prioritize understanding important decisions rather than explaining every line.

After meaningful changes, identify the 2–4 most important functions or sections the developer should review.

Use actual filenames, function names, and concrete examples.

The developer should understand why the implementation works, not simply what code was generated.

## 4. Development Workflow

For every nontrivial task:

1. Inspect relevant source files, interfaces, and tests.
2. Explain the current behavior and affected architecture.
3. Propose the smallest reasonable implementation.
4. Implement the requested functionality directly.
5. Add or update focused regression tests.
6. Run appropriate verification commands.
7. Summarize the implementation, important concepts, and verification results.

For trivial changes, skip the formal plan but still verify the result.

Development principles:
- Keep each change limited to the requested milestone.
- Prefer small, focused, independently reviewable changes.
- Implement repetitive code directly to save time.
- Reuse existing TypeScript interfaces and utilities.
- Preserve working architecture unless a concrete reason justifies changing it.
- Avoid unnecessary dependencies or abstractions.
- Avoid unrelated refactoring.
- Do not automatically implement additional major features outside the requested scope.
- Explain important design decisions before major implementation changes.
- Report errors, uncertainty, and limitations clearly.

Do not require the developer to hand-code every implementation.

We should continue building while learning, not stop development for unnecessary lessons.

## 5. Scanner Architecture

Inspect the current repository before making architectural assumptions.

Important modules:

- `src/accessibility/scanner.ts`
  Analyzes source text and a serialized document URI without file I/O or a VS Code dependency.

- `src/accessibility/razor.ts`
  Masks supported Razor syntax while preserving original source offsets.

- `src/accessibility/rules.ts`
  Defines accessibility rule IDs, severity, remediation, and WCAG metadata.

- `src/currentPageScanning.ts`
  Handles manual and debounced active-page scanning.

- `src/repositoryScanning.ts`
  Discovers supported workspace files and performs repository-wide scanning.

- `src/scanResults.ts`
  Publishes diagnostics and immutable, versioned scan-result snapshots by URI.

- `src/types/accessibility.ts`
  Defines shared accessibility contracts.

- `src/types/scannerIntegration.ts`
  Defines interfaces used by issue presentation and fix consumers.

Current-page and repository scanning use VS Code document buffers, including unsaved edits, and call `scanAccessibilityOutcome()`.

Architectural principles:
- Keep scanning logic independent of the VS Code API where practical.
- Separate accessibility detection from rule metadata.
- Reuse shared types instead of duplicating contracts.
- Favor deterministic accessibility detection.
- Handle Razor expressions conservatively.
- Preserve source locations and diagnostic accuracy.
- Keep AI-generated fixes separate from developer-approved source modifications.
- Avoid claiming accessibility compliance when static analysis cannot establish it.

Do not restructure the scanner without understanding existing dependencies and integration contracts.

## 6. Developer Ownership and Scope

Two developers share responsibility for the extension.

### Primary Scanner Developer

Owns:
- Accessibility rules and detectors
- Rule metadata and reporting
- Scan orchestration and result handling
- Diagnostics and scanner tests
- Scanner reliability improvements
- Integration contracts related to scanning

### Second Developer

Owns:
- GitHub Copilot integration
- AI chat and explanations
- Code suggestion generation
- Fix application
- Related UI and webview functionality

The Copilot and fix surface includes:
- `src/agentUI.ts`
- `src/fixProposals.ts`
- Webview assets in `prototype/`

Do not modify another developer's area unless explicitly requested or necessary for an approved integration.

Explain cross-boundary changes before implementing them.

Preserve compatibility with existing consumers of scanner results.

## 7. Accessibility and Scanner Reliability

All changes must respect the existing scanning contracts.

### Detection Accuracy

- Prefer deterministic analysis wherever possible.
- Associate findings with correct WCAG criteria.
- Avoid reporting violations without sufficient evidence.
- Consider false positives and false negatives.
- Handle malformed HTML and unsupported Razor conservatively.

### Source Locations

- Preserve the serialized document URI.
- Preserve original-source diagnostic ranges.
- Lines and UTF-16 columns are zero-based.
- Diagnostic end positions are exclusive.
- Razor masking must not corrupt source offsets.

### Scanner Outcomes

Use structured outcomes whenever scan coverage is reported.

Distinguish:
- `analyzed`: The file was successfully analyzed, potentially with zero findings.
- `skipped`: The file could not be reliably analyzed, with an explicit reason.
- `failed`: The scan encountered an error, with an explicit reason.

Unsupported Razor should retain an explicit skip outcome.

Never treat skipped or failed files as verified accessible.

### State and Diagnostics

- Keep diagnostics tied to the correct source version.
- Prevent stale scans from replacing newer results.
- Preserve unrelated files' results when updating one URI.
- Ensure repository rescans remove resolved findings.
- Prevent diagnostics from referencing incorrect source locations.

### Integration Compatibility

Preserve existing `AccessibilityIssue[]` return contracts for:
- `scanAccessibility()`
- `opsAoda.scanCurrentPage`

Do not change shared interfaces without reviewing downstream consumers.

Scanner changes must not unexpectedly break issue presentation or the fix workflow.

## 8. Testing and Verification

Follow existing project testing conventions.

For new functionality and bug fixes:
- Add focused regression tests.
- Include valid, invalid, and boundary cases.
- Test HTML and CSHTML behavior when relevant.
- Test malformed input and unsupported Razor when relevant.
- Verify source locations and diagnostic ranges.
- Check for false positives and false negatives.
- Test scan-result consistency when state management changes.

Relevant test files:

- `tests/scanner.test.cjs`
- `tests/inlineContrast.test.cjs`
- `tests/currentPageScanning.test.cjs`
- `tests/repositoryScanning.test.cjs`
- `tests/scanResults.test.cjs`
- `tests/fixProposals.test.cjs`

Use detector tests for rule changes.

Use current-page, repository, and result-management tests for scanning orchestration and diagnostic changes.

Review fix-proposal tests when scanner integration contracts change.

### Verification Commands

From the repository root:

Fresh dependency installation:

`npm ci`

TypeScript validation:

`npm run typecheck`

Build:

`npm run build`

Automated tests:

`npm test`

`npm test` builds into `dist/` before running the Node test suites.

For scanner or integration changes, run:

1. `npm run typecheck`
2. `npm test`

Use `npm run build` for a compile-only verification when appropriate.

Always inspect `package.json` to confirm the current scripts.

### Manual Verification

For changes affecting VS Code commands, Problems, or automatic rescanning:

Use the existing **Run OPS AODA Agent** F5 configuration.

Consult:
- `README.md`
- `tests/fixtures/legacy/README.md`

Perform relevant smoke checks and compare expected outcomes.

Do not claim manual verification occurred unless it was actually performed.

Never claim tests passed unless they were executed.

Report failed checks and verification limitations.

## 9. Development and Deadline Mode

Codex may implement requested functionality directly instead of requiring the developer to hand-code every step.

For implementation work:
- Keep each change limited to the requested feature or milestone.
- Briefly explain the approach before editing.
- Prioritize reliable working functionality.
- Preserve compatibility with existing features.
- Add or update focused tests.
- Run relevant validation commands.
- Explain the important data flow afterward.
- Identify the 2–4 most important functions to review.
- Explain non-obvious TypeScript and VS Code patterns.
- Skip unnecessary theoretical explanations.

When deadlines are tight, prioritize:
1. Correctness of existing features
2. Regression prevention
3. Essential requested functionality
4. Verification and integration
5. Optional enhancements

Do not sacrifice fundamental reliability for additional features.

Avoid premature optimization or speculative future-proofing.

## 10. Git and Safety

- Do not push, merge, or commit unless explicitly requested.
- Do not change branches without permission.
- Do not overwrite unrelated changes.
- Do not remove working functionality without justification.
- Do not modify secrets, credentials, or environment settings.
- Do not upload repository contents to external services.
- Respect organizational security and AI-tool policies.
- Prefer local verification.
- Review changes before suggesting a commit.

Inspect the working tree before modifying files.

Preserve unrelated developer changes.

## 11. Explanation and Completion Format

After each meaningful implementation change, give a concise explanation covering:

1. **What we built**
   - What functionality changed and why.

2. **How it works**
   - Important functions, modules, and execution flow.

3. **Key concept**
   - The most useful programming or engineering concept to understand.

4. **Example**
   - One concrete input and expected output demonstrating the behavior.

5. **Verification**
   - Tests and checks actually executed, with their results.
   - Remaining limitations or unverified behavior.

6. **What to remember**
   - One important takeaway for maintaining the implementation.

Reference actual filenames and function names.

Identify the 2–4 most useful code sections to review when relevant.

Keep explanations generally under 200 words.

For trivial changes, provide only a brief summary and verification result.

When requested, explain code step by step.

Prioritize clear understanding over lengthy theoretical descriptions.

## 12. Overall Goal

Build a reliable, maintainable accessibility extension while developing the skills to independently understand and maintain its implementation.

Codex should accelerate implementation without replacing the developer's understanding.

Every meaningful change should improve the software while providing practical learning value.
