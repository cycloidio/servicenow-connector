/**
 * CycloidSync
 *
 * Replicates Cycloid data into ServiceNow:
 *   - stacks       -> catalog items (table x_1829062_cycloi_1_cycloid_stack, extends sc_cat_item)
 *   - projects     -> x_1829062_cycloi_1_cycloid_project
 *   - environments -> x_1829062_cycloi_1_cycloid_environment
 *
 * Records that disappear from Cycloid are deactivated (never deleted), so
 * existing requests keep their references.
 *
 * Called by the "Cycloid - Sync catalog" scheduled job and by the
 * "Sync now" UI action on the configuration form.
 */
var CycloidSync = Class.create();

CycloidSync.STACK_TABLE = 'x_1829062_cycloi_1_cycloid_stack';
CycloidSync.PROJECT_TABLE = 'x_1829062_cycloi_1_cycloid_project';
CycloidSync.ENVIRONMENT_TABLE = 'x_1829062_cycloi_1_cycloid_environment';
CycloidSync.VARIABLE_SET_ID = '@@VARIABLE_SET_SYS_ID@@';

CycloidSync.prototype = {

	initialize: function(api) {
		this.api = api || new CycloidApi();
		this.config = this.api.config;
	},

	/** Runs every sync. Returns a summary object. */
	syncAll: function() {
		var summary = { stacks: null, projects: null, errors: [] };
		try {
			summary.stacks = this.syncStacks();
		} catch (e) {
			summary.errors.push('Stacks: ' + e.message);
			CycloidApi.error('Stack sync failed: ' + e.message);
		}
		try {
			summary.projects = this.syncProjects();
		} catch (e2) {
			summary.errors.push('Projects: ' + e2.message);
			CycloidApi.error('Project sync failed: ' + e2.message);
		}
		CycloidApi.info('Sync finished: ' + JSON.stringify(summary));
		return summary;
	},

	/* ------------------------------------------------------------------ */
	/* Stacks                                                              */
	/* ------------------------------------------------------------------ */

	/** Should this Cycloid stack be offered in ServiceNow? */
	isPublishable: function(stack) {
		if (!stack || !stack.ref) {
			return false;
		}
		if (stack.blueprint === true) {
			return false; // blueprints are templates used to create stacks
		}
		if (stack.visibility === 'hidden') {
			return false;
		}
		return true;
	},

	syncStacks: function() {
		var category = this._resolveCategory(this.config.catalogCategory);
		if (!category) {
			throw new Error('Catalog category "' + this.config.catalogCategory + '" not found. ' +
				'Set catalog_category to the sys_id (or title) of an existing sc_category.');
		}

		var stacks = this.api.listStacks();
		var result = { created: 0, updated: 0, deactivated: 0, skipped: 0 };
		var seen = {};
		var now = new GlideDateTime().getValue();

		for (var i = 0; i < stacks.length; i++) {
			var stack = stacks[i];
			if (!this.isPublishable(stack)) {
				result.skipped++;
				continue;
			}
			seen[stack.ref] = true;

			var item = new GlideRecord(CycloidSync.STACK_TABLE);
			item.addQuery('u_cycloid_stack_ref', stack.ref);
			item.query();
			var isUpdate = item.next();
			if (!isUpdate) {
				item.initialize();
			}

			var description = String(stack.description || '');
			item.setValue('name', stack.name || CycloidApi.stackCanonical(stack.ref));
			item.setValue('short_description', (description || 'Deploy with Cycloid').substring(0, 160));
			item.setValue('description', this._descriptionHtml(stack));
			item.setValue('category', category.sysId);
			if (category.catalogId) {
				item.setValue('sc_catalogs', category.catalogId);
			}
			item.setValue('active', true);
			item.setValue('u_cycloid_stack_ref', stack.ref);
			item.setValue('stack_canonical', stack.canonical || CycloidApi.stackCanonical(stack.ref));
			item.setValue('last_synced', now);
			this._setIfValid(item, 'meta', (stack.keywords || []).join(' '));
			this._setIfValid(item, 'no_quantity', true);
			this._setIfValid(item, 'no_cart', true);

			var sysId = isUpdate ? item.update() : item.insert();
			if (!sysId) {
				CycloidApi.error('Could not save catalog item for stack ' + stack.ref);
				continue;
			}
			if (isUpdate) {
				result.updated++;
			} else {
				result.created++;
			}

			this._ensureVariableSet(sysId);
			this._syncPicture(sysId, stack.image);
		}

		// Deactivate items whose stack is gone (or became hidden / blueprint)
		var old = new GlideRecord(CycloidSync.STACK_TABLE);
		old.addQuery('active', true);
		old.query();
		while (old.next()) {
			if (!seen[old.getValue('u_cycloid_stack_ref')]) {
				old.setValue('active', false);
				old.update();
				result.deactivated++;
			}
		}

		return result;
	},

	_descriptionHtml: function(stack) {
		var esc = function(s) {
			return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		};
		var html = '<p>' + esc(stack.description || 'Cycloid stack') + '</p>';
		var meta = [];
		if (stack.author) {
			meta.push('Author: ' + esc(stack.author));
		}
		if (stack.cloud_providers && stack.cloud_providers.length) {
			var cps = [];
			for (var i = 0; i < stack.cloud_providers.length; i++) {
				cps.push(esc(stack.cloud_providers[i].name || stack.cloud_providers[i].canonical));
			}
			meta.push('Cloud: ' + cps.join(', '));
		}
		meta.push('Stack: ' + esc(stack.ref));
		html += '<p><small>' + meta.join(' &middot; ') + '</small></p>';
		return html;
	},

	_setIfValid: function(gr, field, value) {
		if (gr.isValidField(field)) {
			gr.setValue(field, value);
		}
	},

	/**
	 * Attaches the "Cycloid deployment target" variable set to the item.
	 * Scoped applications cannot write io_set_item directly (cross-scope
	 * policy of the table), so the Service Catalog scoped API is used.
	 */
	_ensureVariableSet: function(itemSysId) {
		var link = new GlideRecord('io_set_item');
		link.addQuery('sc_cat_item', itemSysId);
		link.addQuery('variable_set', CycloidSync.VARIABLE_SET_ID);
		link.query();
		if (link.next()) {
			return;
		}
		try {
			var m2m = new sn_sc.CatalogItemVariableSetM2M();
			m2m.setAttributes({
				sc_cat_item: itemSysId,
				variable_set: CycloidSync.VARIABLE_SET_ID,
				order: 100
			});
			if (!m2m.create(true)) {
				CycloidApi.warn('Could not attach the Cycloid variable set to catalog item ' + itemSysId);
			}
		} catch (e) {
			CycloidApi.warn('Could not attach the Cycloid variable set to catalog item ' + itemSysId + ': ' + e.message);
		}
	},

	/**
	 * Downloads the stack image into the catalog item "picture" field, only
	 * when the image URL changed since the last sync.
	 */
	_syncPicture: function(itemSysId, imageUrl) {
		var item = new GlideRecord(CycloidSync.STACK_TABLE);
		if (!item.get(itemSysId)) {
			return;
		}
		var url = String(imageUrl || '');
		if (url === String(item.getValue('image_url') || '')) {
			return;
		}
		if (!/^https?:\/\//i.test(url)) {
			item.setValue('image_url', url);
			item.update();
			return;
		}

		try {
			// Image fields store their file as an attachment on "ZZ_YY<table>" named after the field.
			var imageTable = 'ZZ_YY' + CycloidSync.STACK_TABLE;
			var previous = item.getValue('picture');

			var rm = new sn_ws.RESTMessageV2();
			rm.setHttpMethod('get');
			rm.setEndpoint(url);
			rm.setHttpTimeout(CycloidApi.HTTP_TIMEOUT_MS);
			rm.saveResponseBodyAsAttachment(imageTable, itemSysId, 'picture');
			var resp = rm.execute();
			if (resp.getStatusCode() !== 200) {
				CycloidApi.warn('Image download failed (HTTP ' + resp.getStatusCode() + ') for ' + url);
				return;
			}
			var attachmentId = resp.getResponseAttachmentSysid();
			if (!attachmentId) {
				return;
			}
			if (previous && previous !== attachmentId) {
				new GlideSysAttachment().deleteAttachment(previous);
			}
			item.setValue('picture', attachmentId);
			item.setValue('image_url', url);
			item.update();
		} catch (e) {
			CycloidApi.warn('Could not set picture from ' + url + ': ' + e.message);
		}
	},

	/**
	 * Accepts an sc_category sys_id (preferred) or title.
	 * Returns { sysId, catalogId } or null.
	 */
	_resolveCategory: function(value) {
		var v = String(value || '').replace(/^\s+|\s+$/g, '');
		if (!v) {
			return null;
		}
		var cat = new GlideRecord('sc_category');
		if (/^[0-9a-f]{32}$/.test(v) && cat.get(v)) {
			return { sysId: cat.getUniqueValue(), catalogId: cat.getValue('sc_catalog') };
		}
		cat = new GlideRecord('sc_category');
		cat.addQuery('title', v);
		cat.query();
		if (cat.next()) {
			return { sysId: cat.getUniqueValue(), catalogId: cat.getValue('sc_catalog') };
		}
		return null;
	},

	/* ------------------------------------------------------------------ */
	/* Projects & environments                                             */
	/* ------------------------------------------------------------------ */

	syncProjects: function() {
		var result = { projects: 0, environments: 0, deactivated: 0 };
		var now = new GlideDateTime().getValue();
		var seenProjects = {};
		var seenEnvs = {};

		var projects = this.api.listProjects();
		for (var i = 0; i < projects.length; i++) {
			var p = projects[i];
			if (!p || !p.canonical) {
				continue;
			}
			var projectSysId = this._upsert(CycloidSync.PROJECT_TABLE, { canonical: p.canonical }, {
				name: p.name || p.canonical,
				description: String(p.description || '').substring(0, 1000),
				active: true,
				last_synced: now
			});
			seenProjects[projectSysId] = true;
			result.projects++;

			var envs = this.api.listProjectEnvironments(p.canonical);
			for (var j = 0; j < envs.length; j++) {
				var e = envs[j];
				if (!e || !e.canonical) {
					continue;
				}
				var envSysId = this._upsert(CycloidSync.ENVIRONMENT_TABLE, { project: projectSysId, canonical: e.canonical }, {
					name: e.name || e.canonical,
					active: true,
					last_synced: now
				});
				seenEnvs[envSysId] = true;
				result.environments++;
			}
		}

		result.deactivated += this._deactivateMissing(CycloidSync.PROJECT_TABLE, seenProjects);
		result.deactivated += this._deactivateMissing(CycloidSync.ENVIRONMENT_TABLE, seenEnvs);
		return result;
	},

	_upsert: function(table, keys, values) {
		var gr = new GlideRecord(table);
		var k;
		for (k in keys) {
			if (keys.hasOwnProperty(k)) {
				gr.addQuery(k, keys[k]);
			}
		}
		gr.query();
		var isUpdate = gr.next();
		if (!isUpdate) {
			gr.initialize();
			for (k in keys) {
				if (keys.hasOwnProperty(k)) {
					gr.setValue(k, keys[k]);
				}
			}
		}
		for (k in values) {
			if (values.hasOwnProperty(k)) {
				gr.setValue(k, values[k]);
			}
		}
		return isUpdate ? gr.update() : gr.insert();
	},

	_deactivateMissing: function(table, seen) {
		var count = 0;
		var gr = new GlideRecord(table);
		gr.addQuery('active', true);
		gr.query();
		while (gr.next()) {
			if (!seen[gr.getUniqueValue()]) {
				gr.setValue('active', false);
				gr.update();
				count++;
			}
		}
		return count;
	},

	type: 'CycloidSync'
};
