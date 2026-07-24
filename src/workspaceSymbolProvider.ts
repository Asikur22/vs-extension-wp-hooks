/**
 * Workspace Symbol Provider — Cmd/Ctrl+T discovery of WordPress hooks.
 */
import * as vscode from 'vscode';
import { HookType } from './hooks';
import { HookCatalog } from './hookCatalog';

const MAX_SYMBOLS = 200;

export class WpHookWorkspaceSymbolProvider
	implements vscode.WorkspaceSymbolProvider
{
	constructor(private catalog: HookCatalog) {}

	async provideWorkspaceSymbols(
		query: string,
		token: vscode.CancellationToken
	): Promise<vscode.SymbolInformation[]> {
		try {
			// Never block on a full scan — VS Code cancels long-running symbol providers.
			if (!this.catalog.isReady() && !this.catalog.isScanning()) {
				void this.catalog.startInitialScan();
			}

			const hooks = this.catalog.getHooksSnapshot();
			if (token.isCancellationRequested || hooks.length === 0) {
				return [];
			}

			const q = query.trim().toLowerCase();
			const symbols: vscode.SymbolInformation[] = [];

			for (const hook of hooks) {
				if (token.isCancellationRequested) {
					break;
				}
				if (q && !hook.name.toLowerCase().includes(q)) {
					continue;
				}

				const kindLabel =
					hook.type === HookType.Action ? 'Action hook' : 'Filter hook';
				const container = hook.isDefinition
					? `${kindLabel} · definition`
					: `${kindLabel} · reference`;

				const location = new vscode.Location(
					vscode.Uri.parse(hook.uri),
					new vscode.Position(hook.line, hook.character)
				);

				symbols.push(
					new vscode.SymbolInformation(
						hook.name,
						vscode.SymbolKind.Event,
						container,
						location
					)
				);

				if (symbols.length >= MAX_SYMBOLS) {
					break;
				}
			}

			return symbols;
		} catch (err) {
			console.error('WP Hooks: provideWorkspaceSymbols failed', err);
			return [];
		}
	}
}
