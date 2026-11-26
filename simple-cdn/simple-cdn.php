<?php
/**
 * Plugin Name:       Simple CDN
 * Description:       Point your site's images (and optionally other static files) at a CDN hostname. Two URL styles: "host swap" (a Cloudflare-proxied subdomain) or "worker" (an ImgPro-style Cloudflare Worker with R2).
 * Version:           1.1.1
 * Requires at least: 5.1
 * Requires PHP:      7.4
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       simple-cdn
 *
 * Inspired by CDN Enabler (KeyCDN, GPLv2+) and Bandwidth Saver (ImgPro, GPLv2+).
 *
 * HOW IT WORKS (the whole idea in five lines):
 *   1. On every front-end page load we start PHP output buffering.
 *   2. When WordPress has finished printing the page, we get the full HTML as one string.
 *   3. One regular expression finds URLs that (a) belong to this site and (b) end in a
 *      configured file extension.
 *   4. Each match gets its host swapped for a CDN host. Which CDN depends on the file
 *      extension (e.g. .jpg -> media CDN, .css -> static CDN). In worker mode the original
 *      host is also moved into the path so the Worker knows where to fetch from.
 *   5. The rewritten HTML is sent to the browser.
 *
 * Because we rewrite the final HTML, we catch everything: post content, theme templates,
 * inline CSS backgrounds, lazy-load data-src attributes, JSON blobs in <script> tags.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Simple_CDN {

	const OPTION      = 'simple_cdn';
	const GROUP       = 'simple_cdn_group';
	const MODE_HOST   = 'host_swap'; // https://cdn.example.com/wp-content/uploads/a.jpg
	const MODE_WORKER = 'worker';    // https://cdn.example.com/example.com/wp-content/uploads/a.jpg

	/* ------------------------------------------------------------------ *
	 * Bootstrap
	 * ------------------------------------------------------------------ */

	public static function init() {
		// template_redirect only fires for front-end page views, so wp-admin, REST, cron,
		// WP-CLI and admin-ajax are never touched. No "is this an unsafe context?" checks needed.
		add_action( 'template_redirect', array( __CLASS__, 'start_buffering' ), 1 );

		if ( is_admin() ) {
			add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
			add_action( 'admin_menu', array( __CLASS__, 'add_settings_page' ) );
			add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), array( __CLASS__, 'action_links' ) );
		}
	}

	/** Settings for one CDN slot. */
	public static function default_target( $index ) {
		return array(
			'hostname'   => '',
			'mode'       => self::MODE_HOST,
			'extensions' => ( 0 === $index )
				? array( 'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico' )
				: array( 'css', 'js', 'woff', 'woff2', 'ttf', 'otf', 'eot' ),
		);
	}

	public static function defaults() {
		return array(
			'enabled'  => false,
			'targets'  => array( self::default_target( 0 ), self::default_target( 1 ) ),
			'excluded' => array(),
		);
	}

	public static function get_options() {
		$saved = get_option( self::OPTION, array() );
		$saved = is_array( $saved ) ? $saved : array();

		// v1.0.0 stored one flat CDN; fold it into slot 0.
		if ( ! isset( $saved['targets'] ) && isset( $saved['cdn_hostname'] ) ) {
			$saved['targets'] = array(
				array(
					'hostname'   => $saved['cdn_hostname'],
					'mode'       => $saved['mode'] ?? self::MODE_HOST,
					'extensions' => $saved['extensions'] ?? self::default_target( 0 )['extensions'],
				),
			);
		}

		$o = wp_parse_args( $saved, self::defaults() );
		foreach ( array( 0, 1 ) as $i ) {
			$o['targets'][ $i ] = wp_parse_args( $o['targets'][ $i ] ?? array(), self::default_target( $i ) );
		}
		return $o;
	}

	/**
	 * On first activation, borrow the CDN hostname from the plugins this one replaces,
	 * so nobody has to retype it. Old plugins' settings are left untouched.
	 */
	public static function on_activate() {
		if ( false !== get_option( self::OPTION, false ) ) {
			return; // Already configured.
		}

		$import = self::defaults();
		$host   = '';
		$mode   = self::MODE_HOST;

		$bandwidth_saver = get_option( 'imgpro_cdn_settings' );
		$cdn_enabler     = get_option( 'cdn_enabler' );

		if (
			is_array( $bandwidth_saver )
			&& 'cloudflare' === ( $bandwidth_saver['setup_mode'] ?? '' ) // Its "self-hosted" mode.
			&& ! empty( $bandwidth_saver['cdn_url'] )
		) {
			$host = self::sanitize_hostname( $bandwidth_saver['cdn_url'] );
			$mode = self::MODE_WORKER;
		} elseif ( is_array( $cdn_enabler ) && ! empty( $cdn_enabler['cdn_hostname'] ) ) {
			$host = self::sanitize_hostname( $cdn_enabler['cdn_hostname'] );
		}

		if ( '' !== $host ) {
			$import['targets'][0]['hostname'] = $host;
			$import['targets'][0]['mode']     = $mode;
			$import['enabled']                = true;
			add_option( self::OPTION, $import );
		}
	}

	/* ------------------------------------------------------------------ *
	 * Output buffering
	 * ------------------------------------------------------------------ */

	public static function start_buffering() {
		$o = self::get_options();

		if ( empty( $o['enabled'] ) || self::should_bypass() ) {
			return;
		}

		$config = self::build_config( $o );
		if ( empty( $config['targets'] ) ) {
			return; // No CDN hostname configured.
		}

		ob_start(
			function ( $html, $phase ) use ( $config ) {
				// If something calls ob_flush() mid-page we'd receive half a page and could
				// cut a URL in two. Only rewrite when PHP hands us the final buffer.
				if ( $phase & ( PHP_OUTPUT_HANDLER_FINAL | PHP_OUTPUT_HANDLER_END ) ) {
					return Simple_CDN::rewrite( $html, $config );
				}
				return $html;
			}
		);
	}

	private static function should_bypass() {
		/** Return true from this filter to skip rewriting for the current request. */
		if ( apply_filters( 'simple_cdn_bypass', false ) ) {
			return true;
		}
		if ( ! isset( $_SERVER['REQUEST_METHOD'] ) || 'GET' !== $_SERVER['REQUEST_METHOD'] ) {
			return true;
		}
		return is_preview() || is_customize_preview() || is_robots() || is_trackback();
	}

	/**
	 * Turn saved options into the plain array that rewrite() needs.
	 */
	private static function build_config( array $o ) {
		$home_host = (string) wp_parse_url( home_url(), PHP_URL_HOST );

		// Which hostnames count as "our site"? We deliberately do NOT read the HTTP Host
		// header: it is attacker-controlled, and a page cache could store a response whose
		// image URLs were built from a forged Host.
		$hosts = array( $home_host, (string) wp_parse_url( site_url(), PHP_URL_HOST ) );

		/** Add extra hostnames (e.g. a www/non-www twin) that should also be rewritten. */
		$hosts = (array) apply_filters( 'simple_cdn_site_hostnames', $hosts );
		$hosts = array_values( array_unique( array_filter( array_map( 'strtolower', array_map( 'strval', $hosts ) ) ) ) );

		$targets = array();
		foreach ( $o['targets'] as $t ) {
			if ( '' !== $t['hostname'] ) {
				$targets[] = array(
					'cdn_host'   => $t['hostname'],
					'mode'       => $t['mode'],
					'extensions' => (array) $t['extensions'],
				);
			}
		}

		return array(
			'targets'    => $targets,
			'home_host'  => strtolower( $home_host ),
			'site_hosts' => $hosts,
			'excluded'   => (array) $o['excluded'],
		);
	}

	/* ------------------------------------------------------------------ *
	 * The rewrite engine (pure function: string in, string out)
	 * ------------------------------------------------------------------ */

	/**
	 * @param string $html   Page HTML (or any string).
	 * @param array  $config See build_config().
	 * @return string
	 */
	public static function rewrite( $html, array $config ) {
		if ( ! is_string( $html ) || '' === $html || empty( $config['site_hosts'] ) ) {
			return $html;
		}

		// Routing table: file extension -> the CDN that serves it. If two CDNs claim the
		// same extension, the first one wins.
		$by_ext = array();
		foreach ( (array) ( $config['targets'] ?? array() ) as $target ) {
			if ( empty( $target['cdn_host'] ) ) {
				continue;
			}
			foreach ( (array) $target['extensions'] as $ext ) {
				$ext = strtolower( (string) $ext );
				if ( '' !== $ext && ! isset( $by_ext[ $ext ] ) ) {
					$by_ext[ $ext ] = $target;
				}
			}
		}
		if ( ! $by_ext ) {
			return $html;
		}

		$hosts = implode( '|', array_map( function ( $h ) { return preg_quote( $h, '~' ); }, $config['site_hosts'] ) );
		$exts  = implode( '|', array_map( function ( $e ) { return preg_quote( (string) $e, '~' ); }, array_keys( $by_ext ) ) );

		// A URL-path character is anything except whitespace, quotes, <>, parentheses, comma,
		// backslash, ? and #... with one exception: the pair "\/" is allowed, so JSON-escaped
		// URLs (https:\/\/example.com\/a.jpg) work. Excluding ? and # stops the path before
		// query strings and fragments; excluding bare backslashes also stops us from
		// mangling things like the JavaScript regex /\.jpg$/.
		$char = '(?:[^\s"\'<>(),\\\\?#]|\\\\/)';

		$pattern = '~'
			// Branch 1: absolute or protocol-relative URL on one of our hosts.
			. '(?:(?<abs>(?:https?:)?(?:\\\\?/){2})(?<host>' . $hosts . ')'
			// Branch 2: root-relative URL (/wp-content/...). Zero-width: it only checks that the
			// previous character is a delimiter, and that the next two characters are not "//".
			. '|(?<=["\'(=\s,])(?!(?:\\\\?/){2}))'
			// The path: starts with a slash, ends with one of our extensions.
			. '(?<path>\\\\?/' . $char . '*?\.(?<ext>' . $exts . '))'
			// Optional query string (kept as-is).
			. '(?<query>\?[^\s"\'<>(),\\\\]*)?'
			// The URL must end here: whitespace, quote, bracket, comma, "&", backslash, ?, # or end.
			// This is what stops ".jpg" from matching inside ".jpgx" or ".jpg.php".
			. '(?=[\s"\'<>(),&\\\\?#]|$)'
			. '~i';

		return preg_replace_callback(
			$pattern,
			function ( $m ) use ( $config, $by_ext ) {
				$url    = $m[0];
				$target = $by_ext[ strtolower( $m['ext'] ) ] ?? null;
				if ( ! $target ) {
					return $url;
				}

				// Match exclusions against the URL both as written and with escaped
				// slashes normalized, so "/a.jpg" also catches "a\/b.jpg" in JSON.
				$unescaped = str_replace( '\\/', '/', $url );
				foreach ( $config['excluded'] as $needle ) {
					if ( '' !== $needle && ( false !== strpos( $url, $needle ) || false !== strpos( $unescaped, $needle ) ) ) {
						return $url;
					}
				}

				// Keep the original slash style: "\/" inside JSON, "/" everywhere else.
				$slash = ( false !== strpos( $url, '\\/' ) ) ? '\\/' : '/';

				$out = 'https:' . $slash . $slash . $target['cdn_host'];

				if ( self::MODE_WORKER === $target['mode'] ) {
					// The Worker reads the origin domain from the first path segment.
					// Root-relative URLs have no host of their own, so use the site's.
					$origin = ( ! empty( $m['host'] ) ) ? strtolower( $m['host'] ) : $config['home_host'];
					$out   .= $slash . $origin;
				}

				return $out . $m['path'] . ( $m['query'] ?? '' );
			},
			$html
		);
	}

	/* ------------------------------------------------------------------ *
	 * Settings
	 * ------------------------------------------------------------------ */

	public static function register_settings() {
		register_setting(
			self::GROUP,
			self::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize_options' ),
				'default'           => self::defaults(),
			)
		);
	}

	/**
	 * Reduce a user-typed value to a bare hostname ("cdn.example.com"), or '' if invalid.
	 * Accepts "https://cdn.example.com/whatever" and strips the extras.
	 */
	public static function sanitize_hostname( $value ) {
		$value = strtolower( trim( (string) $value ) );
		$value = preg_replace( '~^(?:[a-z][a-z0-9+.\-]*:)?//~', '', $value );
		$value = preg_replace( '~[/?#].*$~', '', $value );

		$valid = '/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/';
		return preg_match( $valid, $value ) ? $value : '';
	}

	/**
	 * Accept a textarea string OR an already-split array, and return a string.
	 *
	 * WordPress runs a setting's sanitize callback TWICE the first time the option is saved
	 * (update_option() falls through to add_option(), which sanitizes again). The second
	 * time, the input is our own previous output: arrays, not text. Casting an array to a
	 * string gives the literal word "Array", so every sanitizer here must be idempotent.
	 */
	private static function to_text( $raw ) {
		if ( is_array( $raw ) ) {
			return implode( "\n", array_map( 'strval', array_filter( $raw, 'is_scalar' ) ) );
		}
		return is_scalar( $raw ) ? (string) $raw : '';
	}

	/** "jpg, .PNG\nwebp" -> array( 'jpg', 'png', 'webp' ) */
	private static function sanitize_extensions( $raw ) {
		$exts = array();
		foreach ( preg_split( '/[\s,]+/', strtolower( self::to_text( $raw ) ), -1, PREG_SPLIT_NO_EMPTY ) as $ext ) {
			$ext = preg_replace( '/[^a-z0-9]/', '', ltrim( $ext, '.' ) );
			if ( '' !== $ext ) {
				$exts[] = $ext;
			}
		}
		return array_values( array_unique( $exts ) );
	}

	public static function sanitize_options( $input ) {
		$input = is_array( $input ) ? $input : array();
		$out   = self::defaults();

		$out['enabled'] = ! empty( $input['enabled'] );
		$site_host      = strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) );
		$seen_hosts     = array();
		$seen_exts      = array();

		foreach ( array( 0, 1 ) as $i ) {
			$in    = ( isset( $input['targets'][ $i ] ) && is_array( $input['targets'][ $i ] ) ) ? $input['targets'][ $i ] : array();
			$label = sprintf( 'CDN %d', $i + 1 );

			$raw_host = self::to_text( $in['hostname'] ?? '' );
			$host     = self::sanitize_hostname( $raw_host );

			if ( '' !== trim( $raw_host ) && '' === $host ) {
				/* translators: %s: CDN slot label */
				add_settings_error( self::OPTION, 'bad_host_' . $i, sprintf( __( '%s: that does not look like a valid hostname. Example: cdn.example.com', 'simple-cdn' ), $label ) );
			}
			// A CDN host equal to the site host would rewrite URLs to themselves; two slots
			// with the same host would just be confusing.
			if ( '' !== $host && ( $host === $site_host || isset( $seen_hosts[ $host ] ) ) ) {
				/* translators: %s: CDN slot label */
				add_settings_error( self::OPTION, 'dup_host_' . $i, sprintf( __( '%s: the hostname must differ from your site hostname and from the other CDN.', 'simple-cdn' ), $label ) );
				$host = '';
			}
			if ( '' !== $host ) {
				$seen_hosts[ $host ] = true;
			}

			// Empty stays empty: a cleared list is a valid choice, and a list emptied
			// by the clash rule below must not refill with defaults on the next save.
			$exts = self::sanitize_extensions( $in['extensions'] ?? '' );

			// One extension can only go to one CDN, and only enabled CDNs (hostname
			// set) reserve theirs. Earlier slots win.
			if ( '' !== $host ) {
				$clash = array_values( array_intersect( $exts, array_keys( $seen_exts ) ) );
				if ( $clash ) {
					$exts = array_values( array_diff( $exts, $clash ) );
					/* translators: 1: CDN slot label, 2: extension list */
					add_settings_error( self::OPTION, 'ext_clash_' . $i, sprintf( __( '%1$s: removed extensions already used by an earlier CDN: %2$s', 'simple-cdn' ), $label, implode( ', ', $clash ) ), 'warning' );
				}
				foreach ( $exts as $e ) {
					$seen_exts[ $e ] = true;
				}
			}

			$out['targets'][ $i ] = array(
				'hostname'   => $host,
				'mode'       => ( isset( $in['mode'] ) && self::MODE_WORKER === $in['mode'] ) ? self::MODE_WORKER : self::MODE_HOST,
				'extensions' => $exts,
			);
		}

		// Excluded: one substring per line (case-sensitive).
		$excluded = array();
		foreach ( preg_split( '/\R/', self::to_text( $input['excluded'] ?? '' ), -1, PREG_SPLIT_NO_EMPTY ) as $line ) {
			$line = trim( sanitize_text_field( $line ) );
			if ( '' !== $line ) {
				$excluded[] = $line;
			}
		}
		$out['excluded'] = array_values( array_unique( $excluded ) );

		return $out;
	}

	public static function add_settings_page() {
		add_options_page( 'Simple CDN', 'Simple CDN', 'manage_options', 'simple-cdn', array( __CLASS__, 'render_settings_page' ) );
	}

	public static function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=simple-cdn' ) ) . '">' . esc_html__( 'Settings', 'simple-cdn' ) . '</a>' );
		return $links;
	}

	public static function render_settings_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}

		$o      = self::get_options();
		$name   = self::OPTION;
		$config = self::build_config( $o );

		// Live preview: run the real engine on sample URLs so you can see exactly where each
		// file type is sent.
		$samples = array(
			home_url( '/wp-content/uploads/2026/01/photo.jpg' ),
			home_url( '/wp-content/themes/mytheme/style.css' ),
			home_url( '/wp-content/themes/mytheme/fonts/body.woff2' ),
		);
		?>
		<div class="wrap">
			<h1>Simple CDN</h1>
			<?php settings_errors( self::OPTION ); ?>

			<form method="post" action="options.php">
				<?php settings_fields( self::GROUP ); ?>

				<p><label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[enabled]" value="1" <?php checked( $o['enabled'] ); ?>>
					<strong><?php esc_html_e( 'Rewrite URLs on the front end', 'simple-cdn' ); ?></strong></label></p>

				<?php foreach ( array( 0, 1 ) as $i ) : ?>
					<?php
					$t      = $o['targets'][ $i ];
					$prefix = $name . '[targets][' . $i . ']';
					?>
					<h2>
						<?php
						echo esc_html( sprintf( 'CDN %d', $i + 1 ) );
						if ( 1 === $i ) {
							echo ' <span class="description">(' . esc_html__( 'optional', 'simple-cdn' ) . ')</span>';
						}
						?>
					</h2>
					<table class="form-table" role="presentation">
						<tr>
							<th scope="row"><label for="simple-cdn-host-<?php echo (int) $i; ?>"><?php esc_html_e( 'Hostname', 'simple-cdn' ); ?></label></th>
							<td>
								<input id="simple-cdn-host-<?php echo (int) $i; ?>" type="text" class="regular-text" name="<?php echo esc_attr( $prefix ); ?>[hostname]" value="<?php echo esc_attr( $t['hostname'] ); ?>" placeholder="<?php echo 0 === $i ? 'media.example.com' : 'static.example.com'; ?>">
								<p class="description"><?php esc_html_e( 'Hostname only. Leave empty to disable this CDN.', 'simple-cdn' ); ?></p>
							</td>
						</tr>
						<tr>
							<th scope="row"><?php esc_html_e( 'URL style', 'simple-cdn' ); ?></th>
							<td>
								<label><input type="radio" name="<?php echo esc_attr( $prefix ); ?>[mode]" value="<?php echo esc_attr( self::MODE_HOST ); ?>" <?php checked( $t['mode'], self::MODE_HOST ); ?>>
									<strong><?php esc_html_e( 'Host swap', 'simple-cdn' ); ?></strong> <code>https://cdn.example.com/wp-content/uploads/a.jpg</code></label>
								<p class="description"><?php esc_html_e( 'The hostname serves the same paths as your site (e.g. a Cloudflare-proxied CNAME to your server). Works for any file type.', 'simple-cdn' ); ?></p>
								<br>
								<label><input type="radio" name="<?php echo esc_attr( $prefix ); ?>[mode]" value="<?php echo esc_attr( self::MODE_WORKER ); ?>" <?php checked( $t['mode'], self::MODE_WORKER ); ?>>
									<strong><?php esc_html_e( 'Worker', 'simple-cdn' ); ?></strong> <code>https://cdn.example.com/example.com/wp-content/uploads/a.jpg</code></label>
								<p class="description"><?php esc_html_e( 'An ImgPro-style Cloudflare Worker + R2. It only serves images, video and audio, so keep CSS/JS/fonts out of this CDN.', 'simple-cdn' ); ?></p>
							</td>
						</tr>
						<tr>
							<th scope="row"><label for="simple-cdn-ext-<?php echo (int) $i; ?>"><?php esc_html_e( 'File extensions', 'simple-cdn' ); ?></label></th>
							<td>
								<textarea id="simple-cdn-ext-<?php echo (int) $i; ?>" class="small-text code" rows="6" cols="20" name="<?php echo esc_attr( $prefix ); ?>[extensions]"><?php echo esc_textarea( implode( "\n", $t['extensions'] ) ); ?></textarea>
								<p class="description"><?php esc_html_e( 'One per line, without the dot. Each extension can belong to only one CDN.', 'simple-cdn' ); ?></p>
							</td>
						</tr>
					</table>
				<?php endforeach; ?>

				<h2><?php esc_html_e( 'Exclusions', 'simple-cdn' ); ?></h2>
				<textarea class="regular-text code" rows="4" name="<?php echo esc_attr( $name ); ?>[excluded]"><?php echo esc_textarea( implode( "\n", $o['excluded'] ) ); ?></textarea>
				<p class="description"><?php esc_html_e( 'Any URL containing one of these strings (one per line, case-sensitive) is left alone. Example: /sw.js (service workers must stay on your own domain).', 'simple-cdn' ); ?></p>

				<?php submit_button(); ?>
			</form>

			<h2><?php esc_html_e( 'Preview', 'simple-cdn' ); ?></h2>
			<?php foreach ( $samples as $sample ) : ?>
				<p><code><?php echo esc_html( $sample ); ?></code><br>
				&rarr; <code><?php echo esc_html( self::rewrite( $sample, $config ) ); ?></code></p>
			<?php endforeach; ?>
		</div>
		<?php
	}
}

register_activation_hook( __FILE__, array( 'Simple_CDN', 'on_activate' ) );
add_action( 'plugins_loaded', array( 'Simple_CDN', 'init' ) );
