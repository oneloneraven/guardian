# Data protection: record of processing

What personal data Guardian processes, why, where it goes and how long it's
kept. Keep this current: a change that collects new data or adds a processor
updates it in the same PR.

## Processors

| Processor | What it receives | Purpose | Location |
|---|---|---|---|
| Cloudflare (Workers, D1, Access) | The security events and check results Guardian stores, including the GitHub logins of people who change the organisation or its repositories; the owner's sign-in | Hosting, storage, admin sign-in | Cloudflare's global network; D1 isn't pinned to a jurisdiction |
| Discord | Alert text, which can name the GitHub login of the person whose change caused the alert | Telling the owner about failures and unexpected changes | United States |

## Processing activities

| Data | Purpose | Lawful basis | Retention | Who can see it |
|---|---|---|---|---|
| Security events: the GitHub login of the person who changed the organisation's or a repository's settings, the action, the target and the time | Spotting unexpected changes to what Guardian watches | Legitimate interests | 90 days, then deleted | The owner |
| Alerts: the same GitHub login, where it appears in the alert's text | Telling the owner about a failure or an unexpected change | Legitimate interests | 90 days after the alert is posted, once it has been sent or dropped; the Discord message stays in Discord | The owner, and whoever can read the Discord channel |

Guardian stores no email addresses from GitHub. An invitation sent to an email
address is recorded as "an email address".

## Gaps to settle

None recorded yet.

## Security measures

See the threat model (in the vault) and [privacy rules](privacy.md).
