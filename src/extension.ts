/**
 * WP Hooks — Extension Entry Point
 *
 * On activate: status bar + full workspace scan into an index.
 * Lookups use the index; PHP changes reindex only that file.
 */
import * as vscode from 'vscode';
import { HookCache } from './cache';
import { HookCatalog } from './hookCatalog';
import { HookSearchEngine } from './search';
import { WpHookDefinitionProvider } from './definitionProvider';
import { WpHookHoverProvider } from './hoverProvider';
import { WpHookCompletionProvider } from './completionProvider';
import { WpHookWorkspaceSymbolProvider } from './workspaceSymbolProvider';
import { HookFileWatcher } from './watcher';
import { registerCommands } from './commands';
import { registerHookContextTracking } from './hookContext';

const PHP_SELECTOR: vscode.DocumentSelector = {
	scheme: 'file',
	language: 'php',
};

let cache: HookCache;
let catalog: HookCatalog;
let searchEngine: HookSearchEngine;
let watcher: HookFileWatcher;

export function activate(context: vscode.ExtensionContext): void {
	cache = new HookCache();
	catalog = new HookCatalog();
	searchEngine = new HookSearchEngine(cache, catalog);

	// Register commands first so context-menu / F12 work even if later setup fails
	registerCommands(context, cache, searchEngine, catalog);

	try {
		watcher = new HookFileWatcher(cache, catalog);
		watcher.start();

		context.subscriptions.push(catalog);
		context.subscriptions.push(watcher);

		registerHookContextTracking(context);

		context.subscriptions.push(
			vscode.languages.registerDefinitionProvider(
				PHP_SELECTOR,
				new WpHookDefinitionProvider(searchEngine)
			)
		);

		context.subscriptions.push(
			vscode.languages.registerHoverProvider(
				PHP_SELECTOR,
				new WpHookHoverProvider(searchEngine)
			)
		);

		context.subscriptions.push(
			vscode.languages.registerCompletionItemProvider(
				PHP_SELECTOR,
				new WpHookCompletionProvider(catalog),
				"'",
				'"',
				'_',
				'-'
			)
		);

		context.subscriptions.push(
			vscode.languages.registerWorkspaceSymbolProvider(
				new WpHookWorkspaceSymbolProvider(catalog)
			)
		);

		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('wpHooks')) {
					cache.clear();
					catalog.invalidate();
				}
			})
		);
	} catch (err) {
		console.error('WP Hooks: partial activation failure', err);
		vscode.window.showWarningMessage(
			'WP Hooks: Some features failed to start — Go to Hook commands should still work. Reload window if issues persist.'
		);
	}

	// Non-blocking index build; drop stale lookup cache when index becomes ready
	context.subscriptions.push(
		catalog.onReadyChange((ready) => {
			if (ready) {
				cache.clear();
			}
		})
	);
	void catalog.startInitialScan();
}

export function deactivate(): void {
	cache?.clear();
	catalog?.dispose();
}
