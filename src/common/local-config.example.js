/**
 * Local development configuration. Copy to `local-config.js` and fill in.
 *
 *   cp src/common/local-config.example.js src/common/local-config.js
 *
 * On install, and on every background start where the value is still blank,
 * Applicator seeds its settings from this file so a freshly loaded unpacked
 * extension works without typing a key into the options page.
 *
 * `local-config.js` is gitignored. It is a convenience for local testing, not
 * a place to ship credentials: an extension's source is readable by anyone who
 * installs it. Build a release with `RELEASE=1 ./build.sh`, which leaves this
 * file out of the package.
 */
export const LOCAL_CONFIG = {
  typesafeApiKey: '',
  deepseekApiKey: ''
};
