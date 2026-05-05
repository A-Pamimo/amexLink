# Security Policy

> Owner: AmexLens maintainers · Version: 1.0

We take security seriously. This document explains how to report a vulnerability, what's in scope, what's covered by Safe Harbor, and how the (private, invite-only) bug bounty program works.

## Reporting a vulnerability

**Email:** `<security-contact@example.com>` (replace with your actual address before publishing)
**PGP key:** `https://<host>/.well-known/security.asc` (replace with your real key URL)
**Response SLAs:**

| Stage | Target |
|---|---|
| Acknowledgement | within **24 hours** |
| Triage + severity assigned | within **5 business days** |
| Critical fix released | within **30 days** of confirmation |
| High fix released | within **60 days** of confirmation |
| Public disclosure (coordinated) | typically **90 days** after report |

Please include:

- A clear description of the issue and the impact
- Steps to reproduce (HTTP transcripts, payloads, screenshots)
- The commit SHA you tested against
- Your handle for credit, if you want it

We prefer reports in English. Encrypted reports via the PGP key above are appreciated for high/critical severity findings.

## Disclosure policy

- We work with reporters in good faith and will keep you updated.
- We will credit you in `docs/security/acknowledgements.md` once the fix ships, unless you prefer to remain anonymous.
- We'll request a coordinated public disclosure date (typically 90 days from report, sooner if a fix ships earlier).
- We will **never** take legal action against researchers operating in good faith under the Safe Harbor terms below.

## Safe Harbor

Activity that complies with this policy is authorized. We agree not to pursue civil or criminal action against researchers for activity that:

1. Stays within the in-scope assets listed below.
2. Does not violate any rule under "Out of scope / prohibited" below.
3. Stops at proof-of-concept and does not exfiltrate or destroy data beyond the minimum needed to demonstrate impact.
4. Provides a reasonable opportunity to investigate and remediate before public disclosure.

This Safe Harbor is consistent with the EFF's [Coordinated Vulnerability Disclosure](https://www.eff.org/issues/coders/vulnerability-reporting-faq) and the principles of [#disclose.io](https://disclose.io/). It does **not** authorize activity that violates third-party rights (e.g. attacks on Plaid or hosting providers).

If a third-party law-enforcement, regulator, or platform pursues you for good-faith research under this policy, we will make a good-faith effort to make clear that your activity was authorized.

## Scope

### In scope

- The application source code in this repository
- Container images built from `Dockerfile`
- The default reverse-proxy configuration in `Caddyfile`
- The CI/CD configuration under `.github/workflows/`
- Any deployment listed at `docs/security/deployments.md` (when present)

### Out of scope / prohibited

- The Plaid platform, including any API endpoint not invoked by AmexLens
- Third-party CDNs (`cdn.plaid.com`, etc.)
- The maintainers' personal accounts, devices, families, or employers
- Hosting-provider infrastructure (AWS / GCP / fly.io / Hetzner / etc.) outside the AmexLens deployment itself
- DoS / DDoS / volumetric tests
- Social engineering of any human
- Physical-security testing
- Automated scanning that exceeds **20 requests/sec** per host
- Persistence implants of any kind
- Mass-data exfiltration beyond proof-of-concept
- Any test against production data belonging to a real user — this is a self-hosted single-user app; if you encounter what looks like real PII, stop immediately and report it

Reports for purely informational findings (missing best-practice headers without impact, version disclosure, banner grabs, default error pages, etc.) are appreciated but generally not eligible for bounty.

## Severity rubric

We score findings using **CVSS 4.0**, contextualized for this deployment. Suggested mapping:

| CVSS 4.0 | Severity | Bounty (private program) |
|---|---|---|
| 9.0 – 10.0 | Critical | $TBD |
| 7.0 – 8.9 | High | $TBD |
| 4.0 – 6.9 | Medium | $TBD |
| 0.1 – 3.9 | Low | $TBD |

## Bug bounty program

### Posture: **private, invite-only**

We don't currently run a public program. Researchers who want to contribute can email us; we will invite a small set of trusted researchers as the project matures. Bounty amounts are placeholders (`$TBD`) and will be made concrete before invitations go out.

### Path to a public program

Triggers we use to decide whether to graduate to a public program:

1. The deployment serves more than one user.
2. The threat model in `docs/security/threat_model.md` has been re-evaluated.
3. Internal SAST / SCA / DAST baselines are stable for ≥ 90 days.
4. We can commit to the response SLAs above for ≥ 30 days under load.
5. We have a payment / KYC pipeline (e.g. via HackerOne or Intigriti).

When those are met, we'll publish a public scope file and migrate this document to a hosted platform.

### Eligibility

- Be the first to report the issue.
- Provide enough detail for us to reproduce.
- Comply with the Safe Harbor and the rules above.
- Not employed by, contracted to, or otherwise materially related to the maintainers.
- Not in a country or under a sanction that prevents us paying you legally.

### Reward decisions

- Final reward amounts are at the maintainers' discretion.
- Duplicates are paid to the first valid report only.
- Findings depending on conditions outside the scope (e.g. rooted device, browser zero-day, hostile DNS) are typically not eligible.
- We may pay a bonus for an exemplary report (great write-up, working PoC, suggested fix).

## Researcher acknowledgements

We maintain `docs/security/acknowledgements.md` (created on first credit). Let us know how you'd like to be listed.

## `.well-known/security.txt`

A machine-readable contact file is published at `/.well-known/security.txt` per [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116).

## Maintainer-only content

The internal threat model is at `docs/security/threat_model.md` and is intentionally checked into the repo so external reviewers can challenge it. The Rules of Engagement template for external pentesters is at `docs/security/pentesting/rules_of_engagement.md`.
