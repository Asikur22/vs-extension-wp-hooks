/**
 * Track whether the cursor is on a WP hook name so keybindings
 * can prefer WP Hooks over Intelephense for F12 / go-to-definition.
 */
import * as vscode from 'vscode';
import { extractHookAtPosition } from './hooks';
import { extractCallbackAtPosition } from './callback';

const CONTEXT_ON_HOOK = 'wpHooks.isOnHook';
const CONTEXT_ON_CALLBACK = 'wpHooks.isOnCallback';

let lastOnHook = false;
let lastOnCallback = false;

/**
 * Keep editor context keys in sync with the caret position.
 */
export function registerHookContextTracking(
	context: vscode.ExtensionContext
): void {
	const update = (editor: vscode.TextEditor | undefined) => {
		void updateHookContext(editor);
	};

	update(vscode.window.activeTextEditor);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(update),
		vscode.window.onDidChangeTextEditorSelection((e) => {
			if (e.textEditor === vscode.window.activeTextEditor) {
				void updateHookContext(e.textEditor);
			}
		})
	);

	context.subscriptions.push({
		dispose: () => {
			void vscode.commands.executeCommand('setContext', CONTEXT_ON_HOOK, false);
			void vscode.commands.executeCommand(
				'setContext',
				CONTEXT_ON_CALLBACK,
				false
			);
		},
	});
}

async function updateHookContext(
	editor: vscode.TextEditor | undefined
): Promise<void> {
	if (!editor || editor.document.languageId !== 'php') {
		await setContexts(false, false);
		return;
	}

	const pos = editor.selection.active;
	const text = editor.document.getText();
	const onHook = !!extractHookAtPosition(text, pos.line, pos.character);
	const onCallback =
		!onHook && !!extractCallbackAtPosition(text, pos.line, pos.character);
	await setContexts(onHook, onCallback);
}

async function setContexts(onHook: boolean, onCallback: boolean): Promise<void> {
	if (onHook !== lastOnHook) {
		lastOnHook = onHook;
		await vscode.commands.executeCommand('setContext', CONTEXT_ON_HOOK, onHook);
	}
	if (onCallback !== lastOnCallback) {
		lastOnCallback = onCallback;
		await vscode.commands.executeCommand(
			'setContext',
			CONTEXT_ON_CALLBACK,
			onCallback
		);
	}
}
