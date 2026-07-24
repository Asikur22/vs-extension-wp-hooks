/**
 * Hover provider for WordPress hooks.
 * Shows origin type, PHPDoc summary / @since, official docs (core), and occurrences.
 */
import * as vscode from 'vscode';
import { extractHookAtPosition, getHookApiLabel, HookSide, HookType } from './hooks';
import { flattenToSingleLine, HookSearchEngine } from './search';
import {
	isOfficialWpHook,
	isWpCorePath,
	rememberCoreHook,
} from './wpCoreHooks';
import {
	classifyHookOrigin,
	getHookOriginLabel,
	pickPrimaryDefinitionPath,
	HookOriginKind,
} from './hookOrigin';
import { extractHookDocMeta, HookDocMeta } from './hookDocblock';
import * as path from 'path';

/** Official WordPress Code Reference base for hooks */
const WP_HOOK_DOCS_BASE = 'https://developer.wordpress.org/reference/hooks';

/** Allow enough time for a workspace occurrence scan on hover */
const HOVER_TIMEOUT_MS = 2500;

export class WpHookHoverProvider implements vscode.HoverProvider {
	constructor(private searchEngine: HookSearchEngine) {}

	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): Promise<vscode.Hover | null> {
		try {
			return await this.provideHoverInner(document, position, token);
		} catch (err) {
			console.error('WP Hooks: provideHover failed', err);
			return null;
		}
	}

	private async provideHoverInner(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): Promise<vscode.Hover | null> {
		const text = document.getText();
		const hook = extractHookAtPosition(
			text,
			position.line,
			position.character
		);

		if (!hook) {
			return null;
		}

		// Avoid heavy hover work only before the index has anything usable
		if (this.searchEngine.isScanning() && !this.searchEngine.isIndexReady()) {
			return new vscode.Hover(
				this.md(
					`$(sync~spin) **WP Hooks** — Indexing hooks…\n\n` +
						`*Hover again when the status bar shows the hook count.*`
				)
			);
		}

		const typeLabel =
			hook.type === HookType.Action ? 'Action' : 'Filter';
		const sideLabel = getHookApiLabel(hook.func);

		if (hook.isDynamic) {
			const card = this.buildInfoCard({
				hookName: hook.name,
				typeLabel,
				sideLabel,
				origin: 'custom',
				showDocs: false,
				description: undefined,
				since: undefined,
				dynamic: true,
			});
			return new vscode.Hover(
				this.md(
					`${card}${this.buildActionFooter(document.uri, position, hook.side)}`
				)
			);
		}

		const cts = new vscode.CancellationTokenSource();
		const parentSub = token.onCancellationRequested(() => cts.cancel());
		const timer = setTimeout(() => cts.cancel(), HOVER_TIMEOUT_MS);

		let hoverResult;
		let timedOut = false;
		try {
			hoverResult = await this.searchEngine.resolveHover(
				hook,
				document,
				cts.token
			);
			timedOut =
				cts.token.isCancellationRequested &&
				(!hoverResult || hoverResult.results.length === 0);
		} finally {
			clearTimeout(timer);
			parentSub.dispose();
			cts.dispose();
		}

		const definitionSite = this.resolveDefinitionSite(
			hook,
			document,
			hoverResult
		);
		const origin = definitionSite
			? classifyHookOrigin(definitionSite.fsPath)
			: 'custom';

		if (origin === 'core') {
			rememberCoreHook(hook.name);
		}

		const showDocs = this.shouldShowOfficialDocs(
			hook,
			document,
			hoverResult,
			origin
		);

		let docMeta: HookDocMeta | null = null;
		if (definitionSite && !token.isCancellationRequested) {
			docMeta = await extractHookDocMeta(
				definitionSite.uri,
				definitionSite.line
			);
		}

		const card = this.buildInfoCard({
			hookName: hook.name,
			typeLabel,
			sideLabel,
			origin,
			showDocs,
			description: docMeta?.description,
			since: docMeta?.since,
			dynamic: false,
		});

		const results = hoverResult?.results ?? [];

		const footer = this.buildActionFooter(document.uri, position, hook.side);

		if (results.length === 0) {
			if (timedOut || token.isCancellationRequested) {
				return new vscode.Hover(this.md(`${card}${footer}`));
			}
			const emptyMsg =
				hook.side === HookSide.Registration ? 'definition' : 'references';
			return new vscode.Hover(
				this.md(`${card}\n\n*No ${emptyMsg} found in workspace.*${footer}`)
			);
		}

		const listLabel =
			hook.side === HookSide.Registration ? 'Definitions' : 'Occurrences';
		const total = hoverResult?.totalFound ?? results.length;
		const countSuffix = hoverResult?.truncated
			? ` of ${total}+`
			: total > results.length
				? ` of ${total}`
				: '';

		// Compact layout: meta, then list — blank line after Definitions heading
		const md = this.md(
			`${card}\n\n**${listLabel}** (${results.length}${countSuffix})\n\n`
		);

		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			const filePath = this.getRelativePath(result.location.uri);
			const line = result.location.range.start.line + 1;
			const link = this.buildFileLink(result.location);
			const snippet = flattenToSingleLine(result.snippet);

			md.appendMarkdown(`[${filePath}:${line}](${link})\n`);
			md.appendMarkdown('```php\n');
			md.appendMarkdown(snippet + '\n');
			md.appendMarkdown('```\n');
			if (i < results.length - 1) {
				md.appendMarkdown('\n');
			}
		}

		if (hoverResult?.truncated) {
			md.appendMarkdown(
				`\n*Showing first ${results.length} — use Go to Definition for more.*`
			);
		}

		md.appendMarkdown(footer);
		return new vscode.Hover(md);
	}

	/**
	 * Prefer the definition file for origin + PHPDoc:
	 * - On a definition call → current document
	 * - On a registration → catalog / hover definition results (core preferred)
	 */
	private resolveDefinitionSite(
		hook: {
			name: string;
			side: HookSide;
			range: { start: { line: number } };
		},
		document: vscode.TextDocument,
		hoverResult: { results: Array<{ location: vscode.Location }> } | undefined
	): { uri: vscode.Uri; fsPath: string; line: number } | undefined {
		if (hook.side === HookSide.Definition) {
			return {
				uri: document.uri,
				fsPath: document.uri.fsPath,
				line: hook.range.start.line,
			};
		}

		const fromCatalog = this.searchEngine.getPrimaryDefinitionLocation(
			hook.name
		);
		if (fromCatalog) {
			return {
				uri: fromCatalog.uri,
				fsPath: fromCatalog.uri.fsPath,
				line: fromCatalog.range.start.line,
			};
		}

		const defPaths =
			hoverResult?.results.map((r) => r.location.uri.fsPath) ?? [];
		const primaryPath = pickPrimaryDefinitionPath(defPaths);
		if (!primaryPath || !hoverResult) {
			return undefined;
		}

		const match = hoverResult.results.find(
			(r) => r.location.uri.fsPath === primaryPath
		);
		if (!match) {
			return undefined;
		}

		return {
			uri: match.location.uri,
			fsPath: match.location.uri.fsPath,
			line: match.location.range.start.line,
		};
	}

	private shouldShowOfficialDocs(
		hook: { name: string; side: HookSide; isDynamic: boolean },
		document: vscode.TextDocument,
		hoverResult: { results: Array<{ location: vscode.Location }> } | undefined,
		origin: HookOriginKind
	): boolean {
		if (hook.isDynamic) {
			return false;
		}
		if (origin === 'core') {
			return true;
		}
		if (isOfficialWpHook(hook.name)) {
			return true;
		}
		if (
			hook.side === HookSide.Definition &&
			isWpCorePath(document.uri.fsPath)
		) {
			return true;
		}
		if (
			hook.side === HookSide.Registration &&
			hoverResult?.results.some((r) =>
				isWpCorePath(r.location.uri.fsPath)
			)
		) {
			return true;
		}
		return false;
	}

	private buildInfoCard(opts: {
		hookName: string;
		typeLabel: string;
		sideLabel: string;
		origin: HookOriginKind;
		showDocs: boolean;
		description?: string;
		since?: string;
		dynamic: boolean;
	}): string {
		const {
			hookName,
			typeLabel,
			sideLabel,
			origin,
			showDocs,
			description,
			since,
			dynamic,
		} = opts;

		const originLabel = getHookOriginLabel(origin);
		const originIcon =
			origin === 'core'
				? '$(verified-filled)'
				: origin === 'theme'
					? '$(symbol-color)'
					: origin === 'plugin'
						? '$(extensions)'
						: '$(symbol-misc)';

		const parts: string[] = [];
		const safeName = escapeHtml(hookName);
		const nameHtml = showDocs
			? `<a href="${buildHookDocsUrl(hookName)}" style="color:inherit;text-decoration:none;"><code style="font-size:1.35em;font-weight:700;padding:0.1em 0.35em;">${safeName}</code></a>`
			: `<code style="font-size:1.35em;font-weight:700;padding:0.1em 0.35em;">${safeName}</code>`;

		// Line 1: larger hook name + origin / kind meta
		parts.push(
			`${nameHtml}&nbsp; ${originIcon} ${originLabel} · ${typeLabel} · ${sideLabel}`
		);

		if (dynamic) {
			parts.push('$(warning) *Dynamic hook — exact definition may vary.*');
			return parts.join('\n\n');
		}

		// Line 2: short description alone
		if (description) {
			parts.push(truncateHoverText(description, 160));
		}

		// Line 3: since + docs
		const metaBits: string[] = [];
		if (since) {
			metaBits.push(`Since \`${since}\``);
		}
		if (showDocs) {
			metaBits.push(`[Docs →](${buildHookDocsUrl(hookName)})`);
		}
		if (metaBits.length > 0) {
			parts.push(metaBits.join(' · '));
		}

		return parts.join('\n\n');
	}

	/**
	 * Full-width rule + action link (separated from definitions).
	 */
	private buildActionFooter(
		uri: vscode.Uri,
		position: vscode.Position,
		side: HookSide
	): string {
		const label =
			side === HookSide.Registration
				? 'Go to Hook Definition'
				: 'Go to Hook Occurrences';
		const args = encodeURIComponent(
			JSON.stringify([uri.toString(), position.line, position.character])
		);
		return (
			`\n\n` +
			`<hr style="border:none;border-top:1px solid var(--vscode-editorWidget-border,rgba(128,128,128,.45));margin:10px 0 8px;width:100%;">\n\n` +
			`$(go-to-file) [**${label}**](command:wpHooks.goToHookDefinition?${args})`
		);
	}

	private md(content?: string): vscode.MarkdownString {
		const markdown = new vscode.MarkdownString(content);
		markdown.isTrusted = true;
		markdown.supportThemeIcons = true;
		markdown.supportHtml = true;
		return markdown;
	}

	private buildFileLink(location: vscode.Location): string {
		const line = location.range.start.line + 1;
		const character = location.range.start.character + 1;
		return location.uri
			.with({ fragment: `L${line},${character}` })
			.toString();
	}

	private getRelativePath(uri: vscode.Uri): string {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
		if (workspaceFolder) {
			return path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
		}
		return uri.fsPath;
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function truncateHoverText(value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return trimmed.slice(0, max - 1).trimEnd() + '…';
}

export function buildHookDocsUrl(hookName: string): string {
	const slug = encodeURIComponent(hookName);
	return `${WP_HOOK_DOCS_BASE}/${slug}/`;
}
