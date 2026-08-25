# BentWay Operations handoff — updated 2026-08-26

## Baseline and 2026-08-25 targeted revision

- GitHub `wh17558794-lgtm/Melbourne-Delivery-Map` `main` at `17a9e630a7385dc0b60054e9f2cba47ff05cab54` is a map-only repository and is not the full local Operations System. A read-only ZIP was compared separately; no remote file was changed.
- Production Supabase was initially inspected read-only. Before the 2026-08-25 deployment it had 7 shipments, RLS on the public operational tables, and migration records 10–23 plus 28–31.
- `resume_completed_shipment(uuid)` and `pg_cron` were initially absent; both are now supplied by the deployed SQL32–34 chain.
- The 2026-08-22 revision used the current local test directory as the sole code baseline, not GitHub. No remote read/write was used for this revision.

## Local implementation

- Shipment Details: half-screen two-column workspace; Overview/Operations left and Billing/Activity right, with independent scrolling and fixed header/footer.
- Operations View (OV) / Billing View (BV); BV status remains read-only.
- Shared frontend transition router with dedicated Complete, Resume and Prepare SMS paths.
- Bulk results include tracking/reference, success/failed and database error; all set-changing filters clear selection.
- SQL 32: read-only-compatible SQL31 preflight, Message Sent ordinary transition, dedicated Resume, per-condition Exception acknowledgements and lifecycle pruning. Fingerprints use built-in `pg_catalog.md5`.
- SQL 33: Customer Billing Profiles are the runtime source of defaults; only the one-time seed maps Winmav $80 / Oreo $70. Address repricing only changes `unit_price` / `delivery_rate_id`. Import batch + shipments are inserted by one transaction RPC.
- SQL 34: old totals are preserved before the generated-column change; Completed/Cancelled totals are not bulk recalculated. DTW pricing persists, Storage is `Volume × $20/m³/week`, Warehouse Booking retains unbilled Storage, inactive Crane fee is retained, and post-Delivery Crane creates a supplementary charge. Shipment Details saves through one transaction RPC.
- SQL 35: single Draft Billing Editor with Add/Remove/Save/Discard/atomic Finalise. Expected is captured when a charge enters Draft; edits change only Actual Billing Item components and never write Shipment/Storage/Crane/Container Expected sources. Finalised Actual snapshots are immutable and grouped Shipment Activity records expected/before/after/adjustment metadata.
- SQL 36: Pickup `$0.20/kg ex GST` customer/Shipment snapshots, Admin Billing Profiles, Warehouse Booking ex-GST correction, Crane `$850` fallback, Storage Start Date and Episode GST snapshots, server-authoritative schedule revisions, Billed Week Credits, Storage Credit Required, Details Activity, and direct-write permission hardening.
- Billing UI: no date filter; compact Shipment row with fixed charge columns and Outstanding `Total (incl GST)`, dynamic Fully Billed visibility, complete expanded charge history, selection summary, Storage grouping and full-width Draft editor.
- Sidebar hover area is continuous across gaps/padding and closes 200ms after the pointer actually leaves.
- Crane Operations uses a keyboard-focusable bidirectional-arrow button. Negative hides the fee field but retains its stored value; Positive restores the stored fee or $850 and recalculates while typing.
- Billing Status = Billed is loaded from finalised `billing_documents` / `billing_items` Actual snapshots. Shipment Details shows Billing Adjustments & Supplementary Charges and resolves Activity performers through `profiles.full_name`.
- Storage remains one source row per seven-day week; customer-facing Billing/Draft copy uses `week` / `weeks`.
- Warehouse Booking `$150/$200/custom` is ex GST from SQL36 onward. Pickup is `Weight × Shipment Pickup Rate`; Storage is a separate ex-GST source with Episode GST snapshot. Each charge receives GST once.

## Deployment status

SQL 32–35 were executed in production in order on 2026-08-25. SQL36 was executed on 2026-08-26 after its production read-only preflight passed and the user explicitly approved using the current test-only production data instead of a branch. No GitHub push, commit, frontend deployment or remote overwrite was performed.

Do not modify or rerun SQL 32–36; the next database migration must be SQL 37. `pg_cron` and the active `bentway-storage-periods` job were verified. Authenticated direct UPDATE on Shipments/Profile and direct INSERT on Import Batches were revoked; browser writes use role-checking RPCs. Container Service Fee amount, Invoice/Payment lifecycle and Storage Credit Note/refund remain intentionally undefined.

## Local checks

```powershell
node --check app.js
node --check google-app.js
node --check billing-logic.js
node status-workflow.test.mjs
node pricing-rates.test.mjs
node billing-workflow.test.mjs
node sql36-workflow.test.mjs
```

The Node suites pass locally and include executable billing pure-function tests plus static migration/UI contract checks. SQL36's full database smoke ran against the user-confirmed test-only production database inside one transaction and ended with `ROLLBACK`; existing Draft count/items, Finalised baselines and Billed Storage baselines were unchanged. One pre-existing On Hold test Shipment missing its SQL34 Episode was safely repaired from its Customer Profile rate and now has four independent Unbilled Storage weeks.
