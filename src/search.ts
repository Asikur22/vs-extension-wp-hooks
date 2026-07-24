/**
 * Search engine for WordPress hook resolution.
 * Progressive, scoped search with early-stop and cancellable I/O.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import {
	HookInfo,
	HookSide,
	buildDefinitionPattern,
	buildRegistrationPattern,
	extractHookApiFromLine,
	getHookApiSortPriority,
} from './hooks';
import { HookCache } from './cache';
import { HookCatalog } from './hookCatalog';
import { getConfig, getExcludeGlob, ExtensionConfig } from './config';
import {
	isOffsetInPhpComment,
	isPositionInPhpComment,
} from './phpComment';
import { withHookScanProgress, scanMessage } from './scanProgress';
import { rememberCoreHookIfPath, isWpCorePath } from './wpCoreHooks';

export interface SearchResult {
	location: vscode.Location;
	snippet: string;
}

/** Cap Go to Definition / reference navigation results */
const MAX_DEFINITION_RESULTS = 50;
/** Cap hover occurrence list (still scans up to this many across the workspace) */
const MAX_HOVER_RESULTS = 25;

export interface HoverSearchResult {
	results: SearchResult[];
	/** Total matches found (before hover display cap) */
	totalFound: number;
	truncated: boolean;
}

/**
 * The main search engine. Performs lazy, scoped file searches for hook definitions.
 */
export class HookSearchEngine {
	private cache: HookCache;
	private catalog: HookCatalog | null = null;

	constructor(cache: HookCache, catalog?: HookCatalog) {
		this.cache = cache;
		this.catalog = catalog ?? null;
	}

	setCatalog(catalog: HookCatalog): void {
		this.catalog = catalog;
	}

	/** True while a full workspace scan / rescan is in progress. */
	isScanning(): boolean {
		return this.catalog?.isScanning() ?? false;
	}

	/** True when the hook index can answer lookups (including progressive ready). */
	isIndexReady(): boolean {
		return this.catalog?.isReady() ?? false;
	}

	/**
	 * Resolve hook definition / reference locations.
	 * Prefers the workspace index when ready; otherwise live search.
	 */
	async resolveDefinition(
		hook: HookInfo,
		triggerDocument: vscode.TextDocument,
		token: vscode.CancellationToken
	): Promise<vscode.Location[]> {
		try {
			return await this.resolveLocations(
				hook,
				triggerDocument,
				token,
				MAX_DEFINITION_RESULTS,
				false
			);
		} catch (err) {
			console.error('WP Hooks: resolveDefinition failed', err);
			return [];
		}
	}

	/**
	 * Prefer indexed definition sites for hover meta (origin / PHPDoc).
	 */
	getPrimaryDefinitionLocation(
		hookName: string
	): vscode.Location | undefined {
		try {
			if (!this.catalog?.isReady()) {
				return undefined;
			}
			const locs = this.catalog.getLocations(hookName, true, 25);
			if (locs.length === 0) {
				return undefined;
			}
			const core = locs.find((l) => isWpCorePath(l.uri.fsPath));
			return core ?? locs[0];
		} catch (err) {
			console.error('WP Hooks: getPrimaryDefinitionLocation failed', err);
			return undefined;
		}
	}

	/**
	 * Resolve hover snippets — full workspace accumulation, then format as snippets.
	 */
	async resolveHover(
		hook: HookInfo,
		triggerDocument: vscode.TextDocument,
		token: vscode.CancellationToken
	): Promise<HoverSearchResult> {
		const empty: HoverSearchResult = {
			results: [],
			totalFound: 0,
			truncated: false,
		};
		if (token.isCancellationRequested) return empty;

		try {
			const locations = await this.resolveLocations(
				hook,
				triggerDocument,
				token,
				MAX_DEFINITION_RESULTS,
				false
			);
			if (locations.length === 0 || token.isCancellationRequested) {
				return empty;
			}

			const show = locations.slice(0, MAX_HOVER_RESULTS);
			return {
				results: await this.locationsToSnippets(show),
				totalFound: locations.length,
				truncated:
					locations.length > MAX_HOVER_RESULTS ||
					locations.length >= MAX_DEFINITION_RESULTS,
			};
		} catch (err) {
			console.error('WP Hooks: resolveHover failed', err);
			return empty;
		}
	}

