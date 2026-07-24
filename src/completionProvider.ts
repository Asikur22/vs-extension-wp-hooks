import * as vscode from 'vscode';
import { ACTION_API_FUNCS, HOOK_API_ALT, HookType } from './hooks';
import { HookCatalog } from './hookCatalog';

interface HookCompletionContext {
	func: string;
	type: HookType;
	/** Partial text already typed inside the quotes */
	prefix: string;
	/** Range of the partial hook name to replace */
	replaceRange: vscode.Range;
}

export class WpHookCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private catalog: HookCatalog) {}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): Promise<vscode.CompletionList | null> {
		const ctx = getHookCompletionContext(document, position);
		if (!ctx) {
			return null;
		}

		const hooks = await this.catalog.getHooks(token);
		if (token.isCancellationRequested || hooks.length === 0) {
			return null;
		}

		const prefix = ctx.prefix.toLowerCase();
		const items: vscode.CompletionItem[] = [];

		for (const hook of hooks) {
			// Prefer matching type (action vs filter), but still allow cross-type
			if (prefix && !hook.name.toLowerCase().includes(prefix)) {
				continue;
			}

			const item = new vscode.CompletionItem(
				hook.name,
				vscode.CompletionItemKind.Value
			);
			item.detail =
				hook.type === HookType.Action ? 'Action hook' : 'Filter hook';
			item.documentation = new vscode.MarkdownString(
				`Found **${hook.count}** time${hook.count === 1 ? '' : 's'} in workspace`
			);
			item.range = ctx.replaceRange;
			item.insertText = hook.name;
			item.filterText = hook.name;

			// Rank same-type hooks higher
			const typeBoost = hook.type === ctx.type ? 0 : 1;
			item.sortText = `${typeBoost}_${hook.name}`;

			items.push(item);

			// Cap list size for responsiveness
			if (items.length >= 200) {
				break;
			}
		}

		return new vscode.CompletionList(items, false);
	}
}

/**
 * Detect if the cursor is inside the first string arg of a WP hook function.
 */
export function getHookCompletionContext(
	document: vscode.TextDocument,
	position: vscode.Position
): HookCompletionContext | null {
	const startLine = Math.max(0, position.line - 8);
	const beforeRange = new vscode.Range(
		new vscode.Position(startLine, 0),
		position
	);
	const before = document.getText(beforeRange);

	const re = new RegExp(
		`(${HOOK_API_ALT})\\s*\\(\\s*(['"])([^'"\\n]*)$`
	);
	const match = before.match(re);
	if (!match) {
		return null;
	}

	const func = match[1];
	const prefix = match[3] ?? '';
	const type = ACTION_API_FUNCS.has(func) ? HookType.Action : HookType.Filter;

	const replaceStart = position.translate(0, -prefix.length);
	return {
		func,
		type,
		prefix,
		replaceRange: new vscode.Range(replaceStart, position),
	};
}
