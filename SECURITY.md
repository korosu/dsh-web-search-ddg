# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository rather
than opening a public issue. Include a description, the affected version, and
reproduction steps. You can expect an acknowledgement within a few days.

## Scope notes worth knowing before you report

This provider is an unauthenticated HTTP client, and that shapes its risk
profile:

- **Outbound requests.** The only network activity is a `GET` to the configured
  `endpoint` (default `https://html.duckduckgo.com/html/`) with a desktop Chrome
  user agent, plus redirects the native `fetch` follows. Result links are decoded
  as strings and never fetched.
- **No credentials.** The provider is inherently keyless: there is no API key
  field, no token, and no credential-resolution step. A compromised deployment
  therefore leaks search queries, not keys.
- **Install-time execution.** A GitHub-source install runs this package's
  `prepare` script on the installing machine. pnpm ≥ 10 refuses to run it until
  explicitly allowed through `allowBuilds`, so treat that allowance as the trust
  boundary; prefer a tarball or a local path when you want to avoid it.
- **Terms of service.** Unauthenticated scraping carries a ToS risk that is a
  policy question rather than a vulnerability in this code. High-volume
  deployments should use a licensed or first-party backend.
