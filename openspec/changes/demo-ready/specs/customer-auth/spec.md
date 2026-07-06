# Customer Auth Specification

## Purpose

Phone-based JWT issuance for customer web login. Single endpoint designed for future OTP integration.

## Requirements

### Requirement: Token Issuance

`POST /v1/auth/customer/token` MUST accept `{phone: string}`, look up customer by phone, resolve `globalId`, and return `{token: string}` — signed JWT with `role: customer`.

**JWT claims**: `sub` (customer globalId), `business_id`, `role: "customer"`, `scopes: ["rewards:read", "rewards:redeem"]`.

#### Scenario: Valid phone — JWT issued

- GIVEN a known phone number
- WHEN `POST /v1/auth/customer/token` with `{"phone": "+521234567890"}`
- THEN 200 with signed JWT containing `sub`, `business_id`, `role: "customer"`
- AND the JWT is verifiable by existing gateway middleware (HS256)

#### Scenario: Unknown phone — 404

- GIVEN a phone with no customer record
- WHEN `POST /v1/auth/customer/token`
- THEN 404 `CUSTOMER_NOT_FOUND`

#### Scenario: Invalid phone format — 400

- GIVEN a phone that doesn't match E.164 or + format
- WHEN `POST /v1/auth/customer/token`
- THEN 400 `INVALID_PHONE_FORMAT`

### Architecture Note

No real OTP for demo — endpoint issues JWT immediately on phone lookup. The endpoint signature `{phone, otp?}` is designed so OTP verification can be added as an optional pre-step without breaking the interface.
