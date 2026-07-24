<?php
/**
 * Test plugin for WP Hooks extension verification.
 */

// Definition site with docblock
/**
 * Fires after settings are saved.
 *
 * @since 1.0.0
 */
do_action( 'gliei_after_save', $post_id );

// Registration site
add_action( 'gliei_after_save', 'gliei_handle_save' );

/**
 * Filter image side load extensions.
 *
 * @since 2.0.0
 */
apply_filters( 'image_sideload_extensions', array( 'jpg', 'png' ) );

add_filter( 'image_sideload_extensions', 'gliei_ext_cb' );

// Static class callback
add_action( 'init', array( 'GLIEI_Loader', 'boot' ) );

class GLIEI_Loader {
	public static function boot() {}
	public function handle_save() {}
}

function gliei_handle_save() {}
function gliei_ext_cb( $e ) { return $e; }
