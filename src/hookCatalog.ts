/**
 * Workspace-wide hook index.
 * Full scan on startup (status bar); lookups use the index;
 * PHP file changes reindex only that file.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import {
	ACTION_API_FUNCS,
	HOOK_API_ALT,
	HookSide,
	HookType,
	getHookApiSortPriority,
	getHookSide,
	isDynamicHook,
} from './hooks';
import { getConfig, getExcludeGlob, isExcludedPath } from './config';
import {
	buildLineStarts,
	createAscendingCommentChecker,
	offsetToLineCharacter,
} from './phpComment';
import {
	clearCoreHookRegistry,
	rememberCoreHookIfPath,
} from './wpCoreHooks';
import { clearHookDocCache } from './hookDocblock';

/** Extract static hook names from WP hook API calls (allows newline after `(`). */
const HOOK_NAME_REGEX = new RegExp(
	`(${HOOK_API_ALT})\\s*\\(\\s*(['"])([^'"$\\n]+)\\2`,
	'g'
);

export interface HookCatalogEntry {
	name: string;
	type: HookType;
	count: number;
	uri: string;
	line: number;
	character: number;
	isDefinition: boolean;
}

export interface IndexedOccurrence {
	name: string;
	func: string;
	type: HookType;
	side: HookSide;
	uri: string;
	line: number;
	character: number;
}

export type IndexReadyListener = (ready: boolean) => void;

export class HookCatalog {
	/** hook name → all occurrences */
	private byName = new Map<string, IndexedOccurrence[]>();
	/** file uri → hook names present in that file */
	private byFile = new Map<string, Set<string>>();

	private ready = false;
	private scanning = false;
	private scanGeneration = 0;
	private initialScan: Promise<void> | null = null;

	private statusBar: vscode.StatusBarItem;
	private readonly readyListeners = new Set<IndexReadyListener>();
	/** Cached completion/symbol entries; invalidated on index mutation. */
	private entriesCache: HookCatalogEntry[] | null = null;
	/** True after first progressive ready notify during a full scan. */
	private progressiveReadyNotified = false;

