# Delta for Customer Web

## ADDED Requirements

### Requirement: Real Profile Data

The `/profile` page MUST fetch data from `GET /v1/customers/me` and display the customer's real points balance, current tier name, and total points earned. Placeholder/hardcoded data MUST be removed entirely.

The page MUST show a loading state while fetching and MUST handle API errors gracefully with a retry option.

#### Scenario: Profile shows real data

- GIVEN an authenticated customer with 750 points in Plata tier
- WHEN `/profile` loads
- THEN "750 puntos", "Plata", and total earned are displayed from API response

#### Scenario: API failure graceful handling

- GIVEN the `/me` endpoint returns an error
- WHEN `/profile` renders
- THEN error message shown with a "Retry" button
- AND no placeholder data is displayed

### Requirement: Transaction History Page

The `/profile/history` page MUST fetch `GET /v1/loyalty/points/transactions?customer_id={self}` and render a chronological list of earn and redeem movements. The page MUST provide filter tabs: **All**, **Earned**, **Redeemed**. Each entry MUST display signed points (`+` for earn, `-` for redeem), transaction type label, date, and reference.

#### Scenario: All transactions shown by default

- GIVEN customer has 3 earn and 2 redeem transactions
- WHEN `/profile/history` loads
- THEN all 5 transactions displayed, newest first

#### Scenario: Filter by earned

- GIVEN filter tabs rendered
- WHEN user taps "Earned"
- THEN only earn transactions visible

#### Scenario: Empty history

- GIVEN customer has no transactions
- WHEN `/profile/history` loads
- THEN "No transactions yet" empty state shown
