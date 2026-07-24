/**
 * Shared hook / callback navigation used by:
 * - Context menu / F12 / hover command links (exclusive open)
 * - DefinitionProvider (resolve locations only — return links to VS Code)
 *
 * Newer Go to Hook / Callback requests supersede older ones by generation
 * id: stale results are ignored. We do NOT cancel the previous search token
 * (that raced and broke navigation). Old work may finish in the background.
 */
import * as vscode from 'vscode';
import {
	extractHookAtPosition,
	extractHookFromSelection,
	HookInfo,
	HookSide,
} from './hooks';
import { HookSearchEngine } from './search';
import { getConfig } from './config';
import {
	CallbackInfo,
	extractCallbackAtPosition,
	findCallbackDefinition,
} from './callback';

export interface GoToHookOptions {
	/** Show a notification progress indicator (default true) */
	showProgress?: boolean;
	/** Selected text without requiring quotes */
	selectedText?: string;
	token?: vscode.CancellationToken;
}

/** Bumped on every new go-to; stale requests compare against this. */
let navEpoch = 0;

/** Only show a progress notification if work takes longer than this. */
const PROGRESS_DELAY_MS = 120;

/**
 * Resolve a hook at a document position (same rules for menu + click).
 */
export function resolveHookAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position,
	selectedText = ''
): HookInfo | null {
	const text = document.getText();
	const cleaned = selectedText.replace(/^['"]|['"]$/g, '');

	if (cleaned.length >= 2) {
		const fromSelection = extractHookFromSelection(
			text,
			position.line,
			cleaned
		);
		if (fromSelection) {
			return fromSelection;
		}
	}

	const atCursor = extractHookAtPosition(
		text,
		position.line,
		position.character
	);
	if (atCursor) {
		return atCursor;
	}

	const lineText = document.lineAt(position.line).text;
	const re = /(['"])([^'"$\n]+)\1/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(lineText)) !== null) {
		const hook = extractHookAtPosition(text, position.line, m.index + 1);
		if (hook) {
			return hook;
		}
	}

	return null;
}

/**
 * Resolve hook target locations (no UI). Used by DefinitionProvider + commands.
 */
export async function resolveHookLocations(
	hook: HookInfo,
	document: vscode.TextDocument,
	searchEngine: HookSearchEngine,
	token: vscode.CancellationToken
): Promise<vscode.Location[]> {
	return searchEngine.resolveDefinition(hook, document, token);
}

function isCurrent(epoch: number): boolean {
	return epoch === navEpoch;
}

/**
 * Run work immediately; only open a progress UI if still running after a delay.
 * User cancel (progress UI) cancels `userCts` only — supersede uses epoch.
 */
async function withDeferredProgress(
	title: string,
	options: GoToHookOptions,
	userCts: vscode.CancellationTokenSource,
	run: () => Promise<void>
): Promise<void> {
	const subs: vscode.Disposable[] = [];
	if (options.token) {
		subs.push(
			options.token.onCancellationRequested(() => userCts.cancel())
		);
	}

	try {
		if (options.showProgress === false) {
			await run();
			return;
		}

		let settled = false;
		const work = run().finally(() => {
			settled = true;
		});

		await Promise.race([
			work,
			new Promise<void>((resolve) =>
				setTimeout(resolve, PROGRESS_DELAY_MS)
			),
		]);

		if (settled || userCts.token.isCancellationRequested) {
			await work;
			return;
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title,
				cancellable: true,
			},
			async (_progress, progressToken) => {
				subs.push(
					progressToken.onCancellationRequested(() => userCts.cancel())
				);
				await work;
			}
		);
	} finally {
		for (const s of subs) s.dispose();
	}
}

/**
 * Find targets and open them — context menu / F12 / hover link only.
 * A newer call supersedes this one (stale results are ignored).
 */
export async function goToHookAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position,
	searchEngine: HookSearchEngine,
	options: GoToHookOptions = {}
): Promise<boolean> {
	const hook = resolveHookAtPosition(
		document,
		position,
		options.selectedText ?? ''
	);
	if (!hook) {
		return false;
	}

	const epoch = ++navEpoch;
	const userCts = new vscode.CancellationTokenSource();

	try {
		await withDeferredProgress(
			`WP Hooks: Finding \u201c${hook.name}\u201d\u2026`,
			options,
			userCts,
			async () => {
				await openHookTargets(
					hook,
					document,
					searchEngine,
					userCts.token,
					epoch
				);
			}
		);
		return true;
	} finally {
		userCts.dispose();
	}
}

async function openHookTargets(
	hook: HookInfo,
	document: vscode.TextDocument,
	searchEngine: HookSearchEngine,
	token: vscode.CancellationToken,
	epoch: number
): Promise<void> {
	if (!isCurrent(epoch) || token.isCancellationRequested) {
		return;
	}

	if (hook.isDynamic) {
		vscode.window.setStatusBarMessage(
			'\u26a0 Dynamic hook \u2014 exact definition may vary',
			3000
		);
	}

	const locations = await resolveHookLocations(
		hook,
		document,
		searchEngine,
		token
	);

	if (!isCurrent(epoch) || token.isCancellationRequested) {
		return;
	}

	if (locations.length === 0) {
		const sideLabel =
			hook.side === HookSide.Registration ? 'definition' : 'reference';
		const config = getConfig();
		const hint =
			config.externalPaths.length === 0
				? ' \u2014 tip: set wpHooks.externalPaths for WordPress core/plugins'
				: '';
		vscode.window.showWarningMessage(
			`WP Hooks: No ${sideLabel} found for "${hook.name}"${hint}`
		);
		return;
	}

	await openLocations(document, locations);
}

/**
 * Open callback targets (context menu).
 * A newer call supersedes this one (stale results are ignored).
 */
export async function goToCallbackAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position,
	options: GoToHookOptions = {}
): Promise<boolean> {
	const text = document.getText();
	const callback =
		extractCallbackAtPosition(
			text,
			position.line,
			position.character,
			false
		) ??
		extractCallbackAtPosition(
			text,
			position.line,
			position.character,
			true
		);

	if (!callback) {
		return false;
	}

	const label =
		callback.className || callback.shortClassName
			? `${callback.shortClassName ?? callback.className}::${callback.name}`
			: callback.name;

	const epoch = ++navEpoch;
	const userCts = new vscode.CancellationTokenSource();

	try {
		await withDeferredProgress(
			`WP Hooks: Finding callback \u201c${label}\u201d\u2026`,
			options,
			userCts,
			async () => {
				await openCallbackTargets(
					callback,
					document,
					userCts.token,
					epoch
				);
			}
		);
		return true;
	} finally {
		userCts.dispose();
	}
}