	/**
	 * Shared location resolver used by F12 and hover.
	 */
	private async resolveLocations(
		hook: HookInfo,
		triggerDocument: vscode.TextDocument,
		token: vscode.CancellationToken,
		limit: number,
		showProgress: boolean
	): Promise<vscode.Location[]> {
		if (token.isCancellationRequested || limit <= 0) return [];

		const config = getConfig();
		const cacheKey = `${hook.side}:${hook.name}`;
		const isSearchingDefinitions = hook.side === HookSide.Registration;

		const cached = this.cache.get(cacheKey);
		if (cached && cached.length > 0) {
			return this.cache.toVscLocations(cached).slice(0, limit);
		}

		// Prefer pre-built workspace index when it has matches; otherwise live-search.
		// (Never treat "ready + 0 hits" as final — index can be incomplete after errors.)
		if (this.catalog?.isReady()) {
			const indexed = this.catalog.getLocations(
				hook.name,
				isSearchingDefinitions,
				limit
			);
			if (indexed.length > 0) {
				if (isSearchingDefinitions) {
					for (const loc of indexed) {
						rememberCoreHookIfPath(hook.name, loc.uri.fsPath);
					}
				}
				this.cache.set(cacheKey, this.cache.fromVscLocations(indexed));
				return indexed;
			}
		}

		const pattern = isSearchingDefinitions
			? buildDefinitionPattern(hook.name)
			: buildRegistrationPattern(hook.name);

		const seen = new Set<string>();
		const results: vscode.Location[] = [];

		const merge = (locs: vscode.Location[]): boolean => {
			for (const loc of locs) {
				const key = `${loc.uri.toString()}:${loc.range.start.line}:${loc.range.start.character}`;
				if (seen.has(key)) continue;
				seen.add(key);
				results.push(loc);
				if (results.length >= limit) return true;
			}
			return false;
		};

		if (merge(this.searchInDocument(triggerDocument, pattern))) {
			return this.finalizeLocations(
				results,
				cacheKey,
				hook.name,
				isSearchingDefinitions,
				token,
				limit
			);
		}
		if (token.isCancellationRequested) return [];

		if (merge(this.searchOpenDocuments(pattern, triggerDocument.uri))) {
			return this.finalizeLocations(
				results,
				cacheKey,
				hook.name,
				isSearchingDefinitions,
				token,
				limit
			);
		}
		if (token.isCancellationRequested) return [];

		const runWorkspace = async (
			progress: { report(value: { message?: string }): void } | undefined,
			scanToken: vscode.CancellationToken
		): Promise<void> => {
			progress?.report({
				message: scanMessage('Workspace', hook.name),
			});
			if (results.length >= limit || scanToken.isCancellationRequested) {
				return;
			}

			let locs = await this.searchWorkspace(
				hook.name,
				pattern,
				scanToken,
				limit,
				progress
			);
			merge(locs);

			if (
				results.length < limit &&
				config.externalPaths.length > 0 &&
				!scanToken.isCancellationRequested
			) {
				progress?.report({
					message: scanMessage('External paths', hook.name),
				});
				locs = await this.searchExternalPaths(
					hook.name,
					pattern,
					config,
					scanToken,
					limit,
					progress
				);
				merge(locs);
			}
		};

		if (showProgress) {
			await withHookScanProgress(
				{
					message: scanMessage('Scanning', hook.name),
					token,
				},
				async (progress, scanToken) => {
					await runWorkspace(progress, scanToken);
				}
			);
		} else {
			await runWorkspace(undefined, token);
		}

		if (token.isCancellationRequested) return results.slice(0, limit);
		return this.finalizeLocations(
			results,
			cacheKey,
			hook.name,
			isSearchingDefinitions,
			token,
			limit
		);
	}

