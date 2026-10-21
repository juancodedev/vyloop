# Proposal: Push Transport

## Intent

Let a customer receive a message on their phone, and let the platform send one
when there is something to say.

This is the transport. It makes a push message _possible_ and _correct_: a
browser can register itself, the platform knows where to deliver, the message
is encrypted to the browser's key, and what the push service answers is
interpreted. What triggers a message — a branch near the customer, a reward
waiting, a campaign — is the next phase, and nothing here depends on which.

## The constraint that shapes everything

**Web Push cannot geofence in the background.** A Progressive Web App does not
run when the page is closed, and Safari on iOS has never supported Web Push
without the site being installed to the Home Screen. So a message cannot
arrive because the customer walked into a place. It arrives because something
the platform already knows happened — a check-in, a reward, a campaign — and the
customer agreed to be told about it.

That is why the consent this change asks for is the one for **nearby
notifications** and not a "we will notify you about anything" consent. The
customer agrees to a category of message, and the platform sends that category.

## Scope

### In Scope

1. A `push_subscriptions` table: one row per browser registration, with the
   endpoint, the browser's public key and its auth secret.
2. `message_log.push_endpoint_hash`: a digest of the endpoint, so a delivery can
   be traced without the capability being written down.
3. Three endpoints on the communication worker: register a browser, remove it,
   list them.
4. A consent gate on registration, and **the same gate again at the moment of
   the delivery**.
5. The `PushNotificationRequested` event, its schema, and the delivery handler.
6. The encryption (RFC 8291, `aes128gcm`) and the VAPID signing (RFC 8292),
   on WebCrypto.
7. The client: a web manifest, a service worker, and the subscription helper.
8. The communication worker becomes a **consumer** of a delivery queue of
   its own, and the producers publish deliveries there.
9. The VAPID key pair, held as secrets and passed to the deploy.

### Out of Scope

- **What triggers a message.** Proximity, campaigns and rewards are the next
  phase.
- **Enabling the customer-web consent controls.** The backend can now record a
  consent; the controls still render as unavailable. Turning them on is a
  product decision about what the business asks a customer to agree to.
- **A native application.** Background geofencing needs one, and it is a
  different project.
- **Email.** The transport is a channel; the next channel is another transport.

## Capabilities

### New Capabilities

- `push-notifications`: registering a browser, the consent that governs it, the
  delivery, and what each answer from the push service means.

### Modified Capabilities

- `database`: the `push_subscriptions` table and the `message_log` digest.
- `event-bus`: the `PushNotificationRequested` event.
- `schema-registry`: the schema that event's payload is validated against.

## Approach

**Storage.** One row per browser registration. The unique index is on the
`endpoint` alone: a browser rotates its keys for the same endpoint, so
registering again is the same registration with newer keys, and a browser that
signs out and is used by a different customer has to _move_ rather than
accumulate.

**The endpoint is a capability.** Anyone holding it can push to that browser. It
is stored because it has to be, and it is treated as a secret everywhere else:
never in a log, and only ever a SHA-256 digest in `message_log`.

**The consent is checked twice.** Once when the browser registers, and again
when a message is delivered. A gate that only runs at registration stops
working the day it matters.

**The encryption is implemented, not imported.** The obvious library sends over
`https.request`, which a Worker does not have, and its encryption half uses
`node:crypto` APIs a Worker does not implement either. So the algorithm is
implemented on the primitives a Worker has — WebCrypto — and it is checked by
**decrypting the output with a different implementation**: the test carries a
decryptor written from the specification, and a body this module produces has
to come back out of it. A test that encrypts and decrypts with the same code
proves only that the code agrees with itself.

**The push service's answers mean different things.** 404 and 410 mean the
browser is gone, and the subscription is removed. 429 means slow down, and the
message stays queued. 401 and 403 mean the VAPID key is not accepted, and no
number of retries fixes a key that is wrong.

**The consumer is wired, and the wiring is guarded.** The worker already
exported a `queue` handler and consumed nothing, because `wrangler.jsonc`
declared the queue as a producer only. A worker that exports `queue` and is not
attached to a queue is not a consumer: it is a function nobody calls. A
contract test now reads the same files the deploy reads and fails if the
consumer is removed.

**The deliveries travel on their own queue.** The domain events queue already
had a consumer — the growth worker — and a Cloudflare queue admits exactly
one, so a second consumer on it is refused by the API with a message that
names neither the queue nor the cause. It was not only the push path that was
dead: the automation worker published `WhatsAppOutboundRequested` to that same
queue, whose only consumer does not handle it. The WhatsApp dispatch has never
run. A delivery is not a domain fact, so it now travels on
`vyloop-notification-deliveries`, consumed by the worker that delivers.

## Risks

- **A body the push service rejects is silent.** It fails at delivery, not at
  send, and the symptom is a message that never arrives. The decryptor in the
  tests exists because of exactly this.
- **The VAPID private key is a secret with the shape of a public one.** It is
  stored as a secret and passed to the deploy through the environment, never
  interpolated into a command line.
- **The customer-web consent controls are still disabled.** The transport works
  and is unreachable by a customer, which is the next decision and not this one.
