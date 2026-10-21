api.controller = function($scope, $interval) {
	/* widget controller */
	var c = this;
	var REFRESH_MS = 30000;

	var LABELS = {
		'Awaiting component': 'label-info',
		'Waiting for pipeline': 'label-info',
		'Running': 'label-primary',
		'Succeeded': 'label-success',
		'Failed': 'label-danger',
		'Timed out': 'label-warning',
		'Cancelled': 'label-default'
	};

	c.labelClass = function(status) {
		return LABELS[status] || 'label-default';
	};

	c.hasActive = function() {
		return (c.data.items || []).some(function(it) {
			return it.active;
		});
	};

	c.refresh = function() {
		c.server.refresh();
	};

	var timer = $interval(function() {
		if (c.hasActive()) {
			c.server.refresh();
		}
	}, REFRESH_MS);

	$scope.$on('$destroy', function() {
		$interval.cancel(timer);
	});
};
