/**
 * Detect whether a character offset sits inside a PHP comment.
 * Tracks line comments (//, #), block comments, and ignores markers inside strings.
 */

/**
 * Stateful checker for ascending offsets (regex matches). Avoids re-scanning
 * the file from 0 for every match — O(n) per file instead of O(n × matches).
 */
export function createAscendingCommentChecker(
	source: string
): (offset: number) => boolean {
	let i = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inSingle = false;
	let inDouble = false;
	let lastOffset = 0;

	const reset = () => {
		i = 0;
		inLineComment = false;
		inBlockComment = false;
		inSingle = false;
		inDouble = false;
		lastOffset = 0;
	};

	const advanceTo = (offset: number) => {
		while (i < offset) {
			const c = source[i];
			const next = i + 1 < source.length ? source[i + 1] : '';

			if (inLineComment) {
				if (c === '\n') {
					inLineComment = false;
				}
				i++;
				continue;
			}

			if (inBlockComment) {
				if (c === '*' && next === '/') {
					inBlockComment = false;
					i += 2;
					continue;
				}
				i++;
				continue;
			}

			if (inSingle) {
				if (c === '\\') {
					i += 2;
					continue;
				}
				if (c === "'") {
					inSingle = false;
				}
				i++;
				continue;
			}

			if (inDouble) {
				if (c === '\\') {
					i += 2;
					continue;
				}
				if (c === '"') {
					inDouble = false;
				}
				i++;
				continue;
			}

			if (c === '/' && next === '/') {
				inLineComment = true;
				i += 2;
				continue;
			}
			if (c === '#') {
				inLineComment = true;
				i++;
				continue;
			}
			if (c === '/' && next === '*') {
				inBlockComment = true;
				i += 2;
				continue;
			}
			if (c === "'") {
				inSingle = true;
				i++;
				continue;
			}
			if (c === '"') {
				inDouble = true;
				i++;
				continue;
			}

			i++;
		}
	};

	return (offset: number): boolean => {
		if (offset < 0 || offset > source.length) {
			return false;
		}
		if (offset < lastOffset) {
			reset();
		}
		advanceTo(offset);
		lastOffset = offset;
		return inLineComment || inBlockComment;
	};
}

/**
 * Returns true if `offset` is inside a single-line or block comment.
 */
export function isOffsetInPhpComment(source: string, offset: number): boolean {
	return createAscendingCommentChecker(source)(offset);
}

/**
 * Build line-start offsets for O(log n) offset → line/character.
 */
export function buildLineStarts(content: string): number[] {
	const starts = [0];
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10 /* \n */) {
			starts.push(i + 1);
		}
	}
	return starts;
}

/**
 * Convert absolute offset to 0-based line / character using lineStarts.
 */
export function offsetToLineCharacter(
	lineStarts: number[],
	offset: number
): { line: number; character: number } {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const start = lineStarts[mid];
		const next =
			mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.MAX_SAFE_INTEGER;
		if (offset < start) {
			hi = mid - 1;
		} else if (offset >= next) {
			lo = mid + 1;
		} else {
			return { line: mid, character: offset - start };
		}
	}
	const line = Math.max(0, Math.min(lo, lineStarts.length - 1));
	return { line, character: Math.max(0, offset - lineStarts[line]) };
}

/**
 * Line-offset helper: absolute char index of column on a given line.
 * Uses the same newline convention as source.split("\\n").
 */
export function offsetAtLine(
	lines: string[],
	lineIdx: number,
	column: number
): number {
	let offset = 0;
	for (let i = 0; i < lineIdx; i++) {
		offset += lines[i].length + 1; // +1 for newline
	}
	return offset + column;
}

/**
 * True if a document position sits inside a PHP comment.
 */
export function isPositionInPhpComment(
	source: string,
	line: number,
	character: number
): boolean {
	const lines = source.split('\n');
	if (line < 0 || line >= lines.length) {
		return false;
	}
	return isOffsetInPhpComment(source, offsetAtLine(lines, line, character));
}
