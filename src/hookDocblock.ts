/**
 * Extract WordPress-style PHPDoc summary and @since from a hook definition site.
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';

export interface HookDocMeta {
	/** First paragraph / summary line from the docblock */
	description?: string;
	/** Version from @since (e.g. "3.0.0") */
	since?: string;
}

const docCache = new Map<string, HookDocMeta | null>();

/**
 * Read PHPDoc immediately above `line` (0-based) in `uri`.
 */
export async function extractHookDocMeta(
	uri: vscode.Uri,
	line: number
): Promise<HookDocMeta | null> {
	const cacheKey = `${uri.toString()}@${line}`;
	if (docCache.has(cacheKey)) {
		return docCache.get(cacheKey) ?? null;
	}

	try {
		const openDoc = vscode.workspace.textDocuments.find(
			(d) => d.uri.toString() === uri.toString()
		);
		const text =
			openDoc?.getText() ??
			(await fs.readFile(uri.fsPath, 'utf8'));
		const meta = parseDocblockAboveLine(text, line);
		docCache.set(cacheKey, meta);
		return meta;
	} catch {
		docCache.set(cacheKey, null);
		return null;
	}
}

/**
 * Clear cached docblocks (e.g. after workspace rescan).
 */
export function clearHookDocCache(): void {
	docCache.clear();
}

/**
 * Parse the nearest `/** ... *\/` block above `lineIndex`.
 */
export function parseDocblockAboveLine(
	source: string,
	lineIndex: number
): HookDocMeta | null {
	const lines = source.split(/\r?\n/);
	if (lineIndex < 0 || lineIndex >= lines.length) {
		return null;
	}

	let i = lineIndex - 1;

	// Skip blanks and PHP attributes above the call
	while (i >= 0) {
		const trimmed = lines[i].trim();
		if (trimmed === '' || trimmed.startsWith('#[')) {
			i--;
			continue;
		}
		break;
	}

	if (i < 0) return null;
	if (!lines[i].trim().endsWith('*/')) {
		return null;
	}

	const end = i;
	while (i >= 0 && !/^\s*\/\*\*/.test(lines[i])) {
		i--;
	}
	if (i < 0) return null;

	const block = lines.slice(i, end + 1).join('\n');
	return parseDocblockBody(block);
}

function parseDocblockBody(block: string): HookDocMeta | null {
	const bodyLines: string[] = [];
	for (const raw of block.split(/\r?\n/)) {
		const line = raw
			.replace(/^\s*\/\*\*\s?/, '')
			.replace(/^\s*\*\/\s*$/, '')
			.replace(/^\s*\*\s?/, '');
		bodyLines.push(line);
	}

	const descriptionParts: string[] = [];
	let since: string | undefined;
	let collectingDescription = true;

	for (const line of bodyLines) {
		const trimmed = line.trim();

		if (!trimmed) {
			// Blank line ends the summary paragraph (WP style)
			if (descriptionParts.length > 0) {
				collectingDescription = false;
			}
			continue;
		}

		const sinceMatch = trimmed.match(/^@since\s+(\S+)/i);
		if (sinceMatch) {
			if (!since) {
				since = sinceMatch[1].replace(/^['"]|['"]$/g, '');
			}
			collectingDescription = false;
			continue;
		}

		if (trimmed.startsWith('@')) {
			collectingDescription = false;
			continue;
		}

		if (collectingDescription) {
			descriptionParts.push(trimmed);
		}
	}

	const description = descriptionParts.join(' ').replace(/\s+/g, ' ').trim();
	if (!description && !since) {
		return null;
	}

	return {
		description: description || undefined,
		since,
	};
}

