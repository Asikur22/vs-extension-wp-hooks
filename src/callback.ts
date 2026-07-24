/**
 * Callback function navigation for WordPress hooks.
 * Finds the function/method specified as the 2nd parameter of add_ and remove_ hooks.
 *
 * Supports:
 * - Plain function / namespaced function strings
 * - Static method string and array forms (including FQCN)
 * - Instance [$this, method] and object [$obj, method] arrays
 * - PHP 8.1 first-class callables (Class::method(...), $obj->method(...))
 * - Closures and arrow functions (jump to the callable site)
 */
import * as vscode from 'vscode';
import { getExcludeGlob } from './config';
import { isOffsetInPhpComment, offsetAtLine } from './phpComment';

/** PHP class / namespace segment pattern (allows backslashes) */
const PHP_NAME = String.raw`(?:\\?[a-zA-Z_][\w]*)+`;
const PHP_IDENT = String.raw`[a-zA-Z_][\w]*`;
const HOOK_REG = String.raw`(?:add_action|add_filter|remove_action|remove_filter)`;

export interface CallbackInfo {
	/** Function or method name */
	name: string;
	/** Class FQCN or short name (null for plain functions / closures) */
	className: string | null;
	/** Last segment of className (for symbol matching) */
	shortClassName: string | null;
	/** Object variable for [$obj, 'method'], e.g. "$obj" or "$this->svc" */
	variableName: string | null;
	/** Whether this is an instance / object method */
	isInstanceMethod: boolean;
	/** Anonymous function / arrow function */
	isClosure: boolean;
	/** Closure location in the trigger document */
	closurePosition: { line: number; character: number } | null;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

function shortName(fqcn: string | null): string | null {
	if (!fqcn) return null;
	const cleaned = fqcn.replace(/^\\+/, '');
	const parts = cleaned.split('\\');
	return parts[parts.length - 1] || cleaned;
}

function makeRange(
	startLine: number,
	character = 0
): CallbackInfo['range'] {
	return {
		start: { line: startLine, character },
		end: { line: startLine, character },
	};
}

function lineOfOffset(text: string, offset: number, baseLine: number): number {
	return baseLine + text.substring(0, offset).split('\n').length - 1;
}

/**
 * Extract callback info from a document at the given position.
 * @param relaxed When true (context menu), accept any hook callback near the line
 *                even if the caret is on the hook name / function call.
 */
export function extractCallbackAtPosition(
	documentText: string,
	lineNumber: number,
	character: number,
	relaxed = false
): CallbackInfo | null {
	const lines = documentText.split('\n');
	if (lineNumber >= lines.length) return null;

	const searchRange = relaxed ? 15 : 10;
	const startLine = Math.max(0, lineNumber - searchRange);
	const endLine = Math.min(lines.length - 1, lineNumber + searchRange);
	const windowText = lines.slice(startLine, endLine + 1).join('\n');

	const cursorOffset =
		lines.slice(startLine, lineNumber).join('\n').length +
		character +
		(startLine < lineNumber ? 1 : 0);

	const tryMatch = (
		source: string,
		handler: (match: RegExpExecArray, absLine: number) => CallbackInfo
	): CallbackInfo | null => {
		const regex = new RegExp(source, 'g');
		let match: RegExpExecArray | null;
		let fallback: CallbackInfo | null = null;

		while ((match = regex.exec(windowText)) !== null) {
			const absLine = lineOfOffset(windowText, match.index, startLine);
			const info = handler(match, absLine);

			if (
				isCursorNearMatch(
					cursorOffset,
					match.index,
					match[0].length,
					relaxed ? 400 : 80
				)
			) {
				return info;
			}

			// Relaxed: prefer a match that touches the caret line
			if (
				relaxed &&
				absLine <= lineNumber &&
				lineOfOffset(
					windowText,
					match.index + match[0].length,
					startLine
				) >= lineNumber
			) {
				fallback = info;
			} else if (relaxed && !fallback && Math.abs(absLine - lineNumber) <= 2) {
				fallback = info;
			}
		}
		return fallback;
	};

	return matchAllCallbackForms(tryMatch);
}

/**
 * Run every supported callback pattern through tryMatch.
 */
function matchAllCallbackForms(
	tryMatch: (
		source: string,
		handler: (match: RegExpExecArray, absLine: number) => CallbackInfo
	) => CallbackInfo | null
): CallbackInfo | null {
	// Closures / arrow functions — navigate to the callable site
	{
		const hit = tryMatch(
			`${HOOK_REG}\\s*\\(\\s*['"][^'"]+['"]\\s*,\\s*(function|fn)\\s*\\(`,
			(match, absLine) => {
				const keyword = match[1];
				const kwOffsetInMatch = match[0].lastIndexOf(keyword);
				const lineStart = match.input.lastIndexOf('\n', match.index) + 1;
				const characterOnLine =
					match.index + kwOffsetInMatch - lineStart;
				return {
					name: keyword === 'fn' ? '<arrow>' : '<closure>',
					className: null,
					shortClassName: null,
					variableName: null,
					isInstanceMethod: false,
					isClosure: true,
					closurePosition: {
						line: absLine,
						character: Math.max(0, characterOnLine),
					},
					range: makeRange(absLine, Math.max(0, characterOnLine)),
				};
			}
		);
		if (hit) return hit;
	}

	// PHP 8.1 first-class: Class::method(...)
	{
		const hit = tryMatch(
			`${HOOK_REG}\\s*\\(\\s*['"][^'"]+['"]\\s*,\\s*(${PHP_NAME})::(${PHP_IDENT})\\s*\\(\\s*\\.\\.\\.\\s*\\)`,
			(match, absLine) => {
				const className = match[1];
				return {
					name: match[2],
					className,
					shortClassName: shortName(className),
					variableName: null,
					isInstanceMethod: false,
					isClosure: false,
					closurePosition: null,
					range: makeRange(absLine),
				};
			}
		);
		if (hit) return hit;
	}

	// PHP 8.1 first-class: $obj->method(...)
	{
		const hit = tryMatch(
			`${HOOK_REG}\\s*\\(\\s*['"][^'"]+['"]\\s*,\\s*(\\$[a-zA-Z_][\\w]*(?:->[a-zA-Z_][\\w]*)*)->(${PHP_IDENT})\\s*\\(\\s*\\.\\.\\.\\s*\\)`,
			(match, absLine) => ({
				name: match[2],
				className: null,
				shortClassName: null,
				variableName: match[1],
				isInstanceMethod: true,
				isClosure: false,
				closurePosition: null,
				range: makeRange(absLine),
			})
		);
		if (hit) return hit;
	}

	// PHP 8.1 first-class: plain_function(...)
	{
		const hit = tryMatch(
			`${HOOK_REG}\\s*\\(\\s*['"][^'"]+['"]\\s*,\\s*(${PHP_IDENT})\\s*\\(\\s*\\.\\.\\.\\s*\\)`,
			(match, absLine) => ({
				name: match[1],
				className: null,
				shortClassName: null,
				variableName: null,
				isInstanceMethod: false,
				isClosure: false,
				closurePosition: null,
				range: makeRange(absLine),
			})
		);
		if (hit) return hit;
	}

	// Static method string: 'Class::method' / FQCN
	{
		const hit = tryMatch(
			`${HOOK_REG}\\s*\\(\\s*['"][^'"]+['"]\\s*,\\s*['"](${PHP_NAME})::(${PHP_IDENT})['"]`,
			(match, absLine) => {
				const className = match[1];
				return {
					name: match[2],
					className,
					shortClassName: shortName(className),
					variableName: null,
					isInstanceMethod: false,
					isClosure: false,
					closurePosition: null,
					range: makeRange(absLine),
				};
			}
		);
		if (hit) return hit;
	}

	// Static method array: ['Class', 'method'] / array( 'Class', 'method' )
	{
		const hit = tryMatch(
			`${HOOK_REG}\\s*\\(\\s*['"][^'"]+['"]\\s*,\\s*(?:\\[|array\\s*\\()\\s*['"](${PHP_NAME})['"]\\s*,\\s*['"](${PHP_IDENT})['"]\\s*(?:\\]|\\))`,
			(match, absLine) => {
				const className = match[1];
				return {
					name: match[2],
					className,
					shortClassName: shortName(className),
					variableName: null,
					isInstanceMethod: false,
					isClosure: false,
					closurePosition: null,
					range: makeRange(absLine),
				};
			}
		);
		if (hit) return hit;
	}

	// Object / $this array: [$obj, 'method'] / array( $this, 'method' )
	{
		const hit = tryMatch(
			`${HOOK_REG}\\s*\\(\\s*['"][^'"]+['"]\\s*,\\s*(?:\\[|array\\s*\\()\\s*(\\$[a-zA-Z_][\\w]*(?:->[a-zA-Z_][\\w]*)*)\\s*,\\s*['"](${PHP_IDENT})['"]\\s*(?:\\]|\\))`,
			(match, absLine) => ({
				name: match[2],
				className: null,
				shortClassName: null,
				variableName: match[1],
				isInstanceMethod: true,
				isClosure: false,
				closurePosition: null,
				range: makeRange(absLine),
			})
		);
		if (hit) return hit;
	}

	// array( __CLASS__, 'method' ) / [ __CLASS__, 'method' ]
	{
		const hit = tryMatch(
			`${HOOK_REG}\\s*\\(\\s*['"][^'"]+['"]\\s*,\\s*(?:\\[|array\\s*\\()\\s*(?:__CLASS__|self::class|static::class)\\s*,\\s*['"](${PHP_IDENT})['"]\\s*(?:\\]|\\))`,
			(match, absLine) => ({
				name: match[1],
				className: null,
				shortClassName: null,
				variableName: '$this',
				isInstanceMethod: true,
				isClosure: false,
				closurePosition: null,
				range: makeRange(absLine),
			})
		);
		if (hit) return hit;
	}

	// Plain / namespaced function string
	{
		const hit = tryMatch(
			`${HOOK_REG}\\s*\\(\\s*['"][^'"]+['"]\\s*,\\s*['"](${PHP_NAME})['"]`,
			(match, absLine) => {
				const full = match[1];
				const isNamespaced = full.includes('\\');
				return {
					name: isNamespaced ? (shortName(full) ?? full) : full,
					className: null,
					shortClassName: null,
					variableName: null,
					isInstanceMethod: false,
					isClosure: false,
					closurePosition: null,
					range: makeRange(absLine),
				};
			}
		);
		if (hit) return hit;
	}

	return null;
}

function isCursorNearMatch(
	cursorOffset: number,
	matchStart: number,
	matchLength: number,
	pad = 80
): boolean {
	const matchEnd = matchStart + matchLength;
	return cursorOffset >= matchStart - pad && cursorOffset <= matchEnd + pad;
}

/**
 * Compare class names allowing FQCN vs short name.
 */
export function classNamesMatch(
	foundInFile: string,
	wanted: string
): boolean {
	const clean = (s: string) => s.replace(/^\\+/, '').replace(/\\+/g, '\\');
	const a = clean(foundInFile);
	const b = clean(wanted);
	if (a.toLowerCase() === b.toLowerCase()) return true;
	const shortWanted = b.includes('\\') ? b.split('\\').pop()! : b;
	return (
		a === shortWanted ||
		a.endsWith('\\' + shortWanted) ||
		a.split('\\').pop() === shortWanted
	);
}

/**
 * Find a callback function / method / closure definition.
 * Keeps work bounded so we do not stall Go to Definition / workspace symbols afterward.
 */
export async function findCallbackDefinition(
	callback: CallbackInfo,
	triggerDocument: vscode.TextDocument,
	token: vscode.CancellationToken
): Promise<vscode.Location[]> {
	try {
		if (token.isCancellationRequested) return [];

		// Closures: jump to the anonymous function in the current file
		if (callback.isClosure && callback.closurePosition) {
			return [
				new vscode.Location(
					triggerDocument.uri,
					new vscode.Position(
						callback.closurePosition.line,
						callback.closurePosition.character
					)
				),
			];
		}

		// Best-effort: resolve $obj → class from current file
		let className = callback.className;
		let shortClass = callback.shortClassName;
		if (
			!className &&
			callback.variableName &&
			callback.variableName !== '$this' &&
			!callback.variableName.startsWith('$this->')
		) {
			const resolved = resolveVariableClass(
				triggerDocument.getText(),
				callback.variableName
			);
			if (resolved) {
				className = resolved;
				shortClass = shortName(resolved);
			}
		}

		const enriched: CallbackInfo = {
			...callback,
			className,
			shortClassName: shortClass,
		};

		const locations: vscode.Location[] = [];

		// 1) Current file only via document symbols (avoid scanning every open doc —
		//    that was stalling other language features after Go to Callback).
		try {
			const symbols = await vscode.commands.executeCommand<
				vscode.DocumentSymbol[]
			>('vscode.executeDocumentSymbolProvider', triggerDocument.uri);
			if (symbols) {
				findSymbolInTree(
					symbols,
					enriched,
					triggerDocument.uri,
					locations
				);
			}
		} catch {
			// PHP language features may be unavailable; fall through to text search
		}
		if (locations.length > 0 || token.isCancellationRequested) {
			return locations;
		}

		// 2) Text search in the current file (fast, no language-server round-trips)
		const fs = await import('fs');
		const local = await searchFileForFunction(
			triggerDocument.uri,
			enriched,
			buildFunctionRegex(enriched.name),
			fs
		);
		if (local.length > 0) {
			const wantsClass = enriched.shortClassName || enriched.className;
			if (wantsClass) {
				return filterByClassName(local, wantsClass);
			}
			return local;
		}
		if (token.isCancellationRequested) return [];

		// 3) Bounded workspace text search
		return searchForFunctionDefinition(enriched, token);
	} catch (err) {
		console.error('WP Hooks: findCallbackDefinition failed', err);
		return [];
	}
}

function buildFunctionRegex(name: string): RegExp {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(
		`(?:public|private|protected|final|static|\\s)*function\\s+${escapedName}\\s*\\(`,
		'g'
	);
}

function findSymbolInTree(
	symbols: vscode.DocumentSymbol[],
	callback: CallbackInfo,
	uri: vscode.Uri,
	results: vscode.Location[],
	parentClass?: string
): void {
	for (const symbol of symbols) {
		const isType =
			symbol.kind === vscode.SymbolKind.Class ||
			symbol.kind === vscode.SymbolKind.Interface ||
			symbol.kind === vscode.SymbolKind.Struct; // traits often map to Class/Module

		const currentClass = isType ? symbol.name : parentClass;

		if (
			(symbol.kind === vscode.SymbolKind.Function ||
				symbol.kind === vscode.SymbolKind.Method) &&
			symbol.name === callback.name
		) {
			const wantsClass = callback.shortClassName || callback.className;
			if (
				!wantsClass ||
				(currentClass && classNamesMatch(currentClass, wantsClass))
			) {
				results.push(new vscode.Location(uri, symbol.range.start));
			} else if (
				callback.isInstanceMethod &&
				!callback.className &&
				(callback.variableName === '$this' ||
					callback.variableName?.startsWith('$this'))
			) {
				// $this→method: accept methods in any class in this file
				results.push(new vscode.Location(uri, symbol.range.start));
			}
		}

		if (symbol.children.length > 0) {
			findSymbolInTree(
				symbol.children,
				callback,
				uri,
				results,
				currentClass
			);
		}
	}
}

/**
 * Infer class of a variable from type hints / `new` in the same file.
 */
function resolveVariableClass(
	source: string,
	variableName: string
): string | null {
	const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	// Type hint: Namespace\Foo $obj  or  Foo $obj
	const hint = new RegExp(
		`(${PHP_NAME})\\s+${escaped}\\b`,
		'm'
	);
	const hintMatch = source.match(hint);
	if (hintMatch) {
		return hintMatch[1];
	}

	// Assignment: $obj = new Namespace\Foo  /  new Foo(
	const created = new RegExp(
		`${escaped}\\s*=\\s*new\\s+(${PHP_NAME})\\s*[;(]`,
		'm'
	);
	const createdMatch = source.match(created);
	if (createdMatch) {
		return createdMatch[1];
	}

	return null;
}

async function searchForFunctionDefinition(
	callback: CallbackInfo,
	token: vscode.CancellationToken
): Promise<vscode.Location[]> {
	const escapedName = callback.name.replace(
		/[.*+?^${}()|[\]\\]/g,
		'\\$&'
	);
	const regex = new RegExp(
		`(?:public|private|protected|final|static|\\s)*function\\s+${escapedName}\\s*\\(`,
		'g'
	);

	const files = await vscode.workspace.findFiles(
		'**/*.php',
		getExcludeGlob(),
		400
	);
	if (token.isCancellationRequested) return [];

	const fs = await import('fs');
	const locations: vscode.Location[] = [];
	const batchSize = 40;
	const maxHits = 25;

	for (let i = 0; i < files.length; i += batchSize) {
		if (token.isCancellationRequested || locations.length >= maxHits) {
			break;
		}
		const batch = files.slice(i, i + batchSize);
		const batchResults = await Promise.all(
			batch.map((fileUri) =>
				searchFileForFunction(fileUri, callback, regex, fs)
			)
		);
		for (const locs of batchResults) {
			locations.push(...locs);
			if (locations.length >= maxHits) break;
		}
	}

	const wantsClass = callback.shortClassName || callback.className;
	if (wantsClass && locations.length > 0) {
		return filterByClassName(locations, wantsClass);
	}

	return locations;
}

async function searchFileForFunction(
	fileUri: vscode.Uri,
	callback: CallbackInfo,
	regex: RegExp,
	fs: typeof import('fs')
): Promise<vscode.Location[]> {
	try {
		const content = await fs.promises.readFile(fileUri.fsPath, 'utf-8');
		if (!content.includes(callback.name)) return [];

		const locations: vscode.Location[] = [];
		const lines = content.split('\n');
		const lineRegex = new RegExp(regex.source, 'g');

		for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
			lineRegex.lastIndex = 0;
			const lineMatch = lineRegex.exec(lines[lineIdx]);
			if (!lineMatch) continue;

			const abs = offsetAtLine(lines, lineIdx, lineMatch.index);
			if (isOffsetInPhpComment(content, abs)) continue;

			locations.push(
				new vscode.Location(
					fileUri,
					new vscode.Position(lineIdx, lineMatch.index)
				)
			);
		}

		return locations;
	} catch {
		return [];
	}
}

async function filterByClassName(
	locations: vscode.Location[],
	className: string
): Promise<vscode.Location[]> {
	const filtered: vscode.Location[] = [];

	for (const loc of locations) {
		try {
			const fs = await import('fs');
			const content = await fs.promises.readFile(loc.uri.fsPath, 'utf-8');
			const lines = content.split('\n');
			const funcLine = loc.range.start.line;

			for (let i = funcLine; i >= Math.max(0, funcLine - 150); i--) {
				const classMatch = lines[i]?.match(
					/(?:class|abstract\s+class|final\s+class|trait|interface)\s+(\w+)/
				);
				if (classMatch) {
					if (classNamesMatch(classMatch[1], className)) {
						filtered.push(loc);
					}
					break;
				}
			}
		} catch {
			filtered.push(loc);
		}
	}

	return filtered.length > 0 ? filtered : locations;
}
