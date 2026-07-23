# Feather VPS hosting

This directory runs the public static application and the analytics process on
an ordinary VPS while keeping all durable application data in managed
PostgreSQL. Caddy is the only container with published ports. The analytics
container is reachable only on the private Compose network and retains outbound
access for PostgreSQL, RPC, indexer, and presentation-metadata requests.

This is deployment infrastructure, not a claim that production analytics is
ready. The repository does not currently contain reviewed production
implementations of the canonical block source, Chainlink report verifier, or
head-exact position snapshot provider. It also does not yet contain the
checkpoint-v2 materialized anchor/compaction migration required to bound
canonical blocks, trusted price samples, positions, and pool-bin state over a
mainnet lifetime. The analytics image and CLI fail closed when the adapters are
absent, but adapter availability alone is not approval to expose analytics on
mainnet. Do not substitute the localnet adapter, fixed prices, browser fixtures,
or fabricated candles in staging or production.

## Sepolia web-only stage

The current Sepolia stage serves only the sealed application and documentation
artifact. Use `compose.web.yml`, `Caddyfile.web`, and
`host.web.env.example`; this path does not start or proxy analytics, a database,
or any chain indexer. The existing `compose.yml` full-stack path remains the
separate, fail-closed analytics deployment and is unchanged.

The web-only Caddy listener publishes only TCP 80/443 and UDP 443, mounts the
release tree read-only, retains the reviewed Reown CSP, and permits the browser
to connect to the exact Sepolia public RPC origin in `host.web.env.example`.
`FEATHER_APP_DOMAIN` and `FEATHER_DOCS_DOMAIN` are exact virtual hosts; there is
no catch-all host. Replace the reserved `.invalid` examples before starting
Caddy. Analytics and private paths, including `/graphql`,
`/events/*`, `/token-images/*`, `/readyz`, `/metrics`, and `/internal/*`, return
404 rather than falling through to the SPA.

Provision the release root and operator environment without creating any
analytics directories or secrets:

```sh
sudo install -d -m 0755 /etc/feather
sudo install -d -o feather-deploy -g feather-deploy -m 0755 /srv/feather/web/sepolia
sudo install -d -o feather-deploy -g feather-deploy -m 0755 /srv/feather/web/sepolia/releases
sudo cp infra/vps/host.web.env.example /etc/feather/host.web.env
```

Configure the protected Sepolia promotion environment with
`WEB_VPS_RELEASE_ROOT=/srv/feather/web/sepolia`. Install only sealed artifacts
at `releases/<commit>/dist`, remove their write bits, and atomically update the
relative `current` pointer exactly as described in the sealed-release section
below. The public RPC is intentionally not a deployment key or private provider
credential; if it changes, update the sealed web manifest and the exact CSP
origin together.

Validate and start the web-only stage from the repository checkout:

```sh
node scripts/release/validate-vps-deployment.cjs
docker compose --env-file /etc/feather/host.web.env \
  --file infra/vps/compose.web.yml config --quiet
docker run --rm \
  --env FEATHER_APP_DOMAIN=app.example.invalid \
  --env FEATHER_DOCS_DOMAIN=docs.example.invalid \
  --env "FEATHER_APP_CONNECT_SRC='self' https://ethereum-sepolia-rpc.publicnode.com" \
  --volume "$PWD/infra/vps/Caddyfile.web:/etc/caddy/Caddyfile:ro" \
  caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --env-file /etc/feather/host.web.env \
  --file infra/vps/compose.web.yml pull
docker compose --env-file /etc/feather/host.web.env \
  --file infra/vps/compose.web.yml up --detach
```

After DNS points both exact names at the VPS, verify the app, docs, and the
deliberately absent analytics surface:

```sh
curl --fail --silent --show-error "https://${FEATHER_APP_DOMAIN}/"
curl --fail --silent --show-error "https://${FEATHER_DOCS_DOMAIN}/docs"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' https://${FEATHER_APP_DOMAIN}/graphql)" = 404
test "$(curl --silent --output /dev/null --write-out '%{http_code}' https://${FEATHER_APP_DOMAIN}/events/candles)" = 404
test "$(curl --silent --output /dev/null --write-out '%{http_code}' https://${FEATHER_APP_DOMAIN}/readyz)" = 404
```

