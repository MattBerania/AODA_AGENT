/**
 * A location in source text.
 *
 * Lines and characters are zero-based. The start is inclusive and the end is
 * exclusive, matching VS Code's range convention without depending on its API.
 */
export interface SourceRange {
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

export type IssueSeverity = "error" | "warning" | "info";

/**
 * One accessibility problem found at a specific source location.
 *
 * This is a self-contained snapshot so UI and AI consumers do not need to
 * perform a rule lookup before presenting a finding.
 */
export interface AccessibilityIssue {
  /** Unique identifier for this occurrence, not for the underlying rule. */
  readonly id: string;
  readonly ruleId: string;
  readonly title: string;
  readonly message: string;
  /** Serialized document URI, such as a VS Code file URI. */
  readonly fileUri: string;
  readonly range: SourceRange;
  readonly category: string;
  readonly severity: IssueSeverity;
  /** WCAG success criterion identifiers, for example "1.1.1". */
  readonly wcagCriteria: readonly string[];
}

/** Reusable metadata for one deterministic accessibility rule. */
export interface AccessibilityRule {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly remediation: string;
  readonly category: string;
  readonly severity: IssueSeverity;
  readonly wcagCriteria: readonly string[];
}

/**
 * A proposed source change. Applying it is a separate, user-approved action.
 */
export interface ProposedFix {
  readonly issueId: string;
  readonly fileUri: string;
  readonly range: SourceRange;
  readonly originalText: string;
  readonly replacementText: string;
  /** Document version used to reject a fix if the file has since changed. */
  readonly documentVersion: number;
  readonly explanation: string;
}
