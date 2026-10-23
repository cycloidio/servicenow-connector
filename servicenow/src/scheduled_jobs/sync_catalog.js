// Cycloid - Sync catalog
// Replicates Cycloid stacks (catalog items), projects and environments.
(function() {
	if (!x_1829062_cycloi_1.CycloidApi.getConfig()) {
		return; // connector not configured yet
	}
	new x_1829062_cycloi_1.CycloidSync().syncAll();
})();
