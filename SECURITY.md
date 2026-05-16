# Security Policy

## Reporting a vulnerability

If you find a vulnerability, please **do not** open a public GitHub issue.
Instead, report it privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or email <security@netverdict.io>.

You should expect an acknowledgement within 72 hours. We aim to ship a fix
or mitigation guidance within 14 days for high-impact issues. We don't
run a paid bug bounty — recognition is via the public advisory + a
changelog entry once the patch is shipped.

A machine-readable disclosure pointer ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116.html))
sits at `/.well-known/security.txt` on every deployment.

## Threat model

logflow-sim runs in three distinct postures with different threat surfaces:

### 1. CLI on the operator's laptop (`logflow-sim <subcommand>`)
The operator implicitly trusts their own shell. The parser, IR builder, and
simulator should still never:
- Read files outside the user-supplied `<conf-dir>` argument.
- Execute shell commands.
- Make network connections (the kernel is offline by design).
- Throw on malformed input — diagnostics only.

If you find a way to violate any of those guarantees from a hostile config
file, that is a security bug regardless of whether it produces RCE.

### 2. GitHub Action (`gweber/logflow-sim@v1` in CI)
A PR author's content (overlay configs, Sigma rules, replay corpus) is
processed by the action against the base branch's config. The Action
must not:
- Leak the GitHub token to the parsed config.
- Make network requests on behalf of the parsed config.
- Allow a malicious overlay path (e.g. `../../../etc/passwd`) to escape
  the overlay-dir sandbox.

The action uses `actions/checkout` to materialize trees, then invokes the
CLI which is sandboxed by Node's `fs` (no `eval`, no `vm.runInNewContext`).

### 3. Hosted server (`docker compose up` / netverdict.io/logflow)

This is the most exposed surface. The server:

- **Disables `X-Powered-By`** (framework fingerprinting).
- **Runs as a non-root `node` user** inside the container.
- **Enforces 32 MB body limits** at the express-json layer.
- **Rate-limits** per-IP: 240 reads/min and 30 expensive POSTs/min. Set
  `LOGFLOW_RATE_LIMIT_OFF=1` to disable for trusted on-host runs.
- **Rejects path traversal** on `/api/config/file` — only paths under
  the conf-root are served.
- **Caps search-query length** at 256 chars (mitigates regex-DoS).
- **Gates `/api/invalidate`** behind a bearer token when
  `LOGFLOW_INVALIDATE_TOKEN` is set in the environment.
- **Has no built-in authentication.** Put a reverse proxy with
  SAML/OIDC in front for any multi-tenant or internet-facing deployment.

The server **does not** persist user-supplied configs, pcaps, or replay
corpora. Everything stays in process memory for the duration of a single
request. Pcap uploads in particular may contain sensitive IPs or
payloads — they're decoded, replayed, and discarded.

### 4. MCP server (`logflow-sim-mcp`)
Speaks JSON-RPC 2.0 over stdio. Inputs come from the LLM client (Claude
Desktop, Continue, …). The server:

- Runs **only the same in-process kernel functions** as the REST API.
  No filesystem access (config files come from inline arguments).
- Has **no network listener** — stdio only.
- Trusts the client to size requests reasonably; an MCP-client-side
  rate-limit is the user's responsibility.

## Specifically out of scope

- **Configurations users supply may reference sensitive paths, IPs, or
  hostnames.** logflow-sim renders them in its UI as-is — treat the
  simulator as you would `cat conf/rsyslog.conf`.
- **Pcap payload decryption.** Syslog-over-TLS captures must be
  decrypted with an external tool before replay.
- **Detection-rule semantics beyond the supported Sigma subset.**
  Aggregations (`count() by host > 10`) and Windows-only fields are
  evaluated as no-match, not an error.

## OWASP Top 10 (2021) status

| ID | Category | Status |
|---|---|---|
| A01 | Broken Access Control | Path-traversal rejected on `/api/config/file`. No auth model — operator's reverse-proxy responsibility. |
| A02 | Cryptographic Failures | TLS at the proxy. No secrets at rest. |
| A03 | Injection | No SQL. YAML via `js-yaml` v4 default (safe loader). JSON via native `JSON.parse`. Search regex length-capped. |
| A04 | Insecure Design | Rate limits on the API; body limits at the parser; bearer-token gate on cache invalidation. |
| A05 | Security Misconfiguration | `x-powered-by` disabled, container non-root, CSP via nginx. |
| A06 | Vulnerable Components | `npm audit --omit=dev` shipped clean. Renovate/Dependabot configurations welcome via PR. |
| A07 | Authentication Failures | No built-in auth (by design, see hosted-server posture). |
| A08 | Software & Data Integrity | Package-lock pinned. CI runs full test suite on every PR. |
| A09 | Logging Failures | Structured access log per request, `4xx/5xx` mapped via central error handler. |
| A10 | SSRF | Server makes no outbound network requests on user-controlled inputs. |

## Supported versions

The current major version receives security fixes. Older majors get
critical-severity backports for six months past the next major release.
