/**
 * Configuration manager for WP Hooks.
 */
import * as vscode from 'vscode';

export interface ExtensionConfig {
	/**
	 * Absolute paths outside the workspace to include in hook scans
	 * (e.g. WordPress core when you only have a plugin folder open).
	 */
	externalPaths: string[];
}

/** In-memory lookup cache TTL (seconds). */
export const CACHE_TTL_SECONDS = 300;

/** Max cached hook lookup entries (LRU). */
export const CACHE_MAX_ENTRIES = 200;

const SECTION = 'wpHooks';

/** Always exclude vendor and node_modules from workspace scans. */
const DEFAULT_EXCLUDE = '{**/node_modules/**,**/vendor/**}';

/**
 * Read current configuration.
 */
export function getConfig(): ExtensionConfig {
	const cfg = vscode.workspace.getConfiguration(SECTION);
	return {
		externalPaths: cfg.get<string[]>('externalPaths', []),
	};
}

/**
 * Exclude glob for vscode.workspace.findFiles (vendor + node_modules).
 */
export function getExcludeGlob(): string {
	return DEFAULT_EXCLUDE;
}

/**
 * True if a file path should be ignored by watchers/scans.
 */
export function isExcludedPath(fsPath: string): boolean {
	const normalized = fsPath.replace(/\\/g, '/');
	return (
		normalized.includes('/node_modules/') ||
		normalized.includes('/vendor/')
	);
}
