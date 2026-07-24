/* Standalone logic test for HOOK_NAME_REGEX and extractHookAtPosition.
   Run: node test-diag.cjs  (no build needed — inline pure re-implementations) */

// --- Mirror of hooks.ts constants/patterns ---
const CONSUMER = ['add_action','add_filter','remove_action','remove_filter','has_action','has_filter','doing_action','doing_filter','did_action','did_filter'];
const DEFINITION = ['do_action','do_action_ref_array','do_action_deprecated','apply_filters','apply_filters_ref_array','apply_filters_deprecated'];
const HOOK_API_ALT = [...CONSUMER, ...DEFINITION].join('|');

// hookCatalog.ts regex:
const HOOK_NAME_REGEX = new RegExp(`(${HOOK_API_ALT})\\s*\\(\\s*(['"])([^'"$\\n]+)\\2`, 'g');

// hooks.ts HOOK_CALL_REGEX:
const HOOK_CALL_REGEX = new RegExp(`(${HOOK_API_ALT})\\s*\\(\\s*(['"])(.+?)\\2`, 'g');

const samples = [
  `add_action( 'init', 'cb' );`,
  `add_filter( "the_content", 'cb' );`,
  `do_action( 'my_hook' );`,
  `$this->do_action( 'init' );`,        // method named same as API (false risk)
  `add_action('wp_ajax_gliei_action', 'gliei_import_image');`,
  `do_action_ref_array( 'wp_footer', [] );`,
];

console.log('=== HOOK_NAME_REGEX (catalog indexer) ===');
for (const s of samples) {
  HOOK_NAME_REGEX.lastIndex = 0;
  const m = HOOK_NAME_REGEX.exec(s);
  console.log((m ? 'OK ' : 'NO ') + JSON.stringify(s) + ' => ' + (m ? `${m[1]} :: ${m[3]}` : 'no match'));
}

console.log('\n=== HOOK_CALL_REGEX (extractHookAtPosition) ===');
for (const s of samples) {
  HOOK_CALL_REGEX.lastIndex = 0;
  const m = HOOK_CALL_REGEX.exec(s);
  console.log((m ? 'OK ' : 'NO ') + JSON.stringify(s) + ' => ' + (m ? `${m[1]} :: ${m[3]}` : 'no match'));
}

// Test the .+? greedy-with-quote issue on multiline-ish input
const multiline = `add_action(\n    'init',\n    'cb'\n);`;
HOOK_NAME_REGEX.lastIndex = 0;
const mm = HOOK_NAME_REGEX.exec(multiline);
console.log('\nmultiline add_action => ' + (mm ? `${mm[1]} :: ${mm[3]}` : 'NO MATCH (expected: should match via \\s* across newline)'));
