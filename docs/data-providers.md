# Credit-card data providers

> **Salvaged draft (Oct 30, 2026).** Written by a Cursor builder agent that crashed before pushing any code. Vendor facts, prices, dates and the Plaid coverage-file flags are **unverified**: re-check against each vendor's current docs before relying on them. Wherever this file says "this build", "already in the app", or names files such as `0002_card_liabilities.sql`, `lib/webhooks.ts`, or `scripts/verify-sandbox.mjs`, read it as **the design target, not existing code**. None of that code is on `main`. See `HANDOVER.md`.
>
> **Exception:** the Plaid `/liabilities/get` field list (see the note under the intro and the Plaid column of the field table) was verified against plaid.com/docs/api/products/liabilities on 2026-10-30. Every other vendor fact, and the Canadian institution table, remain unverified.


Comparison for a single-user, self-hosted dashboard in Toronto. The fields that matter are the ones on the cards overview:

- current balance
- statement balance
- credit limit
- available credit
- minimum payment
- next payment due date
- last payment amount and date
- last statement issue date
- APR (purchase, and the other APR types when the API returns them: balance transfer, cash, penalty, special)
- overdue flag

**Plaid field list: verified against plaid.com/docs/api/products/liabilities on 2026-10-30** (`/liabilities/get` `liabilities.credit[]`: `account_id`, `aprs[]` of `{ apr_percentage, apr_type, balance_subject_to_apr, interest_charge_amount }`, `is_overdue`, `last_payment_amount`, `last_payment_date`, `last_statement_issue_date`, `last_statement_balance`, `minimum_payment_amount`, `next_payment_due_date`). `apr_type` is one of `balance_transfer_apr`, `cash_apr`, `penalty_apr`, `purchase_apr`, `special`; the public docs page omits `penalty_apr` and `last_statement_issue_date`, but the `plaid` SDK (v46+) returns both. An empty `aprs` array means the issuer supplied no APR. `is_overdue: false` is a real value. Balances come from `/accounts/get` (cached, free) or `/accounts/balance/get` (live, billed per call): `current`, `available`, `limit`, `iso_currency_code`. The Yodlee, MX, Flinks and other-vendor columns, and the Canadian institution table below, are still unverified drafts.

Utilization is not an issuer field. AmexLens computes it from current balance and credit limit and labels it as computed. Missing issuer fields stay missing. The app does not invent them and does not accept manual overrides.

Sources checked on 30 October 2026. Institution flags for Plaid come from Plaid's published US/Canada coverage file generated 16 October 2026 (`institution_id,name,country,...,liabilities,...,transactions`). Product behavior comes from each vendor's own docs. Where a vendor does not publish a price or a field, this doc says so instead of guessing.

## Recommendation

**Primary: Plaid Transactions + Liabilities + Balance.** The app already links items through Plaid. `/liabilities/get` returns the credit-card liability object (statement balance, minimum payment, due date, last payment, APR array, `is_overdue`). `/accounts/balance/get` returns real-time `current`, `available` (available credit on credit accounts), and `limit`. Cached balances from `/accounts/get` are the fallback when Balance is not enabled or the live call fails, and the overview marks those as cached.

Plaid's own Liabilities docs still say Canadian coverage is limited. The October 2026 coverage file is more specific and is what this choice is based on. Liabilities is flagged on for the issuers the owner is most likely to hold, and off for several others. A supported institution can still return nulls for individual fields. The overview shows that per field.

**Fallback, not wired in this build: Yodlee (Envestnet).** It is the only other vendor here whose published account and statement models cover the same liability fields and that documents Canada as a FastLink region. It is enterprise-contracted. The provider interface and the merge function are in place so a Yodlee adapter can fill nulls later without a schema change. Do not buy it unless a connected issuer comes back `not_supported` for liabilities and those cards matter.

**Not the liability fallback: Flinks.** Flinks is the strongest Canada-native connection layer and publishes current balance, available balance, and limit for credit accounts. It does not publish statement balance, minimum payment, due date, last payment, or APR. Its Attributes product is cash-flow math and the documented attribute filter only accepts the Operations category, not Credits. Flinks would not fill the fields Plaid leaves empty on a card Plaid can already link.

