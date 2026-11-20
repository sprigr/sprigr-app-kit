# Security policy

## Reporting a vulnerability

Email **security@sprigr.com**. Please do not open a public issue, pull request or discussion for a security problem.

Include:

- what you found, and where (URL, endpoint, repository, package and version);
- the steps to reproduce it, and what an attacker could do with it;
- how to reach you for follow-up.

Do not include another person's data or a tenant's data in the report. Do not access, change or keep data that is not yours beyond what is needed to show the problem. If you reach someone else's data by accident, stop, and tell us what you saw.

## What happens next

- We acknowledge a report within two business days.
- A confirmed report is handled as an incident: a confirmed exposure of tenant data, or a security control that failed open, is our highest severity.
- We tell you when it is fixed, and we credit you in the release notes if you want that.

## Scope

In scope: the Sprigr platform and its services, meaning `sprigr.com` and its subdomains (including `team.sprigr.com`, `api.team.sprigr.com` and `mcp.team.sprigr.com`), the Sprigr marketplace apps, and the published `@sprigr/*` npm packages.

Out of scope:

- denial-of-service and load testing;
- social engineering of Sprigr or its customers;
- physical attacks;
- findings in third-party services we use, which should be reported to that provider;
- systems that are not operated by Sprigr.

## Safe harbour

We will not pursue or support legal action against research done in good faith that follows this policy. Good faith means: you stay within the scope above, you avoid privacy violations and service disruption, and you give us a reasonable time to fix the problem before you disclose it.

The machine-readable contact is at `https://sprigr.com/.well-known/security.txt` (RFC 9116).
