// "Sync now" button on the Cycloid Configuration form
(function() {
	try {
		var summary = new x_1829062_cycloi_1.CycloidSync().syncAll();
		var s = summary.stacks || {};
		var p = summary.projects || {};
		var msg = 'Cycloid sync done. Stacks: ' + (s.created || 0) + ' created, ' + (s.updated || 0) + ' updated, ' +
			(s.deactivated || 0) + ' deactivated. Projects: ' + (p.projects || 0) + ', environments: ' +
			(p.environments || 0) + '.';
		gs.addInfoMessage(msg);
		for (var i = 0; i < summary.errors.length; i++) {
			gs.addErrorMessage(summary.errors[i]);
		}
	} catch (e) {
		gs.addErrorMessage('Cycloid sync failed: ' + e.message);
	}
	action.setRedirectURL(current);
})();