Stop this stage with the same explicit file and environment selections:

```sh
docker compose --env-file /etc/feather/host.web.env \
  --file infra/vps/compose.web.yml down --remove-orphans
```

## Host layout

Keep mutable operator configuration outside the checkout:

```text
/etc/feather/analytics/analytics.env       # root:root 0600
/etc/feather/analytics/config/             # price policies + custody inventory
/etc/feather/analytics/adapters/           # reviewed bundled .mjs adapters
/etc/feather/host.env                      # non-secret Compose inputs
/srv/feather/web/mainnet/                  # WEB_VPS_RELEASE_ROOT
  releases/<commit>/dist/                  # immutable sealed web artifacts
  current -> releases/<commit>/dist        # relative atomic release pointer
```

Managed PostgreSQL is deliberately absent from `compose.yml`. Caddy's named
volumes retain ACME account and certificate material; losing them does not lose
application data, but repeated loss can trigger certificate-authority rate
limits. The analytics egress network enables IPv6 because managed PostgreSQL
providers may expose direct database hosts without an IPv4 address.

## Sepolia Chainlink pricing

The reviewed Sepolia analytics path uses public on-chain Chainlink Data Feeds,
not credentialed Chainlink Data Streams. Copy
`config/price-policies.sepolia.json` to the custody filename
`price-policies.json`, and copy `adapters/chainlink-verifier.sepolia.mjs` to
`chainlink-verifier.mjs` before building the runtime custody inventory.

The policies bind the exact allowlisted Sepolia WETH and Circle USDC addresses
to the official ETH/USD and USDC/USD proxy feeds. The canonical source reads
`latestRoundData()` through an EIP-1898 canonical block-hash reference. The
independent verifier repeats that exact read, validates the chain, proxy code,
description, decimals, round ordering, answer, and timestamps, and reconstructs
the sample instead of trusting submitted values. Stale but authentic rounds
degrade USD metrics to partial; malformed or future rounds stop ingestion.
Neither active-bin prices nor any other DEX-derived value can enter this trusted
TVL price path.

## Provision once

1. Provision a supported Linux VPS, install Docker Engine and the Compose
   plugin from the vendor packages, enable unattended security updates, and
   allow inbound TCP 80/443 plus UDP 443. Restrict SSH to operator addresses.
   Do not expose Docker's API.
2. Point the app and docs DNS records at the VPS. Verify both records before
   enabling HSTS. The committed policy includes `includeSubDomains`, so confirm
   every affected HTTPS subdomain first.
3. Provision managed PostgreSQL with verified TLS (`sslmode=verify-full`),
   automated backups, point-in-time recovery, connection limits, and a
   least-privilege Feather role. Permit
   connections only from the VPS egress address. Use a distinct database or
   schema and a single analytics writer for each chain/environment.
4. Create a dedicated, unprivileged SSH deployment account for the protected
   promotion workflow. Give it ownership of only the web release root; do not
   grant it Docker access, passwordless sudo, or access to analytics secrets.
   Then create the operator-owned analytics directories:

   ```sh
   sudo useradd --create-home --shell /bin/sh feather-deploy
   sudo install -d -m 0755 /etc/feather /etc/feather/analytics
   sudo install -d -m 0755 /etc/feather/analytics/config /etc/feather/analytics/adapters
   sudo install -d -o feather-deploy -g feather-deploy -m 0755 /srv/feather/web/mainnet
   sudo install -d -o feather-deploy -g feather-deploy -m 0755 /srv/feather/web/mainnet/releases
   sudo cp infra/vps/host.env.example /etc/feather/host.env
   sudo cp infra/vps/analytics.env.example /etc/feather/analytics/analytics.env
   sudo chmod 0600 /etc/feather/analytics/analytics.env
   ```

5. Replace every placeholder. `FEATHER_RELEASES_DIR` must be exactly the same
   absolute directory configured as `WEB_VPS_RELEASE_ROOT` in the matching
   protected promotion environment. Configure that environment's SSH user as
   `feather-deploy` and pin the VPS host key. Split the immutable analytics image
   reference between `FEATHER_ANALYTICS_IMAGE_REPOSITORY` and the 64-character
   `FEATHER_ANALYTICS_IMAGE_DIGEST`; Compose reconstructs an `@sha256:` reference.
   `FEATHER_APP_CONNECT_SRC` must match the exact endpoints
   embedded in the sealed public artifact; never use broad `https:`, `wss:`, or
   `*` sources. `FEATHER_DOCS_DOMAIN` must be the hostname of the exact protected
   `WEB_VPS_DOCS_ORIGIN` HTTPS origin.
