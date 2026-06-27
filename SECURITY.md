# Security policy

## Supported versions

pendpost is an early, part-time project. There is no long-term support window yet. Security fixes land on the latest release line only. Run a current version.

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue for a vulnerability.

- Email: security@pendpost.com.
- Once the repository is public you can also open a private security advisory on GitHub.

We are a small team working part-time, so please allow time for a response. Include enough detail to reproduce the issue, and let us know if you would like to be credited.

## Security posture

pendpost is local-first by design, and several of its defenses are structural rather than configurable:

- **Loopback-only bind by default.** The server binds `127.0.0.1`. `PENDPOST_HOST` exists only so the container image can bind `0.0.0.0` inside its own network namespace; the docker-compose mapping still exposes the port on `127.0.0.1`.
- **DNS-rebinding and CORS defenses.** Requests with an unknown `Host` header are rejected, which closes the DNS-rebinding hole where a malicious site rebinds its hostname to `127.0.0.1`. Only pendpost's own origins (and the local dev proxy) are allowed cross-origin; any other `Origin` is rejected. Requests without an `Origin` header (MCP clients, curl) pass untouched.
- **Secrets stay in your `.env`.** All platform credentials live in your own `.env`, which is gitignored. pendpost never commits secrets and never transmits them anywhere except the platform APIs you have configured.
- **Nothing phones home.** There is no analytics or usage reporting. Any future opt-in telemetry would be off by default, and it is not built today.
- **Human approval gate.** Publishing is fail-closed. A post with no approval will not publish, and the actor who created a post cannot approve it (no self-approval; the owner is exempt). This limits the blast radius of a compromised or misbehaving agent.
- **The 368 circuit breaker.** A Meta error 368 (an action block) halts the Meta lane and never auto-resumes, and health probes send zero Graph traffic while the block is in effect. This prevents a retry loop from compounding an action block against your account.

Loopback binding does not stop a malicious website in your own browser from attempting cross-origin requests, which is why the CORS and Host checks above exist. Treat the machine running pendpost as trusted, and keep your `.env` out of version control.
