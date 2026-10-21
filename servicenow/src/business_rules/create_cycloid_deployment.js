(function executeRule(current, previous /*null when async*/) {
	// Runs asynchronously after a Cycloid catalog item is ordered from the
	// standard catalog. Orders placed from the Cycloid portal page already
	// created their deployment record: the call is idempotent.
	try {
		new x_1829062_cycloi_1.CycloidDeploymentTracker().ensureDeploymentForRitm(current.getUniqueValue());
	} catch (e) {
		x_1829062_cycloi_1.CycloidApi.error('Could not initialise the Cycloid deployment for ' +
			current.getValue('number') + ': ' + e.message);
	}
})(current, previous);
