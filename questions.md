# Open questions and next steps (after the v2 POC)

v2 is scoped as a POC. It runs on the Cycloid console and API as they are today, and it relies on a few simplifications agreed for the demo. This file lists the gaps those choices leave and the options for the next phase.

Summary:

| # | Topic | POC behavior | Needs |
|---|---|---|---|
| 1 | Stack preselection in the console | Stack list filtered, user clicks the stack | Console change |
| 2 | Linking the request to the component | Heuristic matching | Console or stack change for an exact link |
| 3 | SSO / identity | User logged in to both tools before the demo | IdP setup, user mapping |
| 4 | Project permissions | Every project of the organization is offered | Per-user filtering |
| 5 | Stack / environment compatibility | Not checked | Validation in the form |
| 6 | Approvals and governance | Not enforced | Approval gate design |
| 7 | API key storage | Plain field, admin-only ACL | Credential store |
| 8 | Status updates | Polling every minute | Push from Cycloid |
| 9 | Meaning of "deployed" | Job name pattern | Convention per stack |
| 10 | Validation on a real instance | Tested with fakes only | PDI test run |
| 11 | Packaging | Update set, PDI scope prefix | Cycloid vendor scope |
| 12 | Day-2 operations | Out of scope | Product decision |

## 1. Stack preselection in the Cycloid console

**Today:** The connector opens `.../projects/{p}/environments/{e}/components/create?canonical={stack}`. The console uses `canonical` as the search text, so the stack list shows only that stack, but the user still has to click it. Preselection exists in the console only for cloning a component (`?cloning=env:component`).

**Options:**

- **A (preferred):** a small console change. Read a `stackRef` (or `stack`) query parameter and pass it to the existing `select-on-load` property of the stack selector, which cloning already uses. Optionally also accept a version (`versionId` is already read).
- **B:** keep the search filter (current behavior).

## 2. Linking the ServiceNow request to the Cycloid component

**Today:** ServiceNow does not know which component the user will create, because the user names it in Cycloid and components don't record their creator. The tracker therefore matches heuristically: same stack, same project and environment, created after the request, not present at order time, and not already claimed by another request. This works for demos and low concurrency. It can mix up two people who deploy the same stack in the same environment within the same minutes, or link a component someone created directly in Cycloid without going through ServiceNow.

**Options:**

- **A (preferred):** a console change that accepts `?external_ref=RITM0010023` (and the ServiceNow instance) on the create page, and stores it on the component, for example as a label or metadata exposed by the API. The tracker then filters on it, and the link is exact.
- **B:** let the console prefill the component name or canonical from the URL. ServiceNow would generate it, for example `snow-ritm0010023`, and look it up directly. Simpler, but the user can still change it.
- **C:** add a ServiceNow reference variable to the stack forms (StackForms). The user has to copy it or the console must prefill it, so this depends on A or B anyway.
- **D:** have the pipeline call back ServiceNow (a scripted REST API) with the component and status. This needs a shared step in every stack, plus an inbound credential.

## 3. Single sign-on and identity

**Today:** Not handled. For the demo, the user is logged in to the ServiceNow portal and the Cycloid console beforehand. Without a Cycloid session, the redirect lands on the Cycloid login page, and after login the user may not come back to the create page.

**Options:**

- Federate both tools on the same identity provider: Cycloid supports SAML, OIDC, Azure AD and Google. A Cycloid session is then opened silently.
- Check or extend the console's "redirect after login" behavior so the create page is kept through the login.
- Map ServiceNow users to Cycloid members by email. This is needed for items 4 and 6.

## 4. Project and environment permissions

**Today:** Every project and environment of the organization (as seen by the API key) is offered to every ServiceNow user. A user can pick a project they can't create components in, and only finds out in Cycloid.

**Options:**

- Sync the Cycloid teams and members, then filter the project list per user. Map users by email and take the project permissions from the team roles.
- Use ServiceNow user criteria or groups on projects, maintained by the sync, for example by mirroring Cycloid teams as ServiceNow groups.
- Call the API with a per-user token. That is more complex and depends on SSO (item 3).

## 5. Stack and environment compatibility

