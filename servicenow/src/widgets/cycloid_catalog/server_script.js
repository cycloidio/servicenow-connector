(function() {
	/* Cycloid services: lists the Cycloid stacks replicated in ServiceNow and
	 * orders one for a project / environment, then sends the user to the
	 * Cycloid console to finish the configuration. */
	var STACK_TABLE = 'x_1829062_cycloi_1_cycloid_stack';
	var PROJECT_TABLE = 'x_1829062_cycloi_1_cycloid_project';
	var ENVIRONMENT_TABLE = 'x_1829062_cycloi_1_cycloid_environment';

	data.title = options.title || gs.getMessage('Cycloid services');
	data.openInNewTab = String(options.open_in_new_tab) === 'true';

	if (input && input.action === 'deploy') {
		try {
			data.result = new x_1829062_cycloi_1.CycloidDeploymentTracker()
				.orderFromPortal(String(input.stack || ''), String(input.project || ''), String(input.environment || ''));
		} catch (e) {
			data.result = { error: e.message };
		}
		return;
	}

	data.configured = !!x_1829062_cycloi_1.CycloidApi.getConfig();
	data.items = [];
	data.projects = [];
	data.environments = [];

	var item = new GlideRecord(STACK_TABLE);
	item.addQuery('active', true);
	item.orderBy('name');
	item.query();
	while (item.next()) {
		var picture = item.getDisplayValue('picture');
		data.items.push({
			sys_id: item.getUniqueValue(),
			name: item.getValue('name'),
			short_description: item.getValue('short_description') || '',
			stack_ref: item.getValue('u_cycloid_stack_ref'),
			picture: picture ? '/' + picture : '',
			initials: String(item.getValue('name') || '?').substring(0, 2).toUpperCase()
		});
	}

	var project = new GlideRecord(PROJECT_TABLE);
	project.addQuery('active', true);
	project.orderBy('name');
	project.query();
	while (project.next()) {
		data.projects.push({
			sys_id: project.getUniqueValue(),
			name: project.getValue('name'),
			canonical: project.getValue('canonical')
		});
	}

	var env = new GlideRecord(ENVIRONMENT_TABLE);
	env.addQuery('active', true);
	env.orderBy('name');
	env.query();
	while (env.next()) {
		data.environments.push({
			sys_id: env.getUniqueValue(),
			name: env.getValue('name'),
			canonical: env.getValue('canonical'),
			project: env.getValue('project')
		});
	}
})();
