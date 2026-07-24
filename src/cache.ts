/**
 * Cache layer for hook resolution results.
 * Map with TTL + LRU eviction to bound memory.
 */
import * as vscode from 'vscode';
import { CACHE_MAX_ENTRIES, CACHE_TTL_SECONDS } from './config';

export interface CachedLocation {
	uri: string;
	line: number;
	character: number;
}

export interface CacheEntry {
	locations: CachedLocation[];
	timestamp: number;
}

/**
 * In-memory LRU + TTL cache for hook resolution results.
 */
export class HookCache {
	private cache = new Map<string, CacheEntry>();

	get(key: string): CachedLocation[] | null {
		const entry = this.cache.get(key);
		if (!entry) return null;

		const age = (Date.now() - entry.timestamp) / 1000;
		if (age > CACHE_TTL_SECONDS) {
			this.cache.delete(key);
			return null;
		}

		// LRU: refresh insertion order
		this.cache.delete(key);
		this.cache.set(key, entry);

		return entry.locations;
	}

	set(key: string, locations: CachedLocation[]): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		}

		this.cache.set(key, {
			locations,
			timestamp: Date.now(),
		});

		this.evictIfNeeded();
	}

	invalidate(key: string): void {
		this.cache.delete(key);
	}

	invalidateFile(fileUri: string): void {
		for (const [key, entry] of this.cache) {
			const involvesFile = entry.locations.some(
				(loc) => loc.uri === fileUri
			);
			if (involvesFile) {
				this.cache.delete(key);
			}
		}
	}

	/** Drop cached lookups for a specific hook name (both sides). */
	invalidateHook(hookName: string): void {
		this.cache.delete(`registration:${hookName}`);
		this.cache.delete(`definition:${hookName}`);
	}

	clear(): void {
		this.cache.clear();
	}

	private evictIfNeeded(): void {
		while (this.cache.size > CACHE_MAX_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}

	toVscLocations(cached: CachedLocation[]): vscode.Location[] {
		return cached.map((loc) => {
			return new vscode.Location(
				vscode.Uri.parse(loc.uri),
				new vscode.Position(loc.line, loc.character)
			);
		});
	}

	fromVscLocations(locations: vscode.Location[]): CachedLocation[] {
		return locations.map((loc) => ({
			uri: loc.uri.toString(),
			line: loc.range.start.line,
			character: loc.range.start.character,
		}));
	}
}