6. Configure the repository-level `WEB_REOWN_PROJECT_ID` Actions variable with
   the public Reown project ID. In the Reown dashboard, allowlist the exact app
   origins used for testnet and mainnet. The Caddy CSP includes Reown's documented
   AppKit relay, API, image, font, and verification origins; review that list
   whenever AppKit is upgraded.
7. Install reviewed, single-file production adapter bundles and the reviewed
   price-policy JSON at the fixed filenames shown in `analytics.env`. Production
   imports the verified module bytes through data URLs, so adapter bundles may
   use `node:` imports but must not contain relative or bare-package imports.
   Generate the canonical four-file inventory and its deployment-bound digest:

   ```sh
   pnpm analytics:custody:build \
     --environment mainnet \
     --deployment-identity "mainnet:<approved-adapter-release>" \
     --config-dir /etc/feather/analytics/config \
     --adapters-dir /etc/feather/analytics/adapters
   ```

   Copy the emitted `ANALYTICS_RUNTIME_CUSTODY_SHA256` into `analytics.env` and
   set `ANALYTICS_DEPLOYMENT_IDENTITY` to the identical immutable identity. The
   command hashes exactly `price-policies.json`, `chainlink-verifier.mjs`,
   `canonical-block-source.mjs`, and `position-snapshot-provider.mjs`; identical
   bytes and identity produce a byte-identical inventory. Startup opens every
   file without following symlinks, verifies the inventory and all four hashes,
   and imports the already-verified bytes rather than reopening their paths.

Configure `web-testnet` and `web-mainnet` with exact protected values for
`WEB_VPS_DEPLOYED_ORIGIN`, `WEB_VPS_DOCS_ORIGIN`, `WEB_VPS_RELEASE_ROOT`, the SSH
host/user/port/private key, and pinned known-hosts data. App and docs origins must
be distinct, credential-free HTTPS origins without paths, queries, or fragments.

## Build and verify the analytics image

Build from the repository root only after the root `.dockerignore` is present:

```sh
docker build --file packages/analytics/Dockerfile \
  --tag ghcr.io/feathertradedev/feather-analytics:<commit> .
docker push ghcr.io/feathertradedev/feather-analytics:<commit>
docker buildx imagetools inspect ghcr.io/feathertradedev/feather-analytics:<commit>
```

Put the resulting repository and registry digest, not a mutable tag, in
`/etc/feather/host.env`.
The image requires managed PostgreSQL and all production adapter variables at
startup. Its filesystem is read-only at runtime.

Do not promote the analytics container to mainnet until the versioned,
materialized checkpoint anchor and bounded reorg suffix are implemented and
validated across restart, compaction, and retained/deep-reorg cases. The current
v1 engine is correct but retains and reloads its complete canonical history;
simply deleting old blocks would corrupt candle, position-cost-basis, and reorg
state. App and docs hosting are independent of this analytics migration.

The analytics writer fence is a PostgreSQL session-level advisory lock. Connect
directly to PostgreSQL or through PgBouncer session pooling. Transaction pooling
is incompatible because it cannot preserve the lock-owning session. Loss of that
exact PostgreSQL session is a permanent process failure: analytics drains, exits
nonzero, and Compose restarts it. The same process never reacquires the lease.
TCP keepalive is enabled, and an independent coalesced query probe turns
continuous failures into the same fatal path after a two-minute grace window.
A successful probe before the grace threshold resets the window, so one
transient database error does not restart the service. The grace must be at
least two minutes—above the store's 60-second statement and 65-second query
ceilings—cover at least two probe intervals, and remain below the runtime's
five-minute bound. This prevents a legitimate queued health query during a long
canonical write from looking like a dead database, while a genuinely stuck
writer still terminates within a fixed window.