	private async finalizeLocations(
		results: vscode.Location[],
		cacheKey: string,
		hookName: string,
		isSearchingDefinitions: boolean,
		token: vscode.CancellationToken,
		limit: number
	): Promise<vscode.Location[]> {
		let cleaned = await this.excludeCommentLocations(results, token);
		cleaned = await this.sortLocationsByApiPriority(
			cleaned,
			hookName,
			token
		);
		if (cleaned.length > limit) {
			cleaned = cleaned.slice(0, limit);
		}
		if (isSearchingDefinitions) {
			for (const loc of cleaned) {
				rememberCoreHookIfPath(hookName, loc.uri.fsPath);
			}
		}
		if (cleaned.length > 0) {
			this.cache.set(cacheKey, this.cache.fromVscLocations(cleaned));
		}
		return cleaned;
	}

	/**
	 * Order: add_* → doing_* → did_* → has_* → remove_* → definitions → other,
	 * then by path and line for stability.
	 */
	private async sortLocationsByApiPriority(
		locations: vscode.Location[],
		hookName: string,
		token: vscode.CancellationToken
	): Promise<vscode.Location[]> {
		if (locations.length <= 1) return locations;

		const contentCache = new Map<string, string>();
		const scored: Array<{
			loc: vscode.Location;
			priority: number;
			path: string;
			line: number;
		}> = [];

		for (const loc of locations) {
			if (token.isCancellationRequested) break;

			const key = loc.uri.toString();
			let content = contentCache.get(key);
			if (content === undefined) {
				try {
					const openDoc = vscode.workspace.textDocuments.find(
						(d) => d.uri.toString() === key
					);
					content = openDoc
						? openDoc.getText()
						: await fs.promises.readFile(loc.uri.fsPath, 'utf-8');
					contentCache.set(key, content);
				} catch {
					content = '';
					contentCache.set(key, content);
				}
			}

			const lines = content.split('\n');
			const lineText = lines[loc.range.start.line] ?? '';
			const api = extractHookApiFromLine(lineText, hookName);
			scored.push({
				loc,
				priority: api ? getHookApiSortPriority(api) : 50,
				path: loc.uri.fsPath,
				line: loc.range.start.line,
			});
		}

		scored.sort((a, b) => {
			if (a.priority !== b.priority) return a.priority - b.priority;
			const pathCmp = a.path.localeCompare(b.path);
			if (pathCmp !== 0) return pathCmp;
			return a.line - b.line;
		});

		return scored.map((s) => s.loc);
	}

	// ─── Private Search Helpers ─────────────────────────────────────

	private searchInDocument(
		document: vscode.TextDocument,
		pattern: RegExp
	): vscode.Location[] {
		const text = document.getText();
		const locations: vscode.Location[] = [];
		const re = new RegExp(pattern.source, 'g');

		let match: RegExpExecArray | null;
		while ((match = re.exec(text)) !== null) {
			if (isOffsetInPhpComment(text, match.index)) continue;
			locations.push(
				new vscode.Location(document.uri, document.positionAt(match.index))
			);
		}

		return locations;
	}

	/**
	 * Search all open PHP text documents (including hidden tabs).
	 */
	private searchOpenDocuments(
		pattern: RegExp,
		excludeUri?: vscode.Uri
	): vscode.Location[] {
		const locations: vscode.Location[] = [];
		const exclude = excludeUri?.toString();

		for (const doc of vscode.workspace.textDocuments) {
			if (!this.isPhpFile(doc)) continue;
			if (exclude && doc.uri.toString() === exclude) continue;
			locations.push(...this.searchInDocument(doc, pattern));
		}

		return locations;
	}

	/**
	 * Workspace search: prefer findTextInFiles (ripgrep), fall back to findFiles + fs.
	 * Stops early once `limit` matches are found.
	 */
	private async searchWorkspace(
		hookName: string,
		pattern: RegExp,
		token: vscode.CancellationToken,
		limit: number,
		progress?: { report(value: { message?: string }): void }
	): Promise<vscode.Location[]> {
		progress?.report({ message: scanMessage('Searching', hookName) });

		const viaTextSearch = await this.searchViaFindTextInFiles(
			hookName,
			pattern,
			token,
			limit
		);
		if (viaTextSearch !== null) {
			return viaTextSearch;
		}

		progress?.report({
			message: scanMessage('Listing PHP files', hookName),
		});

		const files = await vscode.workspace.findFiles(
			'**/*.php',
			getExcludeGlob()
		);
		if (token.isCancellationRequested) return [];

		progress?.report({
			message: scanMessage(String(files.length) + ' files', hookName),
		});
		return this.fastSearchFiles(
			files,
			hookName,
			pattern,
			token,
			limit,
			progress
		);
	}

