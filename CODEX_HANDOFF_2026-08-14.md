# Bentway Logistics Operations System — Codex Handoff

Date: 14 August 2026 (Australia/Sydney)

## How to continue on another computer

1. Copy the complete handoff ZIP to the new computer.
2. Extract the ZIP. No GitHub download or existing project is required.
3. Open the extracted `Bentway-Logistics-Operations-System` folder in Codex.
4. Give Codex this instruction: `Read CODEX_HANDOFF_2026-08-14.md completely, inspect the included changed files, and continue the Bentway Logistics Operations System from this state.`
5. The package includes the browser-safe Supabase project URL and publishable key so it can reconnect to the existing online database. It contains no database password, `service_role` key, secret key or `.env` file.

## Current system scope

The system is an English-language web operations system for warehouse intake, pending shipments, shipment history and delivery mapping. It uses Supabase project `fyhqowngijfbeohhefgv` for authentication and Postgres data.

Current main pages:

- Pending Shipments
- Shipment Intake, including manual and Excel/CSV import
- Shipment History
- Delivery Map

The layout uses a fixed Supabase-inspired top bar, an icon-only left navigation that expands as an overlay on hover, white/minimal styling, and right-side drawers for shipment editing and status changes.

## Latest completed changes

### Pending shipment table

- A/B display modes are supported and persist until account sign-out or forced browser refresh.
- A mode fields: checkbox, QTY, City, Tracking No., Customer Reference, Name, Address, Phone No., Inbound Time, Container No. and Status.
- B mode fields: Container No., Tracking No., Customer Reference, Weight, Volume, Status, Suburb, Unit Price, Fuel Levy and Total Charge.
- Double-clicking a row opens its editable details drawer.
- Ctrl+click and checkboxes support multi-selection.
- Selected shipments can be marked Delivered, Picked Up, Warehouse Delivery, Return or Delete from the top bar.

### Status workflow

Supported working statuses include:

- Pending
- Out For Delivery
- Scheduled On
- On Hold
- Pending Warehouse Booking

Scheduled dates display a weekday when the date is in this week, or `Next weekday` when it is in next week. Overdue scheduled shipments can create the red reminder dot. Pending Warehouse Booking uses a default charge of $150.

### Melbourne pricing

- V1 and V2: $40 per m³
- V3: $60 per m³
- V4: $100 per m³
- Postcode 3065 belongs only to V1.
- Fuel Levy normally equals `Volume × Unit Price × 20%`.
- Standard Total Charge equals `(Volume × Unit Price + Tail Lift Service Fee + Fuel Levy) × 1.10`.

### Crane and billing — latest work

- Every shipment now has `Crane Required`, defaulting to Negative/false.
- When changed to Positive, a positive Crane Truck Fee is required.
- A red-tinted `Crane Required` badge appears beside Status in both A and B table modes.
- Crane Truck Fee is added after GST, matching the approved example:
  - Standard: `(9.87 × 40 + 80 + 9.87 × 40 × 20%) × 1.10 = 609.136`
  - With crane: `609.136 + 800 = 1409.136`
- Database `base_charge` was renamed to `tail_lift_service_fee`.
- Oreo shipments default to a $70 Tail Lift Service Fee.
- Wanma and all other customers default to $80.
- The details drawer now includes editable Status, status date where needed, Tail Lift Service Fee, Crane Required, Crane Truck Fee, Fuel Levy and Total Charge.
- Fuel Levy and Total Charge accept only non-negative numeric values.
- Editing Fuel Levy or Total Charge saves an override; clearing the value and saving returns it to automatic calculation.
- The details drawer displays the formula and actual substituted calculation on separate lines.

## Database state

The following production migrations have already been applied successfully to Supabase. Do not run them again against the same production project unless deliberately rebuilding another database:

- 10 `add_shipment_quantity_and_dispatch_status`
- 11 `add_billing_and_suburb_rates`
- 12 `secure_billing_pricing_function`
- 13 `import_melbourne_postcode_rates`
- 14 `allow_pending_dispatch_status`
- 15 `add_on_hold_status`
- 16 `add_pending_warehouse_booking`
- 17 `add_crane_and_editable_billing`
- 18 `rename_tail_lift_service_fee`

Latest verification results:

- Oreo Tail Lift Service Fee: 70.00
- Other customers: 80.00
- Standard example total: 609.136
- Crane example total: 1409.136
- Invalid positive-crane records: 0
- Old `base_charge` columns remaining: 0
- No new Supabase advisor warning referenced the newly added billing or crane fields.

## Included project files

- The complete web system, not just the latest changed files
- `index.html`, application JavaScript and all CSS
- Map page, local boundary data and required assets/fonts
- Bentway logo and favicon assets
- Local start/preview tools
- Google Maps and Google Sheets integration files
- All locally available SQL files, `07` through `18`
- Setup notes and this handoff document

The latest JavaScript syntax check passed, all 97 HTML IDs are unique, no merge markers remain, and no stale Base Charge references remain in the live frontend files.

## Important implementation decisions

- The user-approved numerical examples require a GST multiplier of `1.10`, not `10%` alone.
- Crane Truck Fee is added after the standard GST-inclusive total, because this matches `609.136 + 800 = 1409.136`.
- Pending Warehouse Booking keeps its special $150 base charge and adds Crane Truck Fee if required.
- Credentials must not be pasted into this handoff. Use the existing configured Supabase publishable key on the new computer.

## Good next checks after transfer

1. Start the local website and sign in.
2. Force-refresh once so the new cached CSS and JavaScript versions load.
3. Double-click one pending shipment and verify all new billing fields.
4. Test Negative to Positive crane selection and confirm the red badge and total.
5. Test an Oreo shipment and another customer to confirm the $70/$80 Tail Lift defaults.
