import type * as VSCode from "vscode";

export async function discoverSupportedFiles(
  api: typeof VSCode,
): Promise<VSCode.Uri[]> {
  return api.workspace.findFiles("**/*.{[hH][tT][mM][lL],[cC][sS][hH][tT][mM][lL]}", "**/{node_modules,bin,obj,dist,.git,.vs}/**");
}

export const SCAN_REPOSITORY_COMMAND = "opsAoda.scanRepository";

