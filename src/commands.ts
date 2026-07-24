/**
 * Context menu / command handlers for WP Hooks.
 */
import * as vscode from 'vscode';
import { HookSearchEngine } from './search';
import { HookCache } from './cache';
import { HookCatalog } from './hookCatalog';
import {
	goToCallbackAtPosition,
	goToHookAtPosition,
} from './hookNavigation';

/**
 * Register all commands for the extension.
 */
export function registerCommands(
	context: vscode.ExtensionContext,
	_cache: HookCache,
	searchEngine: HookSearchEngine,
	catalog?: HookCatalog
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('wpHooks.rescanWorkspace', async () => {
			if (!catalog) {
				vscode.window.showWarningMessage('WP Hooks: catalog not available');
				return;
			}
			await catalog.rescan();
			_cache.clear();
			vscode.window.showInformationMessage(
				`WP Hooks: rescanned — ${catalog.getHookCount()} hooks`
			);
		})
	);

	/**
	 * Go to Hook Definition — context menu, F12, and hover links.
	 * Same implementation as Alt/Cmd/Ctrl+Click (see DefinitionProvider).
	 */
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'wpHooks.goToHookDefinition',
			async (...rawArgs: unknown[]) => {
				try {
					await runGoToHookDefinition(rawArgs, searchEngine);
				} catch (err) {
					console.error('WP Hooks: goToHookDefinition failed', err);
					vscode.window.showErrorMessage(
						`WP Hooks: Go to Hook Definition failed — ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'wpHooks.goToCallbackFunction',
			async () => {
				try {
					await runGoToCallbackFunction();
				} catch (err) {
					console.error('WP Hooks: goToCallbackFunction failed', err);
					vscode.window.showErrorMessage(
						`WP Hooks: Go to Callback failed — ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}
		)
	);
}

async function runGoToHookDefinition(
	rawArgs: unknown[],
	searchEngine: HookSearchEngine
): Promise<void> {
	const hover = parseHoverArgs(rawArgs);

	let document: vscode.TextDocument | undefined;
	let position: vscode.Position | undefined;

	if (hover) {
		try {
			document = await vscode.workspace.openTextDocument(hover.uri);
			position = hover.position;
			await vscode.window.showTextDocument(document, {
				preserveFocus: false,
				selection: new vscode.Range(position, position),
			});
		} catch {
			document = undefined;
			position = undefined;
		}
	}

	const editor = vscode.window.activeTextEditor;
	if (!document || !position) {
		if (!editor) {
			vscode.window.showWarningMessage(
				'WP Hooks: No active editor — open a PHP file and try again'
			);
			return;
		}
		document = editor.document;
		position = editor.selection.isEmpty
			? editor.selection.active
			: editor.selection.start;
	}

	const selectedText =
		editor && editor.selection && !editor.selection.isEmpty
			? document.getText(editor.selection)
			: '';

	const handled = await goToHookAtPosition(
		document,
		position,
		searchEngine,
		{ showProgress: true, selectedText }
	);

	if (!handled) {
		vscode.window.showWarningMessage(
			'WP Hooks: Place the cursor on a hook name string (inside the quotes of add_action / do_action / etc.)'
		);
	}
}

async function runGoToCallbackFunction(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('WP Hooks: No active editor');
		return;
	}

	const position = editor.selection.isEmpty
		? editor.selection.active
		: editor.selection.start;

	const handled = await goToCallbackAtPosition(editor.document, position, {
		showProgress: true,
	});

	if (!handled) {
		vscode.window.showWarningMessage(
			'WP Hooks: No callback found — place the cursor on an add_action / add_filter / remove_* line (on the callback or hook name)'
		);
	}
}

/**
 * Hover links pass [uri, line, character].
 * Context menu may pass a lone Uri — that must be ignored.
 */
function parseHoverArgs(
	rawArgs: unknown[]
): { uri: vscode.Uri; position: vscode.Position } | undefined {
	if (rawArgs.length < 3) {
		return undefined;
	}

	const [a, b, c] = rawArgs;
	if (typeof b !== 'number' || typeof c !== 'number') {
		return undefined;
	}
	if (!Number.isFinite(b) || !Number.isFinite(c)) {
		return undefined;
	}

	let uri: vscode.Uri | undefined;
	if (typeof a === 'string') {
		uri = vscode.Uri.parse(a);
	} else if (a instanceof vscode.Uri) {
		uri = a;
	} else if (
		a &&
		typeof a === 'object' &&
		typeof (a as { fsPath?: string }).fsPath === 'string'
	) {
		uri = a as vscode.Uri;
	}

	if (!uri) {
		return undefined;
	}

	return {
		uri,
		position: new vscode.Position(b, c),
	};
}
