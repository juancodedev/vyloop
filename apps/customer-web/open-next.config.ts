import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// No incremental cache, for the same reason as the dashboard: this application
// is migrated as it is, and the change puts ISR and cache layers out of scope.
//
// This is the adapter's own no-cache shape: `createOpenNextConfigFile` writes the
// full template and then comments out the R2 import and the `incrementalCache`
// key when caching is off, which leaves exactly this.
export default defineCloudflareConfig({});
