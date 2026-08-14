# BentWay Logistics Operations System

Static warehouse and delivery operations system backed by Supabase.

## Included

- Pending shipment, intake and shipment history pages
- Delivery map and local Melbourne delivery-area GeoJSON
- Supabase browser client configuration
- SQL changes currently available locally (`07_` through `22_`)
- Google Sheets automation helper

## Run locally

Double-click `START-BENTWAY-SYSTEM.cmd`, then open `http://localhost:8080/`.

## Publish with GitHub Pages

1. Upload the contents of this folder to the root of a GitHub repository.
2. Open **Settings → Pages** in GitHub.
3. Select **Deploy from a branch**, choose `main`, and use the repository root.
4. Add the final GitHub Pages domain to the allowed origins for any Google APIs used by the map or Google Sheets integration.
5. Refresh the published page after deployment.

## Configuration and security

- `supabase-config.js` contains a browser-safe Supabase publishable key.
- `config.js` contains browser-side Google configuration.
- Never commit a Supabase secret/service-role key, database password, connection string, unrestricted Google API key, or `.env` file.
- Restrict any Google browser API key to the exact GitHub Pages domain and only the APIs used by this project.
- Supabase Row Level Security remains responsible for protecting database records.

## Database note

GitHub stores the frontend and the included SQL change files; it does not contain the live Supabase database or shipment records. The included SQL files are incremental changes and are not a complete fresh-database bootstrap.