	constructor() {
		this.statusBar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			50
		);
		this.statusBar.command = 'wpHooks.rescanWorkspace';
		this.statusBar.tooltip = 'WP Hooks — click to rescan workspace';
		this.statusBar.text = '$(sync) WP Hooks';
		this.statusBar.show();
	}

	dispose(): void {
		this.scanGeneration++;
		this.scanning = false;
		this.initialScan = null;
		this.clearIndex();
		this.ready = false;
		this.statusBar.dispose();
		this.readyListeners.clear();
	}

	onReadyChange(listener: IndexReadyListener): vscode.Disposable {
		this.readyListeners.add(listener);
		return new vscode.Disposable(() => this.readyListeners.delete(listener));
	}

	isReady(): boolean {
		return this.ready;
	}

	isScanning(): boolean {
		return this.scanning;
	}

	getHookCount(): number {
		return this.byName.size;
	}

	getOccurrenceCount(): number {
		let n = 0;
		for (const list of this.byName.values()) {
			n += list.length;
		}
		return n;
	}

	/**
	 * Start (or await) the initial full workspace scan. Safe to call multiple times.
	 */
	startInitialScan(): Promise<void> {
		if (this.ready && !this.scanning) {
			return Promise.resolve();
		}
		if (this.initialScan) {
			return this.initialScan;
		}
		this.initialScan = this.runFullScan().finally(() => {
			this.initialScan = null;
		});
		return this.initialScan;
	}

	/**
	 * Force a full rescan (status-bar command).
	 */
	async rescan(): Promise<void> {
		this.initialScan = null;
		await this.runFullScan();
	}

	/**
	 * Snapshot of current index entries (never waits for a full scan).
	 * Safe for Cmd/Ctrl+T — VS Code cancels providers that block too long.
	 */
	getHooksSnapshot(): HookCatalogEntry[] {
		return this.buildCatalogEntries();
	}

	/**
	 * Entries for completion / workspace symbols (derived from the index).
	 * Does not block on a long workspace scan when a cancellation token is provided.
	 */
	async getHooks(token?: vscode.CancellationToken): Promise<HookCatalogEntry[]> {
		if (this.ready) {
			return this.buildCatalogEntries();
		}

		// Kick off scan if needed, but do not block cancellable callers (symbols / completion)
		if (!this.scanning && !this.initialScan) {
			void this.startInitialScan();
		}

		if (token) {
			// Return whatever is indexed so far; caller can retry after scan finishes
			if (token.isCancellationRequested) {
				return this.buildCatalogEntries();
			}
			if (this.initialScan) {
				await Promise.race([
					this.initialScan,
					new Promise<void>((resolve) => {
						const sub = token.onCancellationRequested(() => {
							sub.dispose();
							resolve();
						});
					}),
				]);
			}
			return this.buildCatalogEntries();
		}

		// No token (internal callers): wait for a complete index
		if (this.initialScan) {
			await this.initialScan;
		} else {
			await this.startInitialScan();
		}
		return this.buildCatalogEntries();
	}

	/**
	 * Locations for a hook from the index.
	 * @param wantDefinitions true when navigating from add_* toward definitions
	 */
	getLocations(
		hookName: string,
		wantDefinitions: boolean,
		limit: number
	): vscode.Location[] {
		const list = this.byName.get(hookName);
		if (!list || list.length === 0) {
			return [];
		}

		const filtered = list.filter((o) =>
			wantDefinitions
				? o.side === HookSide.Definition
				: o.side === HookSide.Registration
		);

		const sorted = [...filtered].sort((a, b) => {
			const pa = getHookApiSortPriority(a.func);
			const pb = getHookApiSortPriority(b.func);
			if (pa !== pb) return pa - pb;
			const pathCmp = a.uri.localeCompare(b.uri);
			if (pathCmp !== 0) return pathCmp;
			return a.line - b.line;
		});

		return sorted.slice(0, limit).map(
			(o) =>
				new vscode.Location(
					vscode.Uri.parse(o.uri),
					new vscode.Position(o.line, o.character)
				)
		);
	}

	/** True if this hook name appears anywhere in the index. */
	hasHook(hookName: string): boolean {
		return this.byName.has(hookName);
	}

	/**
	 * Drop entire index (e.g. config change). Aborts in-flight scan and starts fresh.
	 */
	invalidate(): void {
		this.scanGeneration++;
		this.initialScan = null;
		this.scanning = false;
		this.clearIndex();
		this.ready = false;
		clearCoreHookRegistry();
		clearHookDocCache();
		this.notifyReady(false);
		this.updateStatusBarIdle();
		void this.startInitialScan();
	}

	/**
	 * Incrementally reindex one PHP file (or remove it if deleted).
	 */
	async reindexFile(uri: vscode.Uri, deleted = false): Promise<string[]> {
		if (isExcludedPath(uri.fsPath)) {
			return [];
		}

		const affected = this.removeFileFromIndex(uri.toString());

		if (!deleted) {
			try {
				const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
				const found = this.collectFromContent(content, uri);
				for (const name of found) {
					affected.add(name);
				}
			} catch {
				// unreadable / deleted between events
			}
		}

		this.refreshCoreHooksFromIndex();
		clearHookDocCache();
		if (this.ready || this.getHookCount() > 0) {
			this.ready = true;
			this.updateStatusBarReady();
		}
		return [...affected];
	}

	private async runFullScan(): Promise<void> {
		const generation = ++this.scanGeneration;
		this.scanning = true;
		this.ready = false;
		this.notifyReady(false);
		this.clearIndex();
		clearCoreHookRegistry();
		clearHookDocCache();

		this.statusBar.text = '$(sync~spin) WP Hooks: Scanning…';

		try {
			const config = getConfig();
			const workspaceFiles = await vscode.workspace.findFiles(
				'**/*.php',
				getExcludeGlob()
			);

			if (generation !== this.scanGeneration) return;

			const externalFiles: vscode.Uri[] = [];
			for (const extPath of config.externalPaths) {
				if (generation !== this.scanGeneration) return;
				const base = vscode.Uri.file(extPath);
				const found = await vscode.workspace.findFiles(
					new vscode.RelativePattern(base, '**/*.php')
				);
				externalFiles.push(...found);
			}

			const files = [...workspaceFiles, ...externalFiles];
			const batchSize = 100;
			const total = files.length;
			this.progressiveReadyNotified = false;

			for (let i = 0; i < files.length; i += batchSize) {
				if (generation !== this.scanGeneration) return;

				const scanned = Math.min(i + batchSize, total);
				this.statusBar.text = `$(sync~spin) WP Hooks: ${scanned}/${total}`;

				const batch = files.slice(i, i + batchSize);
				await Promise.all(
					batch.map(async (uri) => {
						try {
							const content = await fs.promises.readFile(
								uri.fsPath,
								'utf-8'
							);
							this.collectFromContent(content, uri);
						} catch {
							// skip
						}
					})
				);

				// Progressive ready: allow index lookups while scan continues.
				// Do not notify listeners yet (avoids clearing lookup cache mid-use).
				if (
					!this.progressiveReadyNotified &&
					this.getHookCount() > 0
				) {
					this.entriesCache = null;
					this.ready = true;
					this.progressiveReadyNotified = true;
				}
			}

			if (generation !== this.scanGeneration) return;

			this.entriesCache = null;
			this.ready = true;
			this.scanning = false;
			this.notifyReady(true);
			this.updateStatusBarReady();

			vscode.window.setStatusBarMessage(
				`WP Hooks: indexed ${this.getHookCount()} hooks (${this.getOccurrenceCount()} occurrences)`,
				4000
			);
		} catch (err) {
			console.error('WP Hooks scan failed', err);
			// Recover: keep partial index if we got any hooks before the failure
			const hasHooks = this.getHookCount() > 0;
			this.ready = hasHooks;
			this.scanning = false;
			this.notifyReady(hasHooks);
			if (hasHooks) {
				this.updateStatusBarReady();
				this.statusBar.text = `$(warning) WP Hooks: ${this.getHookCount().toLocaleString()} (scan error)`;
				this.statusBar.tooltip =
					'WP Hooks — scan hit an error; showing partial index. Click to rescan.';
			} else {
				this.statusBar.text = '$(warning) WP Hooks: Scan failed — click to retry';
				this.statusBar.tooltip =
					'WP Hooks — indexing failed. Click to rescan, or use Go to Definition (live search).';
			}
		} finally {
			if (generation === this.scanGeneration) {
				this.scanning = false;
				// Never leave the bar stuck on "Scanning…" after an abort/error
				if (!this.ready && this.getHookCount() === 0) {
					this.statusBar.text = '$(warning) WP Hooks: Click to rescan';
				} else if (this.ready) {
					this.updateStatusBarReady();
				}
			}
		}
	}

	private clearIndex(): void {
		this.byName.clear();
		this.byFile.clear();
		this.entriesCache = null;
	}

	private removeFileFromIndex(uriStr: string): Set<string> {
		const names = this.byFile.get(uriStr);
		const affected = new Set<string>();
		if (!names) {
			return affected;
		}
		this.entriesCache = null;

		for (const name of names) {
			affected.add(name);
			const list = this.byName.get(name);
			if (!list) continue;
			const next = list.filter((o) => o.uri !== uriStr);
			if (next.length === 0) {
				this.byName.delete(name);
			} else {
				this.byName.set(name, next);
			}
		}
		this.byFile.delete(uriStr);
		return affected;
	}

	/**
	 * Parse file content into the index. Returns hook names found.
	 */
	private collectFromContent(content: string, uri: vscode.Uri): Set<string> {
		const foundNames = new Set<string>();
		try {
			const lineStarts = buildLineStarts(content);
			const inComment = createAscendingCommentChecker(content);
			const re = new RegExp(HOOK_NAME_REGEX.source, 'g');
			let match: RegExpExecArray | null;
			const uriStr = uri.toString();

			while ((match = re.exec(content)) !== null) {
				try {
					if (inComment(match.index)) {
						continue;
					}

					const func = match[1];
					const name = match[3].trim();
					if (!name || isDynamicHook(name)) {
						continue;
					}

					const side = getHookSide(func);
					if (side === null) continue;

					const type = ACTION_API_FUNCS.has(func)
						? HookType.Action
						: HookType.Filter;

					if (side === HookSide.Definition) {
						rememberCoreHookIfPath(name, uri.fsPath);
					}

					const quote = match[2];
					const nameInMatch = match[0].indexOf(quote + name + quote);
					const nameOffset =
						nameInMatch >= 0 ? nameInMatch + 1 : match[0].indexOf(name);

					const abs = match.index + Math.max(0, nameOffset);
					const { line, character } = offsetToLineCharacter(
						lineStarts,
						abs
					);

					const occ: IndexedOccurrence = {
						name,
						func,
						type,
						side,
						uri: uriStr,
						line,
						character,
					};

					const list = this.byName.get(name) ?? [];
					list.push(occ);
					this.byName.set(name, list);
					foundNames.add(name);
				} catch {
					// skip one bad match; keep indexing the file
				}
			}

			if (foundNames.size > 0) {
				this.byFile.set(uriStr, foundNames);
				this.entriesCache = null;
			}
		} catch (err) {
			console.error('WP Hooks: collectFromContent failed for', uri.fsPath, err);
		}

		return foundNames;
	}

	private buildCatalogEntries(): HookCatalogEntry[] {
		if (this.entriesCache) {
			return this.entriesCache;
		}
		const entries: HookCatalogEntry[] = [];
		for (const [name, list] of this.byName) {
			if (list.length === 0) continue;
			const def = list.find((o) => o.side === HookSide.Definition);
			const best = def ?? list[0];
			entries.push({
				name,
				type: best.type,
				count: list.length,
				uri: best.uri,
				line: best.line,
				character: best.character,
				isDefinition: best.side === HookSide.Definition,
			});
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		this.entriesCache = entries;
		return entries;
	}

	private refreshCoreHooksFromIndex(): void {
		clearCoreHookRegistry();
		for (const list of this.byName.values()) {
			for (const o of list) {
				if (o.side === HookSide.Definition) {
					rememberCoreHookIfPath(o.name, vscode.Uri.parse(o.uri).fsPath);
				}
			}
		}
	}

	private updateStatusBarReady(): void {
		const hooks = this.getHookCount();
		this.statusBar.text = `$(check) WP Hooks: ${hooks.toLocaleString()}`;
		this.statusBar.tooltip = `WP Hooks — ${hooks.toLocaleString()} hooks, ${this.getOccurrenceCount().toLocaleString()} occurrences\nClick to rescan`;
	}

	private updateStatusBarIdle(): void {
		this.statusBar.text = '$(sync) WP Hooks';
		this.statusBar.tooltip = 'WP Hooks — click to rescan workspace';
	}

	private notifyReady(ready: boolean): void {
		for (const listener of this.readyListeners) {
			try {
				listener(ready);
			} catch {
				// ignore
			}
		}
	}
}
