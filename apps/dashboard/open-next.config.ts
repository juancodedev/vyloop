import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// No incremental cache. This application is migrated as it is: no ISR, no R2 or
// KV cache layer, which the change puts explicitly out of scope.
//
// This is the adapter's own no-cache shape, not an invention: `createOpenNextConfigFile`
// writes the full template and then comments out the R2 import and the
// `incrementalCache` key when caching is off, leaving `defineCloudflareConfig({})`.
export default defineCloudflareConfig({});
