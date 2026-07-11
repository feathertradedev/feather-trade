# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Repository collaborators should open a draft security advisory from the
repository Security tab. GitHub does not expose public private-vulnerability
reporting while this repository is private, so the application does not publish
a Security destination by default. Before any public launch, maintainers must
enable private vulnerability reporting and set `VITE_FEATHER_SECURITY_URL` to
that verified intake. Include the affected component and version, reproduction
steps, impact, and any suggested mitigation. Maintainers will acknowledge a
complete report within three business days, coordinate validation and
remediation privately, and credit the reporter when disclosure is safe unless
anonymity is requested.

Never include private keys, seed phrases, production credentials, or funds in a
report or proof of concept. Test only against accounts and environments you are
authorized to use.

## Supported versions

The latest commit on the default branch is supported. Release and deployment
operators should follow the repository's security gates and rollback runbooks
under `docs/wave-2/`.
