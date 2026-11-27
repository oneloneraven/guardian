# Dependency screening register

Every dependency and vendor this project uses, screened against the BDS
movement's
[consumer boycott priority targets](https://bdsmovement.net/Guide-to-BDS-Boycott)
and its
[No Tech for Oppression, Apartheid or Genocide campaign](https://bdsmovement.net/no-tech-oppression-apartheid-or-genocide)
(ADR-0002 (in the vault)). A PR
that adds a dependency or vendor adds its row.

Last checked against both lists on 2026-11-27.

| Dependency or vendor | Used for | Maintainer | On a list? | Decision |
|---|---|---|---|---|
| GitHub (repository, Actions, Dependabot, Projects) | Hosting the repository, CI, dependency updates and the project board | Microsoft | Yes | Free tier, industry standard, no viable alternative: allowed under the free-tool exception. Nothing is paid. |
| pnpm | Installing packages and running scripts | pnpm project (independent open source) | No | Allowed |
| Vitest | Running unit tests | VoidZero Inc. | No | Allowed |
| Biome | Linting and formatting | Biome project (independent open source) | No | Allowed |
| TypeScript (`tsc`) | Type checking | Microsoft | Yes | Free, dev-only, no maintained non-Microsoft JavaScript type checker: allowed under the free-tool exception. |
| Vite | Building and serving the web app | VoidZero Inc. | No | Allowed |
| axe-core | Automated accessibility checks | Deque Systems | No | Allowed |
| WebdriverIO | Running end-to-end tests in a browser | OpenJS Foundation | No | Allowed. Chosen over Playwright, whose maintainer Microsoft is a consumer boycott target. |
| OpenTofu | Managing the zone's DNS and settings as code | OpenTofu project (Linux Foundation) | No | Allowed. Chosen over Terraform, whose owner IBM is a No Tech for Apartheid target. |
| Cloudflare (hosting, DNS, R2) | Hosting the Worker, DNS and the infrastructure state bucket | Cloudflare, Inc. | No | Allowed |
| wrangler | Deploying and previewing the Worker | Cloudflare, Inc. | No | Allowed |
| `@cloudflare/vitest-plugin` | Running unit tests against D1 in the Workers runtime | Cloudflare, Inc. | No | Allowed |
| Discord | Posting Guardian's alerts and settings changes to the owner's channel | Discord Inc. | No | Allowed |
