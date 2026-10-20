# Delta for event-ingestor

## REMOVED Requirements

### Requirement: Ingestion

**Reason**: `POST /v1/events/{type}` has no caller in the product, is mounted before the gateway's authentication, takes the tenant from the request body, and is documented with event names (`purchase`, `custom`) that the registry does not hold. It is retired rather than fixed (decision point recorded in the proposal; Option R).

**Migration**: None required; nothing calls the route. If an external integration is scheduled later, a new authenticated ingestion contract is specified in its own change (Option K in the proposal).

### Requirement: TestEvent

**Reason**: The dev-only `test_event` path exists only on the retired route.

**Migration**: Queue tests publish through `@vyloop/event-bus` directly, as the workers' own tests already do.

### Requirement: Error Codes

**Reason**: The error codes `SCHEMA_INVALID`, `EVENT_TYPE_UNKNOWN` and `RATE_LIMIT_EXCEEDED` described the retired route's responses.

**Migration**: None. `RATE_LIMIT_EXCEEDED` remains defined by the api-gateway capability for every routed path.
