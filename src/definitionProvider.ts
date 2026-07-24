/**
 * Go to Definition for WordPress hooks / callbacks.
 *
 * Resolves locations via the same search engine as the context menu, but
 * returns LocationLinks to VS Code (no side-effect navigation). Side-effect
 * open broke subsequent Go to Definition / symbol search after callbacks.
 */
import * as vscode from 'vscode';
import { extractCallbackAtPosition, findCallbackDefinition } from './callback';
import { HookSearchEngine } from './search';
import {
	resolveHookAtPosition,
	resolveHookLocations,
	toCallbackLocationLinks,
	toHookLocationLinks,
} from './hookNavigation';

export class WpHookDefinitionProvider implements vscode.DefinitionProvider {
	constructor(private searchEngine: HookSearchEngine) {}

	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): Promise<vscode.LocationLink[] | null> {
		try {
			const hook = resolveHookAtPosition(document, position);
			if (hook) {
				if (hook.isDynamic) {
					vscode.window.setStatusBarMessage(
						'⚠ Dynamic hook — exact definition may vary',
						3000
					);
				}

				const locations = await resolveHookLocations(
					hook,
					document,
					this.searchEngine,
					token
				);
				if (token.isCancellationRequested || locations.length === 0) {
					return null;
				}
				return toHookLocationLinks(hook, locations);
			}

			const callback = extractCallbackAtPosition(
				document.getText(),
				position.line,
				position.character,
				false
			);
			if (callback) {
				const locations = await findCallbackDefinition(
					callback,
					document,
					token
				);
				if (token.isCancellationRequested || locations.length === 0) {
					return null;
				}
				return toCallbackLocationLinks(locations, document, position);
			}

			return null;
		} catch (err) {
			console.error('WP Hooks: provideDefinition failed', err);
			return null;
		}
	}
}
