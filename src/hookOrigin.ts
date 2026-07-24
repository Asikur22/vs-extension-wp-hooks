/**
 * Classify where a WordPress hook is defined (core / theme / plugin / other).
 */
import { isWpCorePath } from './wpCoreHooks';

export type HookOriginKind = 'core' | 'theme' | 'plugin' | 'custom';

/**
 * Human-readable origin label for hover UI.
 */
export function getHookOriginLabel(kind: HookOriginKind): string {
	switch (kind) {
		case 'core':
			return 'WordPress Core Hook';
		case 'theme':
			return 'Theme Hook';
		case 'plugin':
			return 'Plugin Hook';
		default:
			return 'Custom Hook';
	}
}

/**
 * Infer hook origin from the filesystem path of a definition site.
 */
export function classifyHookOrigin(fsPath: string): HookOriginKind {
	const normalized = fsPath.replace(/\\/g, '/');

	if (isWpCorePath(normalized)) {
		return 'core';
	}

	if (/(^|\/)wp-content\/themes\//.test(normalized)) {
		return 'theme';
	}

	if (
		/(^|\/)wp-content\/plugins\//.test(normalized) ||
		/(^|\/)wp-content\/mu-plugins\//.test(normalized)
	) {
		return 'plugin';
	}

	// Standalone theme (style.css + functions.php style layouts)
	if (/(^|\/)themes\/[^/]+\//.test(normalized)) {
		return 'theme';
	}

	// Standalone plugin folder patterns
	if (/(^|\/)plugins\/[^/]+\//.test(normalized)) {
		return 'plugin';
	}

	return 'custom';
}

/**
 * Prefer a core definition when several exist; otherwise the first location.
 */
export function pickPrimaryDefinitionPath(
	fsPaths: string[]
): string | undefined {
	if (fsPaths.length === 0) return undefined;
	const core = fsPaths.find((p) => isWpCorePath(p));
	return core ?? fsPaths[0];
}
