# Security Policy

> **Language:** English | [简体中文](SECURITY.md)

## Supported versions

This policy describes the scope in which security reports are accepted. It does not promise a long-term support cycle or a fixed remediation deadline. Version numbers are based on actual release records; version numbers in `package.json`, local builds, or development branches do not by themselves prove that a release exists.

| Version | Status |
|---|---|
| 0.3.0-k1, which has a release record, and the earlier 0.3.0-k0 | Security reports are accepted; fixes are prioritized on the current development line, with no promise of backporting to every preview; previews are not a production-stability guarantee |
| Other candidate builds / main / self-built versions | Reports with an exact commit or artifact hash are accepted; release and support status must be checked against the corresponding Release |
| < 0.3.0 | No backports to older versions are promised; reports are still useful for checking whether the current version is affected |

Download and release entry points are in [README.en.md](README.en.md). Back up local data before upgrading and read compatibility notes; do not overwrite original traces or working files in order to verify a vulnerability.

Daily maintenance, version backports, and end-of-maintenance rules are in the [version and maintenance policy](docs/development/maintenance-policy.en.md); this page remains the entry point for security-report scope and process.

## How to report a vulnerability

**Do not report security vulnerabilities in a public issue.**

- Usage issues without security impact: use the [issue templates](https://github.com/pomelotea-yuzu/ReBaseAgent/issues/new/choose) and provide only the necessary redacted logs.
- Credential leaks, proxy-forwarding hijacking, path escapes, unauthorized reads or writes: if the [GitHub Security page](https://github.com/pomelotea-yuzu/ReBaseAgent/security) shows "Report a vulnerability", use that private entry point.
- If the GitHub entry point is unavailable, check whether private messaging is available on the [Gitee maintainer profile](https://gitee.com/yuzu-tea-duck). An account being unblocked does not mean that private reporting is enabled; actual reception through these channels still needs verification.
- If both entry points are unavailable, open an issue requesting a private contact method only, without vulnerability details, exploitation steps, or sensitive attachments; keep the detailed report until a reachable private channel exists. GitHub has no general private-messaging entry point that can be relied on.

For private reports, include: affected version or source commit, operating system, affected component, impact scope, minimal reproduction steps, and workarounds already attempted. When placeholder credentials and temporary files can reproduce the issue, prefer them; do not send valid API keys, complete business data, or an entire `data/` directory.

## Handling and disclosure

The target for the first human response is **within 3 business days**; this is not a remediation deadline or a service guarantee. After receipt, the maintainer confirms reproduction, affected versions, temporary mitigations, and the fix plan; if information is insufficient, it is requested through the original private channel. If there is no response, follow up in the original channel, or publicly request only a contact method — do not publish exploitation details to pressure a response.

After a fix, the impact scope, fixed version, and necessary upgrade notes are recorded, and disclosure timing and attribution preferences are discussed with the reporter. If the issue is not reproduced or is judged not to be a security issue, the reasoning is explained, and a path to reconsideration with additional evidence is preserved. No bug bounty, CVE assignment, or third-party coordination service is promised.

Report materials are used only to handle the issue and are shared with people involved in the fix on a need-to-know basis; public statements do not include keys, personal identity, or unauthorized business information. If credentials have already leaked, revoke or rotate them first; deleting public text does not make old credentials safe again.

## Security boundaries by design (honest disclosure)

- **API keys captured by the proxy**: held only in main-process memory; not written to disk and not returned to the renderer; they must be captured again after a main-process restart. Forwarding uses the incoming request's credentials; messages resend depends on credentials already captured by the proxy; the key in desktop model settings does not replace it. The recording workspace shows enabled, listening, and captured states separately; enabled does not mean listening succeeded.
- **Desktop model API keys**: stored in `settings.json` in the data directory, preferring the system `safeStorage` encryption. When encryption is unavailable, the app **falls back to plaintext and warns in the UI**; it must not be described as never touching disk. Reading settings returns only whether a key is configured, not the key text; leaving the password field empty when saving keeps the existing key.
- **Redaction has a scope**: error-detail redaction covers this configuration's apiKey / baseURL credentials and Authorization, Bearer, and URL-credential forms, but **does not promise to find every secret in arbitrary business text**. Messages, tool results, and screenshots still need to be checked before sharing.
- **Isolated rerun is not a permission system**: file checkpoints guarantee only that the parent run / source directory / sibling branches remain byte-for-byte unchanged; they do not isolate networks, shells, or external state sources. Copy-write authorization does not change access permissions on the source directory.
- **Local-first data**: for the portable build, traces, attachments, and settings live in `data/` next to the exe; traces and attachments on disk are not encrypted as a whole. Local storage does not mean content never leaves the device: real execution, messages resend, and text read by tools are sent to the model provider according to configuration; the portable launcher also creates temporary extraction files.
- **Session restore does not preserve authorization**: draft text and reading positions are kept within the renderer session and are not restored after a reload or app restart; copy-write, cost, and side-effect confirmations must still be re-verified for the current submission. The operation registry, deduplication, and execution slot manage lifecycle; they do not provide an operating-system-level sandbox.