## Field coverage

| Field | Plaid | Yodlee | MX | Flinks | Mastercard Open Finance (Finicity) | Akoya | Wealthica | Inverite |
|---|---|---|---|---|---|---|---|---|
| Current balance | `accounts.balances.current` | `runningBalance` (credit card); `balance` is also documented | `balance` | `Balance.Current` | `balance` / line-of-credit `currentBalance` | FDX account balance (US) | Investment-centric; card balances only if the connector exposes them | Account balance for verification |
| Statement balance | `liabilities.credit.last_statement_balance` | `amountDue` on the account; statement `amountDue` | `statement_balance` | Not published | Line-of-credit `statementCloseBalance` (US product) | Not published for CA cards | Not published | Not published |
| Credit limit | `balances.limit` | `totalCreditLine` | `credit_limit` | `Balance.Limit` | `creditMaxAmount` | Not a CA card product | Not published | Not published |
| Available credit | `balances.available` for credit accounts | `availableCredit` | `available_credit` | `Balance.Available` | `creditAvailableAmount` | Not a CA card product | Not published | Not published |
| Statement issue date | `liabilities.credit.last_statement_issue_date` | Not verified | Not verified | Not published | Not verified | Not published | Not published | Not published |
| Minimum payment | `minimum_payment_amount` | `minimumPayment` on statements; account payment fields | `minimum_payment` | Not published | `paymentMinAmount` | Not published | Not published | Not published |
| Next due date | `next_payment_due_date` (full date) | `dueDate` (account and statement) | `payment_due_at` (full timestamp) and `day_payment_is_due` (day of month only) | Not published | `paymentDueDate` | Not published | Not published | Not published |
| Last payment amount | `last_payment_amount` | `lastPaymentAmount` | `last_payment` | Not published | `lastPaymentAmount` | Not published | Not published | Not published |
| Last payment date | `last_payment_date` | `lastPaymentDate` | `last_payment_at` | Not published | `lastPaymentDate` | Not published | Not published | Not published |
| APR | `aprs[]` with `apr_type` (`purchase_apr`, `cash_apr`, `balance_transfer_apr`, `penalty_apr`, `special`) | Account `apr`; optional derived APR; statement `apr` | `apr` from the feed, plus `calculated_apr` | Not published | `interestRate` on the line-of-credit detail | Not published | Not published | Not published |
| Overdue | `is_overdue` | Not a single boolean in the fields cited; past-due is not the same object | Not a dedicated boolean in the account object cited | Not published | `pastDueAmount` | Not published | Not published | Not published |

MX can store a value as feed, user, or system (`*_set_by`). AmexLens will not write user-entered values. A future MX adapter would ignore anything not set by the feed.

Finicity's line-of-credit detail is the most explicit US schema in this list and is included so the gap is visible. Mastercard's own Open Finance page lists the US, Australia, Brazil, and Europe. Canada is not a listed market, so those fields are not a way to read Canadian cards.

## Canadian institutions

Plaid liabilities flag from the 16 October 2026 coverage file (`1` means the institution is listed for the Liabilities product, not that every field is populated):

| Institution | Plaid id | Country | Liabilities | Balance | Transactions |
|---|---|---|---|---|---|
| American Express | `ins_10` | US | yes | yes | yes |
| American Express (Canada) | `ins_100533` | CA | yes | yes | yes |
| RBC Royal Bank | `ins_39` | CA | yes | yes | yes |
| TD Canada Trust | `ins_42` | CA | yes | yes | yes |
| BMO Bank of Montreal | `ins_41` | CA | yes | yes | yes |
| CIBC | `ins_37` | CA | yes | yes | yes |
| Scotiabank | `ins_38` | CA | yes | yes | yes |
| National Bank of Canada | `ins_48` | CA | yes | yes | yes |
| Tangerine - Personal | `ins_40` | CA | yes | yes | yes |
| Canadian Tire Bank | `ins_117195` | CA | yes | yes | yes |
| Desjardins | `ins_46` | CA | no | yes | yes |
| President's Choice Financial | `ins_47` | CA | no | yes | yes |
| Simplii Financial | `ins_115631` | CA | no | yes | yes |
| Vancity Visa | `ins_126265` | CA | no | yes | yes |
| EQ Bank | `ins_122886` | CA | no | yes | yes |
| KOHO | `ins_133419` | CA | no | yes | yes |
| Wealthsimple (Canada) | `ins_118273` | CA | no | yes | yes |

