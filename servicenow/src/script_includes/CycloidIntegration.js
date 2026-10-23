/**
 * CycloidIntegration
 *
 * Entry points kept from v1 so existing scheduled jobs keep working.
 * New code should use CycloidApi, CycloidSync and CycloidDeploymentTracker.
 */
var CycloidIntegration = Class.create();
CycloidIntegration.prototype = {
	initialize: function() {},

	/** v1: returns the raw list of stacks. */
	getStacks: function() {
		try {
			return new CycloidApi().listStacks();
		} catch (e) {
			CycloidApi.error(e.message);
			return [];
		}
	},

	/** v1: synchronises stacks (v2 also synchronises projects and environments). */
	syncStacks: function() {
		return new CycloidSync().syncAll();
	},

	/** Synchronises stacks, projects and environments. */
	syncAll: function() {
		return new CycloidSync().syncAll();
	},

	/** Follows the deployments in progress. */
	trackDeployments: function() {
		return new CycloidDeploymentTracker().poll();
	},

	type: 'CycloidIntegration'
};