The default container ceilings are 2 CPUs/2 GiB for analytics and 1 CPU/512 MiB
for Caddy, with 20 concurrent SSE streams per source IP. Tune
`FEATHER_ANALYTICS_CPUS`, `FEATHER_ANALYTICS_MEMORY_LIMIT`,
`FEATHER_ANALYTICS_MAX_STREAMS_PER_IP`, `FEATHER_CADDY_CPUS`, and
`FEATHER_CADDY_MEMORY_LIMIT` only from measured CPU, heap, connection, and stream
usage. The host example also bounds per-client GraphQL traffic with
`FEATHER_ANALYTICS_GRAPHQL_REQUESTS_PER_MINUTE` and caps remembered rate-limit
clients with `FEATHER_ANALYTICS_GRAPHQL_RATE_LIMIT_CLIENTS`;
`FEATHER_ANALYTICS_POSITION_SNAPSHOT_TIMEOUT_MS` bounds a wallet snapshot wait,
while `FEATHER_ANALYTICS_DATABASE_KEEPALIVE_INITIAL_DELAY_MS`,
`FEATHER_ANALYTICS_DATABASE_HEALTH_INTERVAL_MS`, and
`FEATHER_ANALYTICS_DATABASE_FAILURE_GRACE_MS` govern database failure detection;
monitor OOM kills, throttling, restart counts, and rejected streams. Caddy has no
startup dependency on analytics, so web and docs remain available while the
three analytics routes return an upstream error during a fail-closed restart.

## Deploy a sealed web release

Use the artifact already built, validated, and custody-verified by the protected
promotion workflow. Do not rebuild on the VPS and do not deploy a generic
`pnpm web:build`, because that path may contain localnet configuration and the
wrong public environment configuration.

The protected provider adapter installs the sealed archive, verifies the complete
payload before reusing an existing release, serializes activation with
`<root>/.promotion.lock`, and runs app and docs hosted smoke while its restricted
SSH credentials are still available. A failed smoke atomically restores the
verified prior target only when `current` still points at the release that just
failed; it never overwrites a newer activation. Each pointer change is protected
by a five-minute, on-host activation lease. Hosted app/docs smoke explicitly
confirms the checksummed activation record. If the CI runner or SSH connection
is lost before confirmation, a detached watchdog restores the prior verified
target—or removes `current` for a first deployment—without waiting for the
caller to reconnect. Its hard-link anchor distinguishes activations of the same
commit, so an expired record cannot roll back a newer pointer.

`prepare` writes a checksummed run intent before archive transport. An ambiguous
caller therefore sees `pending`, not a false terminal `absent`; canceling that
intent under the activation lock prevents a still-running pre-swap process from
activating after the caller has given up. Re-promoting an already-confirmed
current commit re-smokes it without creating a new pointer or rollback lease.

The detached watchdog survives loss of the SSH client, but it is not a boot-time
service and does **not** survive a VPS reboot. The Compose Caddy service uses
`restart: unless-stopped`, so this repository alone cannot guarantee that an
unconfirmed pointer is never served briefly after an unexpected reboot. Do not
reboot during a promotion. After an unexpected reboot, stop Caddy immediately,
keep the public listener stopped, and inspect `<root>/.promotion-records/`.
Any expired `.record` without its matching `.confirmed` file must be reconciled
with the reviewed
`promote-web-vps-remote.sh recover-rollback` action, using the environment,
commit, run token, and archive digest recorded on disk. That guarded action
revalidates the sealed release, rollback target, checksum, anchor, and exact
live symlink identity; it is safe to report `not-current` when a newer
activation has already won. Do not delete the record or repoint `current`
manually just to make startup proceed. Configure an operator-owned boot gate if
reboot-time continuity is required; a future systemd reconciliation unit could
automate this check, but this deployment does not install one.

For an immutable commit `RELEASE`, place the verified artifact at
`$WEB_VPS_RELEASE_ROOT/releases/$RELEASE/dist`, verify its custody digest, then
remove write permission and atomically update the relative pointer:

```sh
RELEASE=<40-character-commit>
cd /srv/feather/web/mainnet
sudo chmod -R a-w "releases/$RELEASE/dist"
sudo ln -s "releases/$RELEASE/dist" ".current-$RELEASE"
sudo mv -Tf ".current-$RELEASE" current
```