For a "no" row, Plaid can still return balance, available credit, and limit when the Balance product works. Statement balance, minimum, due date, last payment, APR, and overdue stay unsupported. The overview says so on those fields. Re-linking cannot create data the institution does not provide.

Other vendors, from their own pages:

- **Flinks** is Canada-first (Montreal, majority-owned by National Bank of Canada). Marketing cites thousands of North American connections and direct bank APIs. That is login coverage, not liability-field coverage. See the field table.
- **Yodlee** documents Canada in FastLink (Canadian English and French, bank transit codes instead of US routing numbers) and publishes global data-source counts. It does not publish a Canada-only institution count or a per-issuer field guarantee. Assume nulls the same way as Plaid.
- **MX** accepts `iso_country_code=CA` and markets US and Canada coverage. Public institution directories checked for this note show a thin listed Canadian set next to a large US set. Treat a specific issuer as unverified until `institutions` search says it is available. The account schema itself is complete enough to be a second adapter if coverage checks out.
- **Finicity / Mastercard Open Finance** does not list Canada.
- **Akoya** is a US bank-permissioned (FDX) network. Its pricing page is about US connections. It is not a Canadian card source.
- **Wealthica** is a Canadian investment aggregator (holdings, book value, adjusted cost base) with a consumer app and a B2B API. Credit cards are not the product. Use it for investments, not payment due dates.
- **Inverite** publishes support for 240+ Canadian institutions for lender bank verification (balances, transactions, income). It is not an ongoing credit-card liability API.
- **Salt Edge** is a poor fit. A 2026 Canada roundup of vendor pages found only a couple of Canadian connections listed.

Plaid's OAuth guide says OAuth is used by many US institutions and is not currently used by Canadian institutions. This app still supports both countries, so the redirect URI is required for US OAuth issuers (American Express US, and any US bank card). It is not what makes RBC or Amex Canada link. Sandbox allows `http://localhost` redirect URIs. Production redirect URIs must be HTTPS and must match the dashboard allowlist exactly, with no query string and no hash.

## Access, consent, and cost for one developer

| Provider | Can one person get production? | Consent model | Cost signal (published) |
|---|---|---|---|
| Plaid | Yes. Sandbox is free and immediate. US/CA signups on or after 15 April 2026 can use a Trial plan: real data, up to 10 Production Items, auto-approved for most developers, and the bundle includes Transactions, Liabilities, and Balance. Full Production needs a dashboard application (company and use case) and is paid. | Plaid Link. The app never sees the bank password. Data Transparency Messaging is on for new US and Canada sessions. Liabilities has to be requested at Link time (`required_if_supported_products` on create, `additional_consented_products` in update mode) or a later `/liabilities/get` returns `ADDITIONAL_CONSENT_REQUIRED`. | Transactions and Liabilities are monthly per-Item subscriptions. Balance (`/accounts/balance/get`) is a per-successful-request fee. Dollar amounts are not on the public price page. The dashboard shows the rate after you apply. Sandbox is free. Trial is free within the 10-Item cap. |
| Yodlee | Developer portal exists. Production is a custom enterprise contract, not a self-serve key. FastLink is the supported connection UI. | FastLink. Open-banking redirect where the institution supports it. Older sites still collect credentials inside FastLink. This app must never store bank passwords. | Custom. Minimum commitments are the norm. No public per-card price. |
| MX | API keys are requested (`mx.com/api-access`), not issued from a self-serve signup. | MX Connect widget. OAuth where the institution has it, otherwise credentials inside the widget. | Not published. Sales quote. |
| Flinks | Sandbox exists for customers. The public pricing page has no free production tier. | Flinks Connect. Credentials or institution OAuth depending on the bank. Nightly refresh is a product option. | Connect Starter is published at $500/month for 200 monthly unique connections, 1-year term, monthly minimum. Enrich is a separate meter. That is a business plan, not a personal one. |
| Finicity | Dashboard signup is aimed at businesses in listed countries. Canada is not listed. | Mastercard Connect, permissioned aggregation. | Data-access tiers: Tier 1 basic details free, Tier 2 balances and liability details paid, Tier 3 adds transactions. Sales sets the dollar rate. |
| Akoya | Self-serve sandbox. Production is a data-recipient agreement. | User authenticates at the bank. Akoya does not take the bank password. | Standard plan under 10,000 monthly connections (sandbox plus support). Enterprise pricing above that. Setup fees may apply. US network. |
| Wealthica | B2B plans exist and are described as transparent and scalable. No free tier on the comparison they publish. | Connect widget. | No free tier. Not a card-liability feed. |
| Inverite | Business onboarding for lenders. | Bank login for a verification pull. | Not published. |