**Today:** No check. The console hides stacks whose cloud provider doesn't match the environment's cloud accounts. The user can show them again with a toggle, but may see an empty list after the redirect.

**Options:**

- Sync each environment's cloud providers and accounts, and each stack's `cloud_providers` (already in the API answer). Then filter environments in the form (reference qualifier and widget).
- Show the compatible environments first and warn on mismatches.

## 6. Approvals and governance

**Today:** The RITM is created and the user is sent to Cycloid right away. A ServiceNow approval would not block anything, since the user can also deploy directly from Cycloid.

**Options:**

- **Approval before redirect:** keep the RITM in "awaiting approval", and show the "Continue in Cycloid" link only after approval (a Flow Designer flow on the items). This is ServiceNow-side only, but it doesn't stop anyone from using Cycloid directly.
- **Gate in the pipeline:** add a pipeline step that checks the RITM approval through the ServiceNow API before `apply`. This enforces governance whatever the entry point.
- **ServiceNow-driven creation:** ServiceNow creates the component through the API (`PUT .../components/{c}` with stack, use case and variables) after approval. The user then doesn't need the console form, but StackForms would have to be rendered in ServiceNow, which costs much more.
- Cycloid-side policies (roles, quotas, InfraPolicies) as the actual enforcement point.

## 7. Storing the API key

**Today:** A plain string field on the configuration table, readable by admins only and never logged.

**Options:**

- A *Password (2 way encrypted)* field, plus a KMF module access policy allowing the application scope to decrypt it.
- A Connection & Credential alias with an API key credential, read through `sn_cc.StandardCredentialsProvider`. This is the standard pattern for Store applications.
- A dedicated least-privilege Cycloid role (read stacks, projects, environments, components, pipelines), and a documented rotation procedure.

## 8. Polling versus events

**Today:** Polling every minute, with one call per active deployment plus one per pipeline. This is fine for a POC, but the cost grows with the number of open requests.

**Options:**

- Use Cycloid notifications or webhooks, if available, to push component and build events to a ServiceNow scripted REST API.
- Back off adaptively: poll every minute for the first hour, then every 10 minutes.
- Fetch the component list once per project and environment per run, not once per deployment.

## 9. What "deployed" means

**Today:** A request is complete when the job matching `deploy_job_pattern` (default `apply|deploy`) succeeds. If no job matches, the last job is used. Pipelines with several deployment jobs, manual jobs or destroy jobs may need different rules.

**Options:**

- A convention in the stacks, for example a job name or a tag in `.cycloid.yml` marking the "deployment complete" job.
- A per-stack setting on the ServiceNow catalog item, overriding the global pattern.
- Also report destroy and decommission (see item 12).

## 10. Validation on a real instance

v2 was tested with in-memory fakes of the ServiceNow and Cycloid APIs (`tests/run.js`) and with a widget rendering harness (`tests/ui`). It still has to be checked on the Zurich PDI:

- The update set preview shows no errors, and the tables, forms, menu and portal page are created.
- Cross-scope access to `sc_req_item` (state and comments) and `io_set_item` (variable set link) is allowed by those tables' application access settings.
- The catalog items are visible to non-admin users in the portal and the Service Catalog, with their pictures.
- In the standard catalog, the dependent environment variable filters correctly (`ref_qual_elements`).
- The `canonical` query parameter on the console create page behaves as expected with a real stack list.
- API calls and pagination work against `api.us.cycloid.io` with a real key.

## 11. Packaging and distribution

**Today:** One update set built from `servicenow/build.py`. The scope prefix `x_1829062` comes from the developer instance used for v1.

**Options:**

- Re-create the application under a Cycloid vendor prefix and publish it, privately or on the ServiceNow Store.
- Move the sources to the ServiceNow SDK (Fluent) for code-first development and `now-sdk install`.
- Add ATF tests on top of the Node tests.

## 12. Day-2 operations

Out of scope for the POC:

- Updating a component (new stack version, variables) from ServiceNow.
- Decommissioning: a "remove" request that runs the destroy pipeline or deletes the component, and closes the lifecycle in ServiceNow.
- CMDB: create or update configuration items from Cycloid resources (InfraView, inventory) and link them to the request.
- Reporting: dashboards of requests by stack, project and status.
