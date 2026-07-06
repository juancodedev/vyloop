# Customer Redeem Specification

## Purpose

Reward catalog browsing and redemption flow in customer-web. Mobile-first, follows customer-web design patterns.

## Requirements

### Requirement: Browse Reward Catalog

`GET /v1/loyalty/rewards?active=true` MUST return active rewards with `id`, `name`, `description`, `pointsCost`, `imageUrl`, `stock`.

#### Scenario: Catalog displayed

- GIVEN customer is authenticated
- WHEN visiting `/profile/rewards`
- THEN reward cards are shown with name, points cost, stock, image
- AND each card has a "Redeem" button

### Requirement: Confirm Redemption

`POST /v1/loyalty/rewards/redeem` MUST accept `{rewardId: string}`, deduct points, return `{success: true, remainingBalance, rewardName}`.

#### Scenario: Successful redeem

- GIVEN customer has sufficient points and reward is in stock
- WHEN confirming redemption
- THEN points are deducted
- AND confirmation screen shows reward name and remaining balance

#### Scenario: Insufficient balance

- GIVEN customer has fewer points than the reward costs
- WHEN confirming redemption
- THEN error message "Insufficient points" is shown
- AND points are NOT deducted

#### Scenario: Out of stock

- GIVEN reward has `stock: 0`
- WHEN confirming redemption
- THEN error message "Out of stock" is shown
- AND points are NOT deducted

#### Scenario: Expired reward

- GIVEN reward's validity period has passed
- WHEN confirming redemption
- THEN error message "Reward expired" is shown
- AND points are NOT deducted
