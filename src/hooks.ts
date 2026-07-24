import { isOffsetInPhpComment, offsetAtLine, isPositionInPhpComment } from './phpComment';

/**
 * Hook types in WordPress.
 */
export const enum HookType {
	Action = 'action',
	Filter = 'filter',
}

/**
 * Which "side" of the hook we're looking at.
 * Registration = consumers / references (add_*, remove_*, has_*, doing_*, did_*)
 * Definition    = producers (do_action / apply_filters)
 */
export const enum HookSide {
	Registration = 'registration',
	Definition = 'definition',
}

export interface HookInfo {
	/** The extracted hook name, e.g. "woocommerce_add_cart_item_data" */
	name: string;
	/** Whether this is an action or filter */
	type: HookType;
	/** Whether we're looking at registration/reference or definition */
	side: HookSide;
	/** The WP API function, e.g. "remove_action" */
	func: string;
	/** Whether the hook name is dynamic (contains $variable) */
	isDynamic: boolean;
	/** Start position of the hook name string in the document */
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

type HookFuncMeta = { func: string; type: HookType };

/** Consumer / reference APIs (navigate → definition) */
const CONSUMER_PATTERNS: ReadonlyArray<HookFuncMeta> = [
	{ func: 'add_action', type: HookType.Action },
	{ func: 'add_filter', type: HookType.Filter },
	{ func: 'remove_action', type: HookType.Action },
	{ func: 'remove_filter', type: HookType.Filter },
	{ func: 'has_action', type: HookType.Action },
	{ func: 'has_filter', type: HookType.Filter },
	{ func: 'doing_action', type: HookType.Action },
	{ func: 'doing_filter', type: HookType.Filter },
	{ func: 'did_action', type: HookType.Action },
	{ func: 'did_filter', type: HookType.Filter },
];

/** Definition / producer APIs (navigate → consumers) */
const DEFINITION_PATTERNS: ReadonlyArray<HookFuncMeta> = [
	{ func: 'do_action', type: HookType.Action },
	{ func: 'do_action_ref_array', type: HookType.Action },
	{ func: 'do_action_deprecated', type: HookType.Action },
	{ func: 'apply_filters', type: HookType.Filter },
	{ func: 'apply_filters_ref_array', type: HookType.Filter },
	{ func: 'apply_filters_deprecated', type: HookType.Filter },
];

/** Alternation for regexes covering every supported WP hook API */
export const HOOK_API_ALT = [
	...CONSUMER_PATTERNS.map((p) => p.func),
	...DEFINITION_PATTERNS.map((p) => p.func),
].join('|');

/** Alternation for consumer/reference APIs only */
export const CONSUMER_API_ALT = CONSUMER_PATTERNS.map((p) => p.func).join('|');

/** Alternation for definition APIs only */
export const DEFINITION_API_ALT = DEFINITION_PATTERNS.map((p) => p.func).join('|');

/** Action-oriented API names (vs filter) */
export const ACTION_API_FUNCS = new Set(
	[...CONSUMER_PATTERNS, ...DEFINITION_PATTERNS]
		.filter((p) => p.type === HookType.Action)
		.map((p) => p.func)
);

const ALL_FUNC_NAMES = new Set([
	...CONSUMER_PATTERNS.map((p) => p.func),
	...DEFINITION_PATTERNS.map((p) => p.func),
]);

/**
 * Static WP hook names may include `/` namespaces (Elementor, ACF, etc.),
 * hyphens, dots, colons, and `@`.
 */
const HOOK_NAME_CHARS = String.raw`a-zA-Z0-9_./:@-`;
const HOOK_NAME_STATIC = String.raw`[a-zA-Z_][${HOOK_NAME_CHARS}]*`;
const HOOK_NAME_STATIC_TEST = new RegExp(`^${HOOK_NAME_STATIC}$`);

const HOOK_CALL_REGEX = new RegExp(
	`(${HOOK_API_ALT})\\s*\\(\\s*(['"])(.+?)\\2`,
	'g'
);

/** Quoted hook-name token (supports slash namespaces + light `{$var}` interpolation) */
const HOOK_STRING_REGEX = new RegExp(
	`(['"])([a-zA-Z_][${HOOK_NAME_CHARS}]*(?:\\{?\\$[a-zA-Z_][a-zA-Z0-9_]*\\}?[${HOOK_NAME_CHARS}]*)*)\\1`,
	'g'
);

export function isHookFunction(funcName: string): boolean {
	return ALL_FUNC_NAMES.has(funcName);
}

export function getHookSide(funcName: string): HookSide | null {
	if (CONSUMER_PATTERNS.some((p) => p.func === funcName)) {
		return HookSide.Registration;
	}
	if (DEFINITION_PATTERNS.some((p) => p.func === funcName)) {
		return HookSide.Definition;
	}
	return null;
}

export function getHookType(funcName: string): HookType | null {
	for (const p of [...CONSUMER_PATTERNS, ...DEFINITION_PATTERNS]) {
		if (p.func === funcName) return p.type;
	}
	return null;
}

/**
 * Human label for hover / UI based on the API function.
 */
export function getHookApiLabel(func: string): string {
	if (func.startsWith('add_')) return 'Registration';
	if (func.startsWith('remove_')) return 'Removal';
	if (func.startsWith('has_')) return 'Check';
	if (func.startsWith('doing_') || func.startsWith('did_')) return 'Runtime';
	if (
		func.startsWith('do_action') ||
		func.startsWith('apply_filters')
	) {
		return 'Definition';
	}
	return 'Reference';
}

/**
 * Display order for occurrence lists (hover, peek, Go to Definition).
 * Lower values appear first: add_* → doing_* → did_* → has_* → remove_* → other.
 */
export function getHookApiSortPriority(funcName: string): number {
	switch (funcName) {
		case 'add_action':
		case 'add_filter':
			return 0;
		case 'doing_action':
		case 'doing_filter':
			return 1;
		case 'did_action':
		case 'did_filter':
			return 2;
		case 'has_action':
		case 'has_filter':
			return 3;
		case 'remove_action':
		case 'remove_filter':
			return 4;
		case 'do_action':
		case 'apply_filters':
			return 10;
		case 'do_action_ref_array':
		case 'apply_filters_ref_array':
			return 11;
		case 'do_action_deprecated':
		case 'apply_filters_deprecated':
			return 12;
		default:
			return 50;
	}
}

/**
 * Detect which WP hook API wraps `hookName` on a source line.
 */
export function extractHookApiFromLine(
	line: string,
	hookName: string
): string | null {
	const escaped = hookName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(
		`(${HOOK_API_ALT})\\s*\\(\\s*['"]${escaped}['"]`
	);
	const match = line.match(re);
	return match ? match[1] : null;
}

export function isDynamicHook(name: string): boolean {
	return /\$\{?[\w]+\}?/.test(name);
}

export function getHookFunctionAtPosition(
	lineText: string,
	character: number
): string | null {
	for (const funcName of ALL_FUNC_NAMES) {
		const idx = lineText.indexOf(funcName);
		if (idx !== -1) {
			const funcEnd = idx + funcName.length;
			if (character >= idx && character <= funcEnd + 5) {
				return funcName;
			}
		}
	}
	return null;
}

export function extractHookAtPosition(
	documentText: string,
	lineNumber: number,
	character: number
): HookInfo | null {
	const lines = documentText.split('\n');
	if (lineNumber >= lines.length) return null;

	if (isPositionInPhpComment(documentText, lineNumber, character)) {
		return null;
	}

	const searchRange = 5;
	const startLine = Math.max(0, lineNumber - searchRange);
	const endLine = Math.min(lines.length - 1, lineNumber + searchRange);

	// Single-line hook calls: only when the cursor is on the hook *name* string
	for (let i = startLine; i <= endLine; i++) {
		const line = lines[i];
		const re = new RegExp(HOOK_CALL_REGEX.source, 'g');
		let match: RegExpExecArray | null;

		while ((match = re.exec(line)) !== null) {
			const funcName = match[1];
			const quoteChar = match[2];
			const hookName = match[3];
			const matchStart = match.index;

			if (
				isOffsetInPhpComment(
					documentText,
					offsetAtLine(lines, i, matchStart)
				)
			) {
				continue;
			}

			const hookNameWithQuotes = quoteChar + hookName + quoteChar;
			const hookNameOffsetInMatch = match[0].indexOf(hookNameWithQuotes);
			const hookNameStart = matchStart + hookNameOffsetInMatch + 1;
			const hookNameEnd = hookNameStart + hookName.length;

			const side = getHookSide(funcName);
			const type = getHookType(funcName);
			if (side === null || type === null) continue;

			// Hook name only (including surrounding quotes)
			if (
				i === lineNumber &&
				character >= hookNameStart - 1 &&
				character <= hookNameEnd + 1
			) {
				return {
					name: hookName,
					type,
					side,
					func: funcName,
					isDynamic: isDynamicHook(hookName),
					range: {
						start: { line: i, character: hookNameStart },
						end: { line: i, character: hookNameEnd },
					},
				};
			}
		}
	}

	// Multi-line / wrapped calls: only if this quoted string is the *first* arg
	const currentLine = lines[lineNumber];
	const strRe = new RegExp(HOOK_STRING_REGEX.source, 'g');
	let stringMatch: RegExpExecArray | null;
	while ((stringMatch = strRe.exec(currentLine)) !== null) {
		const strStart = stringMatch.index;
		const strValue = stringMatch[2];
		const strEnd = strStart + stringMatch[0].length;

		if (character < strStart || character > strEnd) {
			continue;
		}

		const parent = findHookCallForFirstArg(lines, lineNumber, strStart);
		if (!parent) {
			continue;
		}

		const side = getHookSide(parent.func);
		const type = getHookType(parent.func);
		if (side === null || type === null) continue;

		return {
			name: strValue,
			type,
			side,
			func: parent.func,
			isDynamic: isDynamicHook(strValue),
			range: {
				start: {
					line: lineNumber,
					character: strStart + 1,
				},
				end: {
					line: lineNumber,
					character: strStart + 1 + strValue.length,
				},
			},
		};
	}

	return null;
}

/**
 * True when `fromLine`/`fromChar` is inside the first string argument of a
 * supported WP hook API call (not later args like callbacks, priorities, etc.).
 */
function findHookCallForFirstArg(
	lines: string[],
	fromLine: number,
	fromChar: number
): { func: string } | null {
	const searchLimit = 10;
	const startLine = Math.max(0, fromLine - searchLimit);

	// Prefer longer names first so apply_filters_deprecated beats apply_filters
	const funcNames = [...ALL_FUNC_NAMES].sort((a, b) => b.length - a.length);

	for (let i = fromLine; i >= startLine; i--) {
		const line = lines[i];

		for (const funcName of funcNames) {
			let searchFrom = line.length;
			while (searchFrom > 0) {
				const funcIndex = line.lastIndexOf(funcName, searchFrom - 1);
				if (funcIndex === -1) break;
				searchFrom = funcIndex;

				// Avoid matching a suffix of a longer identifier (e.g. my_add_action)
				if (funcIndex > 0 && /[A-Za-z0-9_]/.test(line[funcIndex - 1])) {
					continue;
				}

				const afterFunc = line.substring(funcIndex + funcName.length);
				const openParen = afterFunc.search(/\s*\(/);
				if (openParen === -1) continue;

				const parenPos =
					funcIndex +
					funcName.length +
					afterFunc.indexOf('(', openParen);

				if (i === fromLine && fromChar <= parenPos) {
					continue;
				}

				if (
					isFirstArgStringOfCall(
						lines,
						i,
						parenPos,
						fromLine,
						fromChar
					)
				) {
					return { func: funcName };
				}
			}
		}
	}

	return null;
}

/**
 * Walk from the opening `(` of a call to `targetLine`/`targetChar` and verify
 * that position is still inside the call and precedes any top-level comma
 * (i.e. it is the first argument).
 */
function isFirstArgStringOfCall(
	lines: string[],
	callLine: number,
	openParenPos: number,
	targetLine: number,
	targetChar: number
): boolean {
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	let sawCommaAtDepth1 = false;

	for (let li = callLine; li <= targetLine; li++) {
		const line = lines[li];
		const startCol = li === callLine ? openParenPos : 0;
		const endCol = li === targetLine ? targetChar : line.length;

		for (let c = startCol; c < endCol; c++) {
			const ch = line[c];

			if (escaped) {
				escaped = false;
				continue;
			}
			if ((inSingle || inDouble) && ch === '\\') {
				escaped = true;
				continue;
			}
			if (!inDouble && ch === "'") {
				inSingle = !inSingle;
				continue;
			}
			if (!inSingle && ch === '"') {
				inDouble = !inDouble;
				continue;
			}
			if (inSingle || inDouble) {
				continue;
			}

			if (ch === '(') {
				depth++;
			} else if (ch === ')') {
				depth--;
				if (depth < 0) {
					return false;
				}
				// Call closed before we reached the target string
				if (depth === 0 && (li < targetLine || c < targetChar - 1)) {
					return false;
				}
			} else if (ch === ',' && depth === 1) {
				sawCommaAtDepth1 = true;
			}
		}
	}

	// Must be inside the call (depth >= 1) and still on argument 0
	return depth >= 1 && !sawCommaAtDepth1;
}

/**
 * Build a regex pattern to find definitions of a given hook name.
 */
export function buildDefinitionPattern(hookName: string): RegExp {
	const escaped = hookName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(
		`(${DEFINITION_API_ALT})\\s*\\(\\s*['"]${escaped}['"]`,
		'g'
	);
}

/**
 * Build a regex pattern to find registrations / references of a given hook name.
 * Includes add_*, remove_*, has_*, doing_*, did_*.
 */
export function buildRegistrationPattern(hookName: string): RegExp {
	const escaped = hookName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(
		`(${CONSUMER_API_ALT})\\s*\\(\\s*['"]${escaped}['"]`,
		'g'
	);
}

export function getHookSearchQuery(hookName: string): string {
	return hookName;
}

export function extractHookFromSelection(
	documentText: string,
	lineNumber: number,
	selectedText: string
): HookInfo | null {
	if (!selectedText || selectedText.length < 2) return null;

	if (!HOOK_NAME_STATIC_TEST.test(selectedText)) return null;

	const lines = documentText.split('\n');
	if (lineNumber >= lines.length) return null;

	const searchRange = 5;
	const startLine = Math.max(0, lineNumber - searchRange);
	const endLine = Math.min(lines.length - 1, lineNumber + searchRange);

	for (let i = startLine; i <= endLine; i++) {
		const line = lines[i];
		const re = new RegExp(HOOK_CALL_REGEX.source, 'g');
		let match: RegExpExecArray | null;

		while ((match = re.exec(line)) !== null) {
			const funcName = match[1];
			const hookName = match[3];

			if (
				isOffsetInPhpComment(
					documentText,
					offsetAtLine(lines, i, match.index)
				)
			) {
				continue;
			}

			if (hookName === selectedText) {
				const side = getHookSide(funcName);
				const type = getHookType(funcName);
				if (side === null || type === null) continue;

				const quoteChar = match[2];
				const hookNameWithQuotes = quoteChar + hookName + quoteChar;
				const hookNameOffsetInMatch =
					match[0].indexOf(hookNameWithQuotes);
				const hookNameStart = match.index + hookNameOffsetInMatch + 1;
				const hookNameEnd = hookNameStart + hookName.length;

				return {
					name: hookName,
					type,
					side,
					func: funcName,
					isDynamic: isDynamicHook(hookName),
					range: {
						start: { line: i, character: hookNameStart },
						end: { line: i, character: hookNameEnd },
					},
				};
			}
		}
	}

	return null;
}
