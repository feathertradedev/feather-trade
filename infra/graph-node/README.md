# Robinhood Graph Node Infra Skeleton

This directory contains a self-hosted Graph Node fallback skeleton for Wave 2.
It is not the default launch path while Goldsky is available.

## Compose

Validate the committed fallback shape:

```sh
pnpm graph-node:validate
```

Copy the example compose file and provide secrets through your deployment
system, not through git:

```sh
cp infra/graph-node/docker-compose.robinhood.example.yml infra/graph-node/docker-compose.robinhood.yml
GRAPH_NODE_NETWORK=robinhood-testnet \
GRAPH_NODE_ARCHIVE_RPC_URL=https://<archive-rpc> \
GRAPH_NODE_POSTGRES_PASSWORD=<secret> \
docker compose -f infra/graph-node/docker-compose.robinhood.yml up -d
```

The example publishes only the GraphQL port on loopback. Keep Graph Node admin,
status, IPFS, and Postgres private. Put a TLS reverse proxy in front of GraphQL
for staging or production.

The fallback stack uses immutable tag-and-digest references:

- `graphprotocol/graph-node:v0.44.0@sha256:c14c6d8e2b2b1ed89f6a89babf48d807b18a43e372fda7fb495d3a9050b65b8b`
- `ipfs/kubo:v0.29.0@sha256:53236eaeb876c6d837ee7b04a9b0e737a22e5f4471d0f99fb499fba28034aa61`
- `postgres:16.13-alpine@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50`

Keep all three references identical to the local stack in
`indexer/subgraph/docker-compose.yml`. For an upgrade, verify each replacement
digest for the deployment platform, stage the full stack, update both Compose
files and their documentation together, and run `pnpm graph-node:validate`
before deployment.

Use:

- `GRAPH_NODE_NETWORK=robinhood-testnet` for Robinhood testnet.
- `GRAPH_NODE_NETWORK=robinhood-mainnet` for Robinhood mainnet.
- `GRAPH_ETHEREUM_MAX_BLOCK_RANGE_SIZE` to reduce archive RPC batch size if
  the selected provider rejects wide `eth_getLogs` ranges during backfill.

See [Self-Hosted Graph Node Runbook](../../docs/wave-2/self-hosted-graph-node-runbook.md)
for deployment, backup, restore, reindex, rollback, monitoring, and smoke steps.