Never extract over an existing release directory. Keep the previous approved
release present so immutable cached assets and rollback remain available. Each
adapter-installed release includes archive, payload, and environment/commit
identity markers; a legacy or corrupted directory is not rollback-ready and
blocks activation.

## Validate and start

From the repository checkout:

```sh
node scripts/release/validate-vps-deployment.cjs
docker compose --env-file /etc/feather/host.env \
  --file infra/vps/compose.yml config --quiet
docker run --rm \
  --env FEATHER_APP_DOMAIN=app.feather.markets \
  --env FEATHER_DOCS_DOMAIN=feather.markets \
  --env "FEATHER_APP_CONNECT_SRC='self' https://rpc.mainnet.chain.robinhood.com https://indexer.example" \
  --volume "$PWD/infra/vps/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --env-file /etc/feather/host.env \
  --file infra/vps/compose.yml pull
docker compose --env-file /etc/feather/host.env \
  --file infra/vps/compose.yml up --detach
```

The static site remains available if analytics is unhealthy; missing analytics
degrades the read-only market UX and must never change transaction authority.
Compose checks the private `/readyz` endpoint, while Caddy exposes only
`/graphql`, `/events/candles`, `/events/pools`, and the bounded
`/token-images/*` raster-image proxy.

Verify after startup:

```sh
docker compose --env-file /etc/feather/host.env --file infra/vps/compose.yml ps
curl --fail --silent --show-error https://app.feather.markets/
curl --fail --silent --show-error --request POST \
  --header 'content-type: application/json' \
  --data '{"query":"{ analyticsHealth { status } }"}' \
  https://app.feather.markets/graphql
test "$(curl --silent --output /dev/null --write-out '%{http_code}' https://app.feather.markets/metrics)" = 404
test "$(curl --silent --output /dev/null --write-out '%{http_code}' https://app.feather.markets/internal/blocks)" = 404
test "$(curl --silent --output /dev/null --write-out '%{http_code}' https://app.feather.markets/readyz)" = 404
```

Run `scripts/web/check-hosted-release.cjs` against the same sealed `dist`
directory from a trusted operator machine. Monitor container restart count,
analytics readiness and ingest lag, PostgreSQL saturation, certificate renewal,
and disk use for retained release artifacts.

## Roll back

For a web-only rollback, verify the previous release directory and atomically
move `current` back to its relative target:

```sh
PREVIOUS=<previous-approved-commit>
cd /srv/feather/web/mainnet
sudo ln -s "releases/$PREVIOUS/dist" ".current-$PREVIOUS"
sudo mv -Tf ".current-$PREVIOUS" current
```

Caddy opens static files through the parent read-only mount, so the relative
pointer change is visible without mounting a new directory. Re-run hosted smoke
checks immediately. Prefer the protected provider adapter's guarded automatic
rollback after smoke failure. The manual command is emergency operator recovery:
first compare the target's `.archive-sha256`, `.payload-sha256`,
`.release-identity`, custody inventory, and hosted artifact with the approved
release evidence. If `.promotion.lock` remains after a killed SSH process, remove
it only after confirming no activation or rollback process is still running.
Also inspect `<root>/.promotion-records/` before manual recovery: never repoint
`current` while an unconfirmed activation lease is pending unless the incident
operator has first stopped that record's watchdog and verified the intended
sealed rollback target.

For an analytics rollback, set the previous approved image digest in
`host.env`, restore the matching four custody inputs, inventory digest, and
`ANALYTICS_DEPLOYMENT_IDENTITY`, run `docker compose pull analytics`, and recreate
only that service. Never combine an old image with a differently identified
adapter inventory even if individual filenames happen to match.
Do not roll application code backward across an incompatible database change.
The current store performs schema creation and compatibility migration during
startup; database restoration or a down-migration requires an explicit,
reviewed recovery plan and a managed-database snapshot.

## Stop and recover

```sh
docker compose --env-file /etc/feather/host.env \
  --file infra/vps/compose.yml down --remove-orphans
```

This removes containers and networks, not managed PostgreSQL or Caddy's named
certificate volumes. Re-provisioning a VPS consists of restoring the operator
configuration, immutable releases, approved image digests, and Caddy volumes;
canonical analytics data remains in managed PostgreSQL.
