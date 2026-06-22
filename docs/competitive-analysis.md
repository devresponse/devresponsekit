# Competitive Analysis

_Audience: marketing, product, and landing-page authors. The value propositions
here back the public landing page (`src/app/[locale]/(public)/page.tsx`)._

> This document distills the positioning from
> [Product Overview](./product-overview.md) and [Features](./features.md) into the
> handful of value propositions the landing copy leans on. It intentionally names
> no specific competitors or benchmarks beyond the product class already framed in
> the product overview; keep it that way and keep it aligned with those two
> documents.

## What we are

**DevResponseKit** is a production-grade, security-first **enterprise application
shell** for multi-tenant B2B platforms: the assembled, tested foundation teams
build their product on top of, instead of rebuilding the same identity,
access-control, and administration plumbing first.

## The core value proposition

> Clerk/WorkOS-class identity — organizations, role-based access control, SSO,
> API keys, and audit — that you **own and self-host**, wrapped in a tested admin
> console and multi-app shell.

Three ideas drive it:

1. **Own your identity layer.** Authentication and access control run on
   self-hosted open-source foundations — no per-user pricing meter and no vendor
   lock-in on the most sensitive part of the stack.
2. **Multi-tenant isolation that is enforced, not assumed.** Every tenant's data
   is walled off by a single central access model, and that model is checked
   automatically by the test suite, so isolation cannot silently erode.
3. **Enterprise expectations, day one.** Audit trails, SSO, granular
   permissions, session controls, and an admin console are present from the first
   commit, not bolted on later.

## Who it's for

- **Enterprise platform teams** who need RBAC, audit, SSO, and an admin console,
  often under compliance pressure.
- **Security- and compliance-sensitive teams** who must *demonstrate* tenant
  isolation, not just claim it.
- **B2B SaaS founders** who want organizations, roles, and an admin console
  without per-seat identity-vendor pricing.
- **Agencies and system integrators** who need an ownable, extensible foundation
  to tailor per client.
- **Internal-tools / multi-app organizations** whose users move between several
  related apps with one sign-in.

## Differentiators

1. **Verifiable tenant isolation** — access rules live in one place and are
   enforced by an automated test that fails the build if a feature forgets to
   scope itself to a tenant.
2. **A real admin console, included** — a broad set of management screens with
   search, pagination, bulk actions, and CSV export, not a thin starter stub.
3. **Permissions as data** — the permission catalog is defined once and shared
   between setup and runtime, so it cannot drift out of sync.
4. **Scoped machine API** — integration credentials can never grant more access
   than the person who created them.
5. **Cross-subdomain SSO done safely** — single-use, short-lived handoff tokens
   with an allow-list of trusted destinations.
6. **Self-hosted, zero marginal identity cost** — the authentication layer is
   open-source and runs on your own infrastructure.

## Business benefits

- **Faster time-to-market** — the undifferentiated foundation is already built
  and tested, so teams ship product features sooner.
- **Lower identity cost at scale** — self-hosting avoids per-seat/per-MAU fees
  that grow with success.
- **Smoother enterprise sales** — audit logs, SSO, and granular permissions
  answer the security-review questions that otherwise stall deals.
- **Reduced risk** — centrally enforced, continuously tested tenant isolation
  lowers the chance of a cross-tenant data incident.
- **Full ownership** — you control the code, the data, and the deployment.

---

_For the full positioning, target-audience table, and suggested promotional copy,
see [Product Overview](./product-overview.md). For the plain-English feature
catalog, see [Features](./features.md)._
