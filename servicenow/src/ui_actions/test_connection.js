// "Test connection" button on the Cycloid Configuration form
(function() {
	try {
		var api = new x_1829062_cycloi_1.CycloidApi();
		var projects = api.listProjects();
		var stacks = api.listStacks();
		gs.addInfoMessage('Connected to Cycloid organization "' + api.org() + '": ' + stacks.length +
			' stack(s) and ' + projects.length + ' project(s) visible with this API key.');
	} catch (e) {
		gs.addErrorMessage('Cycloid connection failed: ' + e.message);
	}
	action.setRedirectURL(current);
})();