## How AmexLens asks Plaid

Least privilege. The Link token requests only what the overview and the existing transaction features need.

- `products`: `transactions` only. Transactions stay the required product so an issuer that cannot do Liabilities can still link, and the spending pages keep working.
- `required_if_supported_products`: `liabilities`. If the institution supports it, Plaid collects consent and initializes it, and the owner cannot opt out of it at an OAuth screen and still finish Link. If the institution does not support it, Link still succeeds.
- `balance` is not a legal `products` value. Plaid initializes Balance consent with the other products. `/accounts/balance/get` is a separate billed call and has to be enabled on the dashboard. The adapter falls back to `/accounts/get` (cached) and records `balance_source`.
- Not requested: Auth, Identity, Investments, Statements, Transfer, Signal. Those would widen consent and, for Auth or Identity, add products this app does not use.
- Update mode for an item that was linked before Liabilities existed: Link token with `access_token` and `additional_consented_products: ["liabilities"]`, and no `products` array. That is the documented way to add consent under Data Transparency Messaging. The access token does not change.
- Country codes stay `US,CA` (`PLAID_COUNTRY_CODES`).
- `redirect_uri` is sent only when `PLAID_REDIRECT_URI` is set.

### Balance policy

- **Sync and cron use the cached balance.** After each `/transactions/sync` the app calls `/accounts/get` (free, cached) for `current`, `available` and `limit`, plus `/liabilities/get`, and records `balance_source: "cached"`.
- **The billed call is explicit.** `/accounts/balance/get` (billed per successful call; Plaid limits it to 5 per minute and 30 per hour per Item) is made only by `POST /api/cards/{id}/refresh`, which is limited to one call per card per 10 minutes. If the live call fails, the adapter falls back to the cached call and reports `balance_source: "cached"`; if both fail it reports `"error"` and leaves stored cards untouched.
- Only `type: "credit"` accounts are kept. Account numbers, routing numbers and owner details are never requested as products and are dropped if a payload contains them.

Calling `/liabilities/get` on an item with no credit account fails and is not billed, per Plaid's personal-finance guidance. The adapter records the error code and leaves liability fields unsupported or not supplied. Transaction sync still commits.

## What this means for the owner

Link Amex Canada, RBC, TD, CIBC, BMO, Scotiabank, National Bank, Tangerine, or Canadian Tire through Plaid and expect a liabilities call to be allowed. Expect some fields to be null anyway. Desjardins, PC Financial, Simplii, and Vancity Visa are the ones where Plaid's own coverage file says Liabilities is off, so the overview will show balances when Balance works and will mark due date, minimum, statement balance, last payment, APR, and overdue as not supported. A second provider is justified only for those gaps, and the provider to add is Yodlee, not Flinks, because only Yodlee publishes the missing fields.
