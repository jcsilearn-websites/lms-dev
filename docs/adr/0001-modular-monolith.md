# ADR 0001: Modular monolith in a TypeScript monorepo

Status: accepted

## Context

A small team is building a commercial multi-tenant LMS. Early microservices would multiply deployment,
observability and consistency problems before the domain boundaries are understood.

## Decision

One deployable API, one background worker (same codebase, separate entrypoint) and one React SPA, in a
pnpm + Turborepo monorepo. Domain code is split into modules that own their tables; cross-module access is only
through service interfaces (no cross-module repository imports).

## Consequences

- Simple deploys on Cloud Run (two services from one image/codebase), in-process calls, one transaction scope.
- Module boundaries are a discipline enforced in review; they allow extracting a service later if one is needed.
- A shared database means isolation depends on RLS and module rules rather than network boundaries.
