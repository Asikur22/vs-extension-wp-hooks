/**
 * Detect WordPress core hooks from filesystem location.
 * Definitions under core paths are treated as official (Code Reference docs).
 */

/** Hook names observed via do_action / apply_filters* in core paths */
const coreHookNames = new Set<string>();

/**
 * True when a file is part of WordPress core (not wp-content themes/plugins).
 *
 * Includes:
 * - wp-includes/**, wp-admin/**
 * - Root core PHP such as wp-settings.php (fires after_setup_theme, etc.)
 * - xmlrpc.php at install root
 */
export function isWpCorePath(fsPath: string): boolean {
	const normalized = fsPath.replace(/\\/g, '/');

	// Never treat theme/plugin/uploads code as core
	if (/(^|\/)wp-content\//.test(normalized)) {
		return false;
	}

	if (/(^|\/)wp-includes\//.test(normalized)) {
		return true;
	}
	if (/(^|\/)wp-admin\//.test(normalized)) {
		return true;
	}

	// Root-level core bootstrap files: wp-settings.php, wp-login.php, wp-cron.php, …
	if (/(^|\/)wp-[^/]+\.php$/i.test(normalized)) {
		return true;
	}

	if (/(^|\/)xmlrpc\.php$/i.test(normalized)) {
		return true;
	}

	return false;
}

/**
 * Record a hook whose definition was found in a core path.
 */
export function rememberCoreHook(name: string): void {
	if (name) {
		coreHookNames.add(name);
	}
}

/**
 * Record the hook when `fsPath` is a WordPress core file.
 */
export function rememberCoreHookIfPath(name: string, fsPath: string): void {
	if (name && isWpCorePath(fsPath)) {
		coreHookNames.add(name);
	}
}

/**
 * True when this hook name was defined in WordPress core
 * (learned during workspace / external scans).
 */
export function isOfficialWpHook(hookName: string): boolean {
	return coreHookNames.has(hookName);
}

/**
 * Drop learned core hooks (e.g. after catalog invalidation).
 */
export function clearCoreHookRegistry(): void {
	coreHookNames.clear();
}
