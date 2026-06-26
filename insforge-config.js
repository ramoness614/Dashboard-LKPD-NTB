/* ============================================================================
 * insforge-config.js — Frontend connection to the InsForge backend.
 *
 * Fill in baseUrl + anonKey to switch the dashboard from offline/demo data to
 * live database data. Until both are set, the dashboard runs in demo mode
 * (deterministic illustrative data) and never calls the network.
 *
 *   baseUrl : the project's "oss_host", e.g. https://<app>.us-east.insforge.app
 *             -> from `.insforge/project.json` (field "oss_host")
 *   anonKey : public anon key
 *             -> `npx @insforge/cli secrets get ANON_KEY`
 *
 * The anon key is safe to expose in the browser (RLS makes all dashboard data
 * public-read). NEVER put the admin API key or OPENROUTER_API_KEY here.
 * ========================================================================== */
(function () {
  var BASE_URL = 'https://ya7n3w7i.ap-southeast.insforge.app';
  var ANON_KEY = 'anon_5758ffea3758d0c527a256db754649220b1851b87566ae65d3dfae62237f4695';

  if (BASE_URL && ANON_KEY) {
    window.APBD_CONFIG = {
      baseUrl: BASE_URL,
      anonKey: ANON_KEY,
      storageBucket: 'reports',
      // sdkUrl: 'https://esm.sh/@insforge/sdk@latest', // override if self-hosting the SDK
    };
  }
  // else: leave window.APBD_CONFIG undefined -> dashboard stays in demo mode.
})();
