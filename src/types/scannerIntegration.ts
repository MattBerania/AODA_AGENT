import type { Event } from "vscode";
import type { AccessibilityIssue, AccessibilityRule, ScanOutcome } from "./accessibility";

/** The latest scan, tied to the editor buffer version it analyzed. */
export type ScanSnapshot = ScanOutcome & {
  readonly fileUri: string;
  readonly documentVersion: number;
}

/** Source and metadata that presentation or proposed-fix consumers can read. */
export interface IssueContext {
  readonly issue: AccessibilityIssue;
  readonly rule: AccessibilityRule;
  readonly originalText: string;
  readonly documentVersion: number;
}

/** Returned from extension activation for use by other extension components. */
export interface ScannerIntegration {
  readonly onDidChangeScan: Event<ScanSnapshot | undefined>;
  getLatestScan(): ScanSnapshot | undefined;
  getIssueContext(issueId: string): IssueContext | undefined;
  /** Immediately refresh the active supported page, for example after an approved edit. */
  refreshCurrentPage(): ScanSnapshot | undefined;
}
