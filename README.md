## Cycloid Service Catalog Connector for ServiceNow

### Overview
Synchronize Cycloid stacks into ServiceNow and surface them either:
- As a Service Portal widget that lists stacks and links to Cycloid
- As Catalog Items inside a chosen Service Catalog category, created/updated by a scheduled sync

This application defines a configuration table and a script include that calls the Cycloid API to retrieve stacks. You may choose one or both presentation options (widget and/or catalog items).

### What gets installed
- **Table `Cycloid Configuration`**: API and org settings. API name: `x_1829062_cycloi_1_cycloid_config`.
- **Table `Cycloid Stack`**: Extends `sc_cat_item` and is used when syncing stacks as catalog items. API name: `x_1829062_cycloi_1_cycloid_stack`.
- **Script Include**: `x_1829062_cycloi_1.CycloidIntegration`
- **Service Portal Widget**: `Cycloid Stacks` (widget id: `cycloid_stacks_list`)
- **Role**: `x_1829062_cycloi_1.admin` (admin role for the scoped app)
- **Dependency**: Service Catalog Platform plugin (ensure it is active)

### Prerequisites
- ServiceNow role: admin, or the app-scoped admin role `x_1829062_cycloi_1.admin`
- Network egress from your instance to the Cycloid API URL
- Cycloid credentials and URLs:
  - **organization_canonical**: Your Cycloid organization canonical
  - **api_key**: API token with permissions to read service catalogs/stacks
  - **api_url**: Cycloid API base URL (e.g. `https://http-api.cycloid.io/v1`)
  - **console_url**: Cycloid Console base URL (e.g. `https://console.cycloid.io`)

### Install the application from this repository
1. In ServiceNow, go to: System Applications → Studio → Import from Source Control
2. Enter the Git repository URL where this code is hosted. If the repo is private, provide credentials/PAT.
3. The repo includes `sn_source_control.properties` pointing to the app subfolder; ServiceNow will use it automatically.
4. Complete the import. When prompted about missing dependencies, activate them (Service Catalog Platform).

To update later, use Studio → Source Control → Pull to bring newer commits.

### Configure the application
The app creates the table `Cycloid Configuration` (`x_1829062_cycloi_1_cycloid_config`). Create a single record:
- **organization_canonical**: Your Cycloid org canonical
- **api_key**: Bearer token used to call Cycloid API (just give permissions for listing stacks)
- **console_url**: Base URL to Cycloid Console (no trailing slash required)
- **api_url**: Base URL to Cycloid API (e.g., `https://http-api.cycloid.io/`)
- **catalog_category**: The Service Catalog Category to receive Cycloid stacks (see next section)

#### Create the target catalog category (required for catalog sync)
- Go to Service Catalog → Maintain Categories
- Create a category in the **Global** scope (recommended)
- Copy the category `sys_id` and paste it into the `catalog_category` field in `Cycloid Configuration`

### Option A — Service Portal Widget (zero-impact on catalog)
The widget displays Cycloid stacks and links users to Cycloid Console for details.

Widget details:
- Name: `Cycloid Stacks`
- Widget id: `cycloid_stacks_list`
- Implementation: server script calls `x_1829062_cycloi_1.CycloidIntegration().getStacks()` and builds links to Console

Add it to a portal page:
1. Service Portal → Pages → open or create a page
2. Add a container/row as desired and insert the `Cycloid Stacks` widget
3. Publish the page and verify it renders a grid of stacks; clicking a card opens the stack in Cycloid Console

If you see “Missing Cycloid configuration.”, ensure your `Cycloid Configuration` record exists and is complete.

### Option B — Sync as Service Catalog Items (scheduled)
The app can sync Cycloid stacks into the category you specified by creating/maintaining items in `x_1829062_cycloi_1_cycloid_stack` (extends `sc_cat_item`). Each item is a Content-type external link that opens the corresponding stack in Cycloid Console. Images, when provided by Cycloid, are attached as the item picture.

Set up a scheduled job:
1. System Definition → Scheduled Jobs → New → Scheduled Script Execution
2. Name: “Cycloid Stacks Sync” (or similar)
3. Run: choose a cadence (e.g., hourly or daily)
4. Script:
```javascript
(function() {
  new x_1829062_cycloi_1.CycloidIntegration().syncStacks();
})();
```
5. Save. Click “Execute Now” to run an immediate sync.

What the sync does:
- Resolves the category from `catalog_category` (accepts `sys_id` preferred, or title as fallback)
- Calls Cycloid API using `api_url`, `organization_canonical`, and `api_key`
- Creates or updates items under `x_1829062_cycloi_1_cycloid_stack`
- Sets type to Content → External and points to the Cycloid Console stack URL
- Attaches the stack image as item picture when available

Post-sync, you can tailor additional behavior (flows, approvals, custom forms) on these items per your process.

### Logging and troubleshooting
- System Logs → All: filter for messages containing “Cycloid” to view integration logs
- Common issues:
  - **Missing configuration**: Create/populate `Cycloid Configuration`
  - **Invalid `catalog_category`**: Ensure it’s a valid `sc_category` `sys_id`; titles are supported but `sys_id` is preferred
  - **API errors (4xx/5xx)**: Verify `api_url`, `api_key` permissions, and network egress to Cycloid
  - **No stacks returned**: Confirm the organization has visible stacks and the API key can read them
  - **Images not showing**: Ensure the image URL is reachable and returns a 200 with an image content type

### Roles and access
- Admins or `x_1829062_cycloi_1.admin` can install and configure the app
- End users do not need special roles to view the widget or catalog items unless your portal/catalog configuration imposes them

### Security notes
- The `api_key` is stored in the `Cycloid Configuration` table. Restrict who can read this table using ACLs as per your policy.
- The integration performs outbound REST calls from the instance; ensure outbound access to your Cycloid endpoints.

### Maintenance
- To update: Studio → Source Control → Pull, then re-run the scheduled sync if using the catalog option
- To re-seed catalog items: execute the scheduled job manually (“Execute Now”)
- To uninstall/cleanup: remove the scheduled job, delete items under `x_1829062_cycloi_1_cycloid_stack` if desired, then remove the application

### Support
If you need help with configuration or behavior customization, contact your Cycloid representative or open an issue in the repository hosting this application.


