# Provider-Neutral Observability Starter

This directory is the repository-owned monitoring contract for issue #61. It
defines what must be observed and routed without selecting an alerting,
dashboard, RPC, hosting, or indexer vendor.

## Files

- `monitors.json` defines required signals, thresholds, severities, and owners.
- `dashboards.json` defines the minimum operator views and panel inputs.
- `alert-routing.example.json` is a placeholder routing tree. Replace role
  aliases and destination references in the private operations system; do not
  commit email addresses, phone numbers, webhook URLs, or vendor IDs.
- `tabletop-evidence.template.json` is the sanitized rehearsal/test-alert
  evidence shape. Keep endpoint URLs and credentials in the protected evidence
  store and record only stable ticket/artifact references here.

Validate the starter and its tests with:

```sh
pnpm observability:validate
pnpm observability:test
```

Validate completed evidence without template allowances:

```sh
pnpm observability:evidence:validate -- path/to/sanitized-evidence.json
```

The definitions are intentionally portable. Implementations may translate them
to any monitoring stack, but must preserve monitor IDs, thresholds, severity,
ownership, and escalation behavior so evidence remains comparable.