	/**
	 * Use VS Code's ripgrep-backed text search when available.
	 * Returns null if the API fails so callers can fall back.
	 */
	private async searchViaFindTextInFiles(
		hookName: string,
		pattern: RegExp,
		token: vscode.CancellationToken,
		limit: number
	): Promise<vscode.Location[] | null> {
		// findTextInFiles is available at runtime; typings vary by @types/vscode version
		const ws = vscode.workspace as unknown as {
			findTextInFiles?: (
				query: {
					pattern: string;
					isRegExp?: boolean;
					isCaseSensitive?: boolean;
					isWordMatch?: boolean;
				},
				options: {
					include?: string;
					exclude?: string;
					maxResults?: number;
					useIgnoreFiles?: boolean;
				},
				callback: (result: {
					uri?: vscode.Uri;
					ranges?: Array<vscode.Range | vscode.Range[]>;
				}) => void,
				token?: vscode.CancellationToken
			) => Thenable<unknown>;
		};

		if (typeof ws.findTextInFiles !== 'function') {
			return null;
		}

		const locations: vscode.Location[] = [];

		try {
			await ws.findTextInFiles(
				{
					pattern: hookName,
					isRegExp: false,
					isCaseSensitive: true,
					isWordMatch: false,
				},
				{
					include: '**/*.php',
					exclude: getExcludeGlob(),
					maxResults: undefined,
					// WP plugins are often gitignored — still search them for hooks
					useIgnoreFiles: false,
				},
				(result) => {
					if (token.isCancellationRequested) return;
					if (locations.length >= limit) return;
					if (!result.uri || !result.ranges?.length) return;

					const first = result.ranges[0];
					const range = Array.isArray(first) ? first[0] : first;
					if (!range) return;

					locations.push(new vscode.Location(result.uri, range.start));
				},
				token
			);
		} catch {
			return null;
		}

		if (token.isCancellationRequested) return locations;

		return this.verifyLocations(locations, hookName, pattern, token, limit);
	}

	/**
	 * Re-check candidate locations against the hook-call regex and skip comments.
	 */
	private async verifyLocations(
		candidates: vscode.Location[],
		hookName: string,
		pattern: RegExp,
		token: vscode.CancellationToken,
		limit: number
	): Promise<vscode.Location[]> {
		const verified: vscode.Location[] = [];
		const contentCache = new Map<string, string>();

		for (const loc of candidates) {
			if (token.isCancellationRequested || verified.length >= limit) break;

			const key = loc.uri.toString();
			let content = contentCache.get(key);
			if (content === undefined) {
				try {
					const openDoc = vscode.workspace.textDocuments.find(
						(d) => d.uri.toString() === key
					);
					content = openDoc
						? openDoc.getText()
						: await fs.promises.readFile(loc.uri.fsPath, 'utf-8');
					contentCache.set(key, content);
				} catch {
					continue;
				}
			}

			if (!content.includes(hookName)) continue;

			// Match across the whole file so multi-line do_action( \n 'hook' ) works
			const re = new RegExp(pattern.source, 'g');
			let match: RegExpExecArray | null;
			let matched = false;
			while ((match = re.exec(content)) !== null) {
				if (isOffsetInPhpComment(content, match.index)) continue;
				const pos = positionFromOffset(content, match.index);
				verified.push(new vscode.Location(loc.uri, pos));
				matched = true;
				break;
			}
			if (!matched) continue;
		}

		return verified;
	}

	private async fastSearchFiles(
		files: vscode.Uri[],
		hookName: string,
		pattern: RegExp,
		token: vscode.CancellationToken,
		limit: number,
		progress?: { report(value: { message?: string }): void }
	): Promise<vscode.Location[]> {
		const locations: vscode.Location[] = [];
		const batchSize = 50;
		const total = files.length;

		for (let i = 0; i < files.length; i += batchSize) {
			if (token.isCancellationRequested || locations.length >= limit) break;

			const scanned = Math.min(i + batchSize, total);
			progress?.report({
				message: scanMessage(
					`Scanning ${scanned}/${total}`,
					hookName
				),
			});

			const batch = files.slice(i, i + batchSize);
			const batchResults = await Promise.all(
				batch.map((fileUri) =>
					this.searchFileFast(
						fileUri,
						hookName,
						pattern,
						limit - locations.length
					)
				)
			);

			for (const locs of batchResults) {
				locations.push(...locs);
				if (locations.length >= limit) {
					return locations.slice(0, limit);
				}
			}
		}

		return locations;
	}

