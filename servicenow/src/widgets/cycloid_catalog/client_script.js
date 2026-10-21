api.controller = function($scope, $window) {
	/* widget controller */
	var c = this;

	c.search = '';
	c.selected = null;
	c.form = { project: '', environment: '' };
	c.busy = false;
	c.error = '';
	c.done = null;

	c.filtered = function() {
		var q = String(c.search || '').toLowerCase();
		return (c.data.items || []).filter(function(it) {
			var text = (it.name + ' ' + it.short_description + ' ' + it.stack_ref).toLowerCase();
			return !q || text.indexOf(q) >= 0;
		});
	};

	c.open = function(item) {
		c.selected = item;
		c.form = { project: '', environment: '' };
		c.error = '';
		c.done = null;
		if ((c.data.projects || []).length === 1) {
			c.form.project = c.data.projects[0].sys_id;
			c.onProjectChange();
		}
	};

	c.close = function() {
		if (!c.busy) {
			c.selected = null;
		}
	};

	c.environments = function() {
		return (c.data.environments || []).filter(function(e) {
			return e.project === c.form.project;
		});
	};

	c.onProjectChange = function() {
		c.form.environment = '';
		var envs = c.environments();
		if (envs.length === 1) {
			c.form.environment = envs[0].sys_id;
		}
	};

	c.canSubmit = function() {
		return !!(c.selected && c.form.project && c.form.environment && !c.busy);
	};

	c.submit = function() {
		if (!c.canSubmit()) {
			return;
		}
		c.busy = true;
		c.error = '';
		// Open the tab synchronously (user gesture) so that pop-up blockers let it through.
		var win = c.data.openInNewTab ? $window.open('', '_blank') : null;

		c.server.get({
			action: 'deploy',
			stack: c.selected.sys_id,
			project: c.form.project,
			environment: c.form.environment
		}).then(function(response) {
			var res = (response && response.data && response.data.result) || {};
			if (res.error || !res.create_url) {
				c.busy = false;
				c.error = res.error || 'Unexpected error, please try again.';
				if (win) {
					win.close();
				}
				return;
			}
			c.done = res;
			if (win) {
				win.location.href = res.create_url;
				c.busy = false;
			} else {
				$window.location.href = res.create_url;
			}
		}, function() {
			c.busy = false;
			c.error = 'The request could not be sent, please try again.';
			if (win) {
				win.close();
			}
		});
	};

	$scope.$on('$destroy', function() {
		c.selected = null;
	});
};
