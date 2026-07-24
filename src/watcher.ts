/**
 * File system watcher — incremental index updates + cache invalidation.
 */
import * as vscode from 'vscode';
import { HookCache } from './cache';
import { HookCatalog } from './hookCatalog';
import { isExcludedPath } from './config';

const DEBOUNCE_MS = 400;

export class HookFileWatcher {
	private cache: HookCache;
	private catalog: HookCatalog;
	private watchers: vscode.FileSystemWatcher[] = [];
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	/** uri → deleted? */
	private pending = new Map<string, boolean>();

	constructor(cache: HookCache, catalog: HookCatalog) {
		this.cache = cache;
		this.catalog = catalog;
	}

	start(): void {
		const watcher = vscode.workspace.createFileSystemWatcher(
			'**/*.php',
			false,
			false,
			false
		);

		watcher.onDidChange((uri) => this.schedule(uri, false));
		watcher.onDidCreate((uri) => this.schedule(uri, false));
		watcher.onDidDelete((uri) => this.schedule(uri, true));

		this.watchers.push(watcher);
	}

	private schedule(uri: vscode.Uri, deleted: boolean): void {
		if (isExcludedPath(uri.fsPath)) {
			return;
		}

		const key = uri.toString();
		// Deleted wins over a prior change in the same debounce window
		this.pending.set(key, deleted || this.pending.get(key) === true);

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
	}

	private async flush(): Promise<void> {
		this.debounceTimer = undefined;
		const batch = new Map(this.pending);
		this.pending.clear();

		try {
			const affectedHooks = new Set<string>();

			for (const [uriStr, deleted] of batch) {
				try {
					const uri = vscode.Uri.parse(uriStr);
					const names = await this.catalog.reindexFile(uri, deleted);
					for (const name of names) {
						affectedHooks.add(name);
					}
					this.cache.invalidateFile(uriStr);
				} catch (err) {
					console.error('WP Hooks: reindex failed for', uriStr, err);
				}
			}

			for (const name of affectedHooks) {
				this.cache.invalidateHook(name);
			}
		} catch (err) {
			console.error('WP Hooks: watcher flush failed', err);
		}
	}

	dispose(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
		for (const w of this.watchers) {
			w.dispose();
		}
		this.watchers = [];
	}
}