	/**
	 * Search a single file using fs.readFile.
	 * Compiles the regex once per file (not per line).
	 */
	private async searchFileFast(
		fileUri: vscode.Uri,
		hookName: string,
		pattern: RegExp,
		limit: number
	): Promise<vscode.Location[]> {
		if (limit <= 0) return [];

		try {
			const content = await fs.promises.readFile(fileUri.fsPath, 'utf-8');
			if (!content.includes(hookName)) return [];

			const locations: vscode.Location[] = [];
			// Full-file match so multi-line calls (common in Elementor) are found
			const re = new RegExp(pattern.source, 'g');
			let match: RegExpExecArray | null;

			while ((match = re.exec(content)) !== null) {
				if (locations.length >= limit) break;
				if (isOffsetInPhpComment(content, match.index)) continue;

				locations.push(
					new vscode.Location(
						fileUri,
						positionFromOffset(content, match.index)
					)
				);
			}

			return locations;
		} catch {
			return [];
		}
	}

	private async searchExternalPaths(
		hookName: string,
		pattern: RegExp,
		config: ExtensionConfig,
		token: vscode.CancellationToken,
		limit: number,
		progress?: { report(value: { message?: string }): void }
	): Promise<vscode.Location[]> {
		const files: vscode.Uri[] = [];

		for (const extPath of config.externalPaths) {
			if (token.isCancellationRequested) break;
			progress?.report({
				message: scanMessage('External path', extPath),
			});
			const base = vscode.Uri.file(extPath);
			const found = await vscode.workspace.findFiles(
				new vscode.RelativePattern(base, '**/*.php')
			);
			files.push(...found);
		}

		if (token.isCancellationRequested) return [];

		return this.fastSearchFiles(
			files,
			hookName,
			pattern,
			token,
			limit,
			progress
		);
	}

	async searchForFunctionByName(
		funcName: string,
		triggerDocument: vscode.TextDocument,
		token: vscode.CancellationToken
	): Promise<vscode.Location[]> {
		if (token.isCancellationRequested) return [];

		const funcRegex = new RegExp(`function\\s+${funcName}\\s*\\(`, 'g');
		const locations: vscode.Location[] = [];

		const text = triggerDocument.getText();
		let match: RegExpExecArray | null;
		while ((match = funcRegex.exec(text)) !== null) {
			if (isOffsetInPhpComment(text, match.index)) continue;
			locations.push(
				new vscode.Location(
					triggerDocument.uri,
					triggerDocument.positionAt(match.index)
				)
			);
		}
		if (locations.length > 0) return locations;

		for (const doc of vscode.workspace.textDocuments) {
			if (!this.isPhpFile(doc)) continue;
			if (doc.uri.toString() === triggerDocument.uri.toString()) continue;

			const docText = doc.getText();
			funcRegex.lastIndex = 0;
			while ((match = funcRegex.exec(docText)) !== null) {
				if (isOffsetInPhpComment(docText, match.index)) continue;
				locations.push(
					new vscode.Location(doc.uri, doc.positionAt(match.index))
				);
			}
		}
		if (locations.length > 0) return locations;

		const files = await vscode.workspace.findFiles(
			'**/*.php',
			getExcludeGlob()
		);
		if (token.isCancellationRequested) return [];

		const funcSearchRegex = new RegExp(`function\\s+${funcName}\\s*\\(`, 'g');
		return this.fastSearchFiles(
			files,
			funcName,
			funcSearchRegex,
			token,
			MAX_DEFINITION_RESULTS
		);
	}

