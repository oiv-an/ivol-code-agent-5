/**
 * List of directories that are typically large and should be ignored
 * when showing recursive file listings or scanning for code indexing.
 * This list is shared between list-files.ts and the codebase indexing scanner
 * to ensure consistent behavior across the application.
 */
export const DIRS_TO_IGNORE = [
	"node_modules",
	"__pycache__",
	"env",
	"venv",
	"target/dependency",
	"build/dependencies",
	"dist",
	"out",
	"bundle",
	"vendor",
	"tmp",
	"temp",
	"deps",
	"pkg",
	"Pods",
	// kilocode_change start: personal safety snapshots can contain complete workspace trees
	"IVOL-Code-Agent-5-full-backup-*",
	"IVOL-Code-Agent-5-post-install-safety-*",
	// kilocode_change end
	".git",
	".*",
]
