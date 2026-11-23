# Security

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting instead:
[**Report a vulnerability**](https://github.com/nxisai/agent-harness/security/advisories/new).
It opens a private thread visible only to you and the maintainers, and it works without you
needing an email address of ours or a PGP key.

Useful things to include, as far as you have them:

- What an attacker could do, not only what the code does.
- The version of `@nxisai/agent-harness`, the browser, and the page or setup it ran in.
- Steps to reproduce, or a proof of concept.
- Whether you have told anyone else.

If you cannot use GitHub's reporting for any reason, open an issue saying only that you have a
security report and would like a private channel — **no details** — and we will open one.

## What to expect

| | |
|---|---|
| We acknowledge | within 3 business days |
| We give an initial assessment | within 10 business days |
| We tell you our fix timeline | with that assessment |

If a report affects users, we will publish an advisory and credit you unless you would rather we
did not. If we disagree that something is a vulnerability, we will say so and explain why, rather
than letting the thread go quiet.

We ask for reasonable time to fix an issue before it is made public. We will not ask you to stay
quiet indefinitely, and we will not threaten anyone for reporting in good faith.

## Supported versions

The harness is pre-1.0 and changes quickly. Only the latest published version is supported;
fixes go out as a new release rather than as patches to older ones.

## Scope

This repository holds the harness, the library a site runs in its visitors' browsers, and the
model bench under `bench/`.

**In scope:** anything in this repository. What a page's tools can be made to do, the
confirmation that stands before every write, what the harness stores in the browser, what it
sends and where, the handoff to other agents and people, dependency issues, and the release and
build pipeline.

**Out of scope here, but still wanted:** flaws in the NxisAI services the harness talks to, such
as a site's MCP server. Report those the same way and we will route them internally — the
service code is not public, so this is the right door to knock on.

## Things worth knowing before you report

Three behaviours look alarming and are intentional:

- **The site token in the page is not a secret.** The NxisAI site tag carries a token in its
  script tag, and every visitor can read it. It identifies the site and is limited to what any
  visitor may do there. It grants nothing private.
- **The harness never takes a model key.** A remote model is reached through an endpoint the
  site hosts, which holds the key (see `createProxyProvider`). A page with a vendor key in it is
  a misconfiguration of that page, not of the harness.
- **A confirmed action is kept in `sessionStorage` for up to two minutes,** so it can be
  submitted on the page that owns the form. It holds what the visitor typed, expires, and is
  read once.

If you have found something that contradicts any of those, we would very much like to know.