	private async locationsToSnippets(
		locations: vscode.Location[]
	): Promise<SearchResult[]> {
		const results: SearchResult[] = [];
		const contentCache = new Map<string, string>();

		for (const loc of locations) {
			try {
				const key = loc.uri.toString();
				let content = contentCache.get(key);
				if (content === undefined) {
					const openDoc = vscode.workspace.textDocuments.find(
						(d) => d.uri.toString() === key
					);
					content = openDoc
						? openDoc.getText()
						: await fs.promises.readFile(loc.uri.fsPath, 'utf-8');
					contentCache.set(key, content);
				}
				const snippet = this.buildSingleLineSnippet(
					content,
					loc.range.start.line,
					loc.range.start.character
				);
				results.push({ location: loc, snippet });
			} catch {
				continue;
			}
		}

		return results;
	}

	/**
	 * Build a one-line hover snippet: pull the call (across lines if needed)
	 * and collapse all whitespace/newlines to single spaces.
	 */
	private buildSingleLineSnippet(
		content: string,
		startLine: number,
		startCharacter: number
	): string {
		const lines = content.split(/\r?\n/);
		if (startLine < 0 || startLine >= lines.length) {
			return '';
		}

		const maxExtraLines = 12;
		const endLine = Math.min(lines.length - 1, startLine + maxExtraLines);
		let chunk = lines[startLine].slice(Math.max(0, startCharacter));
		for (let i = startLine + 1; i <= endLine; i++) {
			chunk += '\n' + lines[i];
		}

		const statement = this.slicePhpCall(chunk);
		return this.truncateSnippet(flattenToSingleLine(statement));
	}

	/** Truncate at the end of the hook call (balanced parens), or at `?>`. */
	private slicePhpCall(text: string): string {
		let depth = 0;
		let started = false;
		let inSingle = false;
		let inDouble = false;
		let escaped = false;

		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			const next = i + 1 < text.length ? text[i + 1] : '';

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

			// Stop before template HTML (close PHP tag)
			if (ch === '?' && next === '>') {
				return text.slice(0, i).trimEnd();
			}

			if (ch === '(') {
				depth++;
				started = true;
			} else if (ch === ')') {
				depth = Math.max(0, depth - 1);
				// End of the outermost hook call — do not include trailing HTML / PHP
				if (started && depth === 0) {
					return text.slice(0, i + 1);
				}
			} else if (ch === ';' && started && depth === 0) {
				return text.slice(0, i + 1);
			}
		}

		return text;
	}

	private async excludeCommentLocations(
		locations: vscode.Location[],
		token: vscode.CancellationToken
	): Promise<vscode.Location[]> {
		if (locations.length === 0) return locations;

		const byFile = new Map<string, vscode.Location[]>();
		for (const loc of locations) {
			const key = loc.uri.toString();
			const list = byFile.get(key) ?? [];
			list.push(loc);
			byFile.set(key, list);
		}

		const kept: vscode.Location[] = [];

		for (const [uriStr, locs] of byFile) {
			if (token.isCancellationRequested) break;

			let content: string;
			try {
				const openDoc = vscode.workspace.textDocuments.find(
					(d) => d.uri.toString() === uriStr
				);
				content = openDoc
					? openDoc.getText()
					: await fs.promises.readFile(locs[0].uri.fsPath, 'utf-8');
			} catch {
				continue;
			}

			for (const loc of locs) {
				if (
					!isPositionInPhpComment(
						content,
						loc.range.start.line,
						loc.range.start.character
					)
				) {
					kept.push(loc);
				}
			}
		}

		return kept;
	}

	private isPhpFile(doc: vscode.TextDocument): boolean {
		return doc.languageId === 'php' || doc.fileName.endsWith('.php');
	}

	private truncateSnippet(text: string, maxLen = 120): string {
		if (text.length <= maxLen) return text;
		return text.substring(0, maxLen) + '…';
	}
}

/** Convert a string offset to a VS Code position. */
function positionFromOffset(content: string, offset: number): vscode.Position {
	const before = content.slice(0, Math.max(0, offset));
	const lines = before.split('\n');
	const line = lines.length - 1;
	const character = lines[line]?.length ?? 0;
	return new vscode.Position(line, character);
}

/** Collapse all whitespace (including newlines) to single spaces; drop HTML after `?>`. */
export function flattenToSingleLine(text: string): string {
	const phpEnd = text.search(/\?>/);
	const cut = phpEnd === -1 ? text : text.slice(0, phpEnd);
	return cut.replace(/\s+/g, ' ').trim();
}