async function openCallbackTargets(
	callback: CallbackInfo,
	document: vscode.TextDocument,
	token: vscode.CancellationToken,
	epoch: number
): Promise<void> {
	if (!isCurrent(epoch) || token.isCancellationRequested) {
		return;
	}

	const locations = await findCallbackDefinition(callback, document, token);

	if (!isCurrent(epoch) || token.isCancellationRequested) {
		return;
	}

	if (locations.length === 0) {
		const label = callback.isClosure ? 'closure' : `"${callback.name}"`;
		vscode.window.showWarningMessage(
			`WP Hooks: Callback ${label} not found in the workspace`
		);
		return;
	}

	await openLocations(document, locations);
}

export async function openLocations(
	fromDocument: vscode.TextDocument,
	locations: vscode.Location[]
): Promise<void> {
	if (locations.length === 1) {
		await gotoLocation(locations[0]);
		return;
	}

	const editor = vscode.window.activeTextEditor;
	const fromPos =
		editor?.document.uri.toString() === fromDocument.uri.toString()
			? editor.selection.active
			: new vscode.Position(0, 0);

	try {
		await vscode.commands.executeCommand(
			'editor.action.goToLocations',
			fromDocument.uri,
			fromPos,
			locations,
			'gotoAndPeek',
			'WP Hooks: Multiple matches found'
		);
	} catch {
		await gotoLocation(locations[0]);
		vscode.window.setStatusBarMessage(
			`WP Hooks: ${locations.length} matches \u2014 opened first`,
			5000
		);
	}
}

async function gotoLocation(location: vscode.Location): Promise<void> {
	const doc = await vscode.workspace.openTextDocument(location.uri);
	await vscode.window.showTextDocument(doc, {
		selection: location.range,
		preserveFocus: false,
		preview: true,
	});
}

/**
 * Build LocationLinks for the DefinitionProvider (no side-effect navigation).
 */
export function toHookLocationLinks(
	hook: HookInfo,
	locations: vscode.Location[]
): vscode.LocationLink[] {
	const origin = new vscode.Range(
		hook.range.start.line,
		hook.range.start.character,
		hook.range.end.line,
		hook.range.end.character
	);
	return locations.map((loc) => ({
		originSelectionRange: origin,
		targetUri: loc.uri,
		targetRange: loc.range,
		targetSelectionRange: loc.range,
	}));
}

export function toCallbackLocationLinks(
	locations: vscode.Location[],
	document: vscode.TextDocument,
	position: vscode.Position
): vscode.LocationLink[] {
	const word =
		document.getWordRangeAtPosition(position) ??
		new vscode.Range(position, position);
	return locations.map((loc) => ({
		originSelectionRange: word,
		targetUri: loc.uri,
		targetRange: loc.range,
		targetSelectionRange: loc.range,
	}));
}
