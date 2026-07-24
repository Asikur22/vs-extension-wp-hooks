/**
 * Cancellable status-bar progress for large WP Hooks workspace scans.
 */
import * as vscode from 'vscode';

export type ScanProgress = vscode.Progress<{ message?: string }>;

/**
 * Run a long scan under a Window (status bar) progress indicator.
 * User can cancel via the progress UI; parent tokens are linked too.
 */
export async function withHookScanProgress<T>(
	options: {
		title?: string;
		message: string;
		token?: vscode.CancellationToken;
	},
	task: (
		progress: ScanProgress,
		token: vscode.CancellationToken
	) => Promise<T>
): Promise<T> {
	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Window,
			title: options.title ?? 'WP Hooks',
			cancellable: true,
		},
		async (progress, progressToken) => {
			const cts = new vscode.CancellationTokenSource();
			const disposables: vscode.Disposable[] = [
				progressToken.onCancellationRequested(() => cts.cancel()),
			];
			if (options.token) {
				disposables.push(
					options.token.onCancellationRequested(() => cts.cancel())
				);
			}

			progress.report({ message: options.message });

			try {
				return await task(progress, cts.token);
			} finally {
				for (const d of disposables) {
					d.dispose();
				}
				cts.dispose();
			}
		}
	);
}

/**
 * Format a compact scan status message.
 */
export function scanMessage(
	phase: string,
	detail?: string
): string {
	return detail ? `${phase}: ${detail}` : phase;
}
