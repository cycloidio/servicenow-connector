(function() {
	/* My Cycloid deployments: requests sent to Cycloid by the current user
	 * and their live status. */
	var TABLE = 'x_1829062_cycloi_1_cycloid_deployment';
	var limit = parseInt(options.limit, 10) || 10;

	data.title = options.title || gs.getMessage('My Cycloid deployments');
	data.items = [];

	var gr = new GlideRecord(TABLE);
	gr.addQuery('requested_for', gs.getUserID());
	gr.orderByDesc('requested_at');
	gr.setLimit(limit);
	gr.query();
	while (gr.next()) {
		var active = gr.getValue('active');
		data.items.push({
			sys_id: gr.getUniqueValue(),
			stack: gr.getDisplayValue('stack'),
			project: gr.getDisplayValue('project'),
			environment: gr.getDisplayValue('environment'),
			status: gr.getValue('status'),
			status_message: gr.getValue('status_message') || '',
			active: active === '1' || active === 'true',
			ritm_number: gr.getDisplayValue('requested_item'),
			ritm_sys_id: gr.getValue('requested_item'),
			requested_at: gr.getDisplayValue('requested_at'),
			component_name: gr.getValue('component_name') || '',
			create_url: gr.getValue('create_url') || '',
			component_url: gr.getValue('component_url') || '',
			build_url: gr.getValue('build_url') || ''
		});
	}
})();
