/**
 * CycloidDeploymentTracker
 *
 * Owns the life cycle of a "Cycloid deployment" record
 * (x_1829062_cycloi_1_cycloid_deployment), which links a ServiceNow
 * requested item (RITM) to the component the user creates in Cycloid.
 *
 *   orderFromPortal()          portal widget: orders the catalog item and returns the console URL
 *   ensureDeploymentForRitm()  creates the deployment record for a RITM (idempotent)
 *   poll()                     scheduled job: finds the component, follows its pipeline,
 *                              updates the deployment and the RITM
 *
 * Status flow:
 *
 *   Awaiting component --(component found)--> Waiting for pipeline --> Running --> Succeeded
 *          |                                         ^      |              |
 *          |                                         |      v              v
 *          +--(timeout)--> Timed out                 +--- Failed --(monitoring window over)--> Failed (closed)
 */
var CycloidDeploymentTracker = Class.create();

CycloidDeploymentTracker.TABLE = 'x_1829062_cycloi_1_cycloid_deployment';
CycloidDeploymentTracker.STACK_TABLE = 'x_1829062_cycloi_1_cycloid_stack';
CycloidDeploymentTracker.PROJECT_TABLE = 'x_1829062_cycloi_1_cycloid_project';
CycloidDeploymentTracker.ENVIRONMENT_TABLE = 'x_1829062_cycloi_1_cycloid_environment';

CycloidDeploymentTracker.STATUS = {
	AWAITING_COMPONENT: 'Awaiting component',
	WAITING_PIPELINE: 'Waiting for pipeline',
	RUNNING: 'Running',
	SUCCEEDED: 'Succeeded',
	FAILED: 'Failed',
	TIMED_OUT: 'Timed out',
	CANCELLED: 'Cancelled'
};

/** sc_req_item.state values */
CycloidDeploymentTracker.RITM_STATE = {
	WORK_IN_PROGRESS: '2',
	CLOSED_COMPLETE: '3',
	CLOSED_INCOMPLETE: '4'
};

/** Concourse build statuses */
CycloidDeploymentTracker.BUILD_RUNNING = ['pending', 'started'];
CycloidDeploymentTracker.BUILD_FAILED = ['failed', 'errored', 'aborted'];

/** Tolerated clock skew between ServiceNow and Cycloid when matching components. */
CycloidDeploymentTracker.CLOCK_SKEW_MS = 5 * 60 * 1000;

/** GlideRecord booleans come back as '1'/'0' (or 'true'/'false'). */
CycloidDeploymentTracker.isTrue = function(v) {
	return v === true || v === 1 || v === '1' || v === 'true';
};

CycloidDeploymentTracker.prototype = {

	initialize: function(api) {
		this._api = api || null;
	},

	api: function() {
		if (!this._api) {
			this._api = new CycloidApi();
		}
		return this._api;
	},

	/* ------------------------------------------------------------------ */
	/* Ordering                                                            */
	/* ------------------------------------------------------------------ */

	/**
	 * Orders a Cycloid catalog item on behalf of the current user and creates
	 * the deployment record.
	 *
	 * @return {Object} { create_url, request_number, ritm_number, ritm_sys_id, deployment_sys_id }
	 */
	orderFromPortal: function(stackSysId, projectSysId, environmentSysId) {
		var item = new GlideRecord(CycloidDeploymentTracker.STACK_TABLE);
		if (!item.get(stackSysId) || !CycloidDeploymentTracker.isTrue(item.getValue('active'))) {
			throw new Error('This service is not available anymore.');
		}
		this._loadTarget(projectSysId, environmentSysId); // validates the selection
		this.api(); // fails early (before ordering) when the connector is not configured

		var cart = new sn_sc.CartJS();
		var order = cart.orderNow({
			sysparm_id: stackSysId,
			sysparm_quantity: '1',
			variables: {
				cycloid_project: projectSysId,
				cycloid_environment: environmentSysId
			}
		});
		if (!order || !order.request_id) {
			throw new Error('The request could not be created.');
		}

		var ritm = new GlideRecord('sc_req_item');
		ritm.addQuery('request', order.request_id);
		ritm.addQuery('cat_item', stackSysId);
		ritm.orderByDesc('sys_created_on');
		ritm.setLimit(1);
		ritm.query();
		if (!ritm.next()) {
			throw new Error('The requested item could not be found for ' + order.request_number + '.');
		}

		var deployment = this.ensureDeploymentForRitm(ritm.getUniqueValue(), {
			project: projectSysId,
			environment: environmentSysId
		});
		if (!deployment) {
			throw new Error('The Cycloid deployment could not be initialised.');
		}

		return {
			create_url: deployment.getValue('create_url'),
			request_number: order.request_number,
			ritm_number: ritm.getValue('number'),
			ritm_sys_id: ritm.getUniqueValue(),
			deployment_sys_id: deployment.getUniqueValue()
		};
	},

	/**
	 * Returns the deployment record of a RITM, creating it when needed.
	 * Safe to call several times (portal widget + async business rule).
	 *
	 * @param {String} ritmSysId
	 * @param {Object} [target] { project, environment } sys_ids; read from the RITM variables otherwise
	 * @return {GlideRecord|null}
	 */
	ensureDeploymentForRitm: function(ritmSysId, target) {
		var existing = this._findByRitm(ritmSysId);
		if (existing) {
			return existing;
		}

		var ritm = new GlideRecord('sc_req_item');
		if (!ritm.get(ritmSysId)) {
			return null;
		}
		var item = new GlideRecord(CycloidDeploymentTracker.STACK_TABLE);
		if (!item.get(ritm.getValue('cat_item'))) {
			return null; // not a Cycloid catalog item
		}

		var projectSysId = (target && target.project) || this._variable(ritm, 'cycloid_project');
		var environmentSysId = (target && target.environment) || this._variable(ritm, 'cycloid_environment');
		var t = this._loadTarget(projectSysId, environmentSysId);

		var api = this.api();
		var stackRef = item.getValue('u_cycloid_stack_ref');
		var now = new GlideDateTime().getValue();
		var createUrl = api.createComponentUrl(t.projectCanonical, t.environmentCanonical, stackRef);

		var dep = new GlideRecord(CycloidDeploymentTracker.TABLE);
		dep.initialize();
		dep.setValue('requested_item', ritm.getUniqueValue());
		dep.setValue('requested_for', ritm.getValue('requested_for') || ritm.getValue('opened_by') || gs.getUserID());
		dep.setValue('stack', item.getUniqueValue());
		dep.setValue('stack_ref', stackRef);
		dep.setValue('project', t.projectSysId);
		dep.setValue('environment', t.environmentSysId);
		dep.setValue('project_canonical', t.projectCanonical);
		dep.setValue('environment_canonical', t.environmentCanonical);
		dep.setValue('baseline_components', '[]');
		dep.setValue('status', CycloidDeploymentTracker.STATUS.AWAITING_COMPONENT);
		dep.setValue('status_message', 'Waiting for the component to be created in Cycloid.');
		dep.setValue('create_url', createUrl);
		dep.setValue('requested_at', now);
		dep.setValue('last_checked', now);
		dep.setValue('active', true);
		// Insert first (requested_item is unique) so that the portal and the async
		// business rule cannot both create a record for the same RITM.
		if (!dep.insert()) {
			var concurrent = this._findByRitm(ritmSysId);
			if (!concurrent) {
				CycloidApi.error('Could not create the deployment record for ' + ritm.getValue('number'));
			}
			return concurrent;
		}

		// Snapshot of the components already present, so that only a new one can match.
		var baseline = [];
		try {
			var comps = api.listComponents(t.projectCanonical, t.environmentCanonical);
			for (var i = 0; i < comps.length; i++) {
				baseline.push(comps[i].canonical);
			}
		} catch (e) {
			CycloidApi.warn('Could not list existing components for ' + ritm.getValue('number') + ': ' + e.message);
		}
		dep.setValue('baseline_components', JSON.stringify(baseline));
		dep.update();

		this._updateRitm(ritm, CycloidDeploymentTracker.RITM_STATE.WORK_IN_PROGRESS,
			'Your request is ready to be configured in Cycloid (' + item.getValue('name') + ' in ' +
			t.projectName + ' / ' + t.environmentName + ').',
			createUrl, 'Continue in Cycloid');

		return dep;
	},

	_findByRitm: function(ritmSysId) {
		var dep = new GlideRecord(CycloidDeploymentTracker.TABLE);
		dep.addQuery('requested_item', ritmSysId);
		dep.setLimit(1);
		dep.query();
		return dep.next() ? dep : null;
	},

	_variable: function(ritm, name) {
		try {
			var v = ritm.variables[name];
			return v ? String(v) : '';
		} catch (e) {
			return '';
		}
	},

	_loadTarget: function(projectSysId, environmentSysId) {
		var project = new GlideRecord(CycloidDeploymentTracker.PROJECT_TABLE);
		if (!projectSysId || !project.get(projectSysId)) {
			throw new Error('Please select a Cycloid project.');
		}
		var env = new GlideRecord(CycloidDeploymentTracker.ENVIRONMENT_TABLE);
		if (!environmentSysId || !env.get(environmentSysId)) {
			throw new Error('Please select a Cycloid environment.');
		}
		if (env.getValue('project') !== project.getUniqueValue()) {
			throw new Error('The environment ' + env.getValue('name') + ' does not belong to the project ' +
				project.getValue('name') + '.');
		}
		return {
			projectSysId: project.getUniqueValue(),
			projectCanonical: project.getValue('canonical'),
			projectName: project.getValue('name'),
			environmentSysId: env.getUniqueValue(),
			environmentCanonical: env.getValue('canonical'),
			environmentName: env.getValue('name')
		};
	},

	/* ------------------------------------------------------------------ */
	/* Polling                                                             */
	/* ------------------------------------------------------------------ */

	/** Advances every active deployment. Returns the number of records checked. */
	poll: function() {
		var config = CycloidApi.getConfig();
		if (!config) {
			return 0; // not configured yet: stay silent
		}
		if (!this._api) {
			this._api = new CycloidApi(config);
		}

		var count = 0;
		var dep = new GlideRecord(CycloidDeploymentTracker.TABLE);
		dep.addQuery('active', true);
		dep.orderBy('requested_at');
		dep.query();
		while (dep.next()) {
			count++;
			try {
				this.advance(dep);
			} catch (e) {
				CycloidApi.warn('Deployment ' + dep.getUniqueValue() + ': ' + e.message);
				this._onError(dep, e);
			}
		}
		return count;
	},

	/** Moves one deployment forward. */
	advance: function(dep) {
		var S = CycloidDeploymentTracker.STATUS;
		var nowMs = new GlideDateTime().getNumericValue();
		var config = this.api().config;

		var ritm = new GlideRecord('sc_req_item');
		var hasRitm = ritm.get(dep.getValue('requested_item'));
		if (hasRitm && !CycloidDeploymentTracker.isTrue(ritm.getValue('active'))) {
			this._finish(dep, S.CANCELLED, 'The request was closed in ServiceNow.', null, null);
			return;
		}

		var status = dep.getValue('status');
		if (status === S.AWAITING_COMPONENT) {
			var component = this.findComponent(dep);
			if (component) {
				this._onComponentFound(dep, component, hasRitm ? ritm : null);
				return;
			}
			var waitedMs = nowMs - this._ms(dep, 'requested_at');
			if (waitedMs > config.componentTimeoutHours * 3600 * 1000) {
				this._finish(dep, S.TIMED_OUT,
					'No component was created in Cycloid within ' + config.componentTimeoutHours + ' hours.',
					hasRitm ? ritm : null, CycloidDeploymentTracker.RITM_STATE.CLOSED_INCOMPLETE);
				return;
			}
			this._touch(dep);
			return;
		}

		// Component known: follow its pipeline
		var evaluation = this.evaluatePipeline(dep);
		var previous = status;
		this._applyBuild(dep, evaluation.build);

		if (evaluation.status === S.SUCCEEDED) {
			this._finish(dep, S.SUCCEEDED, evaluation.message, hasRitm ? ritm : null,
				CycloidDeploymentTracker.RITM_STATE.CLOSED_COMPLETE, dep.getValue('build_url') || dep.getValue('component_url'));
			return;
		}

		var watchedMs = nowMs - this._ms(dep, 'component_found_at');
		if (watchedMs > config.monitoringWindowHours * 3600 * 1000) {
			var finalStatus = evaluation.status === S.FAILED ? S.FAILED : S.TIMED_OUT;
			var finalMessage = evaluation.status === S.FAILED ? evaluation.message :
				'The deployment did not complete within ' + config.monitoringWindowHours + ' hours.';
			this._finish(dep, finalStatus, finalMessage, hasRitm ? ritm : null,
				CycloidDeploymentTracker.RITM_STATE.CLOSED_INCOMPLETE, dep.getValue('build_url') || dep.getValue('component_url'));
			return;
		}

		dep.setValue('status', evaluation.status);
		dep.setValue('status_message', evaluation.message);
		this._touch(dep);

		var buildChanged = evaluation.build &&
			String(evaluation.build.id) !== String(dep.getValue('notified_build') || '');
		if (hasRitm && (evaluation.status !== previous || evaluation.status === S.FAILED && buildChanged)) {
			if (evaluation.status === S.RUNNING || evaluation.status === S.FAILED) {
				this._updateRitm(ritm, null, 'Cycloid deployment: ' + evaluation.message,
					dep.getValue('build_url') || dep.getValue('component_url'), 'Open in Cycloid');
				dep.setValue('notified_build', evaluation.build ? String(evaluation.build.id) : '');
				dep.update();
			}
		}
	},

	/**
	 * A check failed (API error). Time limits still apply, and a component that
	 * disappeared from Cycloid ends the tracking.
	 */
	_onError: function(dep, err) {
		var S = CycloidDeploymentTracker.STATUS;
		var config = this.api().config;
		var nowMs = new GlideDateTime().getNumericValue();
		var ritm = new GlideRecord('sc_req_item');
		var r = ritm.get(dep.getValue('requested_item')) ? ritm : null;
		var status = dep.getValue('status');
		var closeIncomplete = CycloidDeploymentTracker.RITM_STATE.CLOSED_INCOMPLETE;

		if (status === S.AWAITING_COMPONENT) {
			if (nowMs - this._ms(dep, 'requested_at') > config.componentTimeoutHours * 3600 * 1000) {
				this._finish(dep, S.TIMED_OUT, 'No component was found in Cycloid within ' +
					config.componentTimeoutHours + ' hours (last error: ' + err.message + ').', r, closeIncomplete);
				return;
			}
		} else {
			if (err.status === 404) {
				this._finish(dep, S.FAILED, 'The component ' + dep.getValue('component_name') +
					' or its pipeline no longer exists in Cycloid.', r, closeIncomplete);
				return;
			}
			if (nowMs - this._ms(dep, 'component_found_at') > config.monitoringWindowHours * 3600 * 1000) {
				this._finish(dep, status === S.FAILED ? S.FAILED : S.TIMED_OUT, 'The deployment did not complete within ' +
					config.monitoringWindowHours + ' hours (last error: ' + err.message + ').', r, closeIncomplete,
					dep.getValue('build_url') || dep.getValue('component_url'));
				return;
			}
		}
		dep.setValue('status_message', String('Last check failed: ' + err.message).substring(0, 1000));
		this._touch(dep);
	},

	/**
	 * Finds the component created for this deployment: same stack, created in
	 * the selected project/environment after the request, not present when the
	 * request was made and not already linked to another deployment.
	 */
	findComponent: function(dep) {
		var project = dep.getValue('project_canonical');
		var env = dep.getValue('environment_canonical');
		var stackRef = dep.getValue('stack_ref');
		var requestedMs = this._ms(dep, 'requested_at');

		var baseline = [];
		try {
			baseline = JSON.parse(dep.getValue('baseline_components') || '[]');
		} catch (e) {
			baseline = [];
		}

		var claimed = {};
		var others = new GlideRecord(CycloidDeploymentTracker.TABLE);
		others.addQuery('project_canonical', project);
		others.addQuery('environment_canonical', env);
		others.addNotNullQuery('component_canonical');
		others.query();
		while (others.next()) {
			if (others.getUniqueValue() !== dep.getUniqueValue()) {
				claimed[others.getValue('component_canonical')] = true;
			}
		}

		var components = this.api().listComponents(project, env);
		var best = null;
		for (var i = 0; i < components.length; i++) {
			var c = components[i];
			var ref = c.service_catalog && c.service_catalog.ref;
			if (ref !== stackRef || claimed[c.canonical] || baseline.indexOf(c.canonical) >= 0) {
				continue;
			}
			var createdMs = CycloidApi.toMillis(c.created_at);
			if (createdMs && createdMs < requestedMs - CycloidDeploymentTracker.CLOCK_SKEW_MS) {
				continue;
			}
			if (!best || createdMs < CycloidApi.toMillis(best.created_at)) {
				best = c;
			}
		}
		return best;
	},

	/**
	 * Reads the component pipeline(s) and derives a deployment status.
	 * @return {Object} { status, message, build: { id, name, status, job, pipeline } | null }
	 */
	evaluatePipeline: function(dep) {
		var S = CycloidDeploymentTracker.STATUS;
		var api = this.api();
		var project = dep.getValue('project_canonical');
		var env = dep.getValue('environment_canonical');
		var component = dep.getValue('component_canonical');
		var sinceMs = this._ms(dep, 'requested_at') - CycloidDeploymentTracker.CLOCK_SKEW_MS;

		var pipelines = api.listComponentPipelines(project, env, component);
		var jobs = [];
		for (var i = 0; i < pipelines.length; i++) {
			var pName = pipelines[i].name;
			var pJobs = api.listPipelineJobs(project, env, component, pName);
			for (var j = 0; j < pJobs.length; j++) {
				pJobs[j]._pipeline = pName;
				jobs.push(pJobs[j]);
			}
		}

		if (!jobs.length) {
			return { status: S.WAITING_PIPELINE, message: 'Waiting for the pipeline to be created.', build: null };
		}

		var target = this._targetJob(jobs, api.config.deployJobPattern);
		var buildEnd = function(b) {
			return CycloidApi.toMillis(b.end_time) || CycloidApi.toMillis(b.start_time);
		};
		var describe = function(job, build) {
			return {
				id: build.id,
				name: build.name,
				status: build.status,
				job: job.name,
				pipeline: job._pipeline
			};
		};

		// 1. Deployment job succeeded since the request
		if (target.finished_build && target.finished_build.status === 'succeeded' &&
			buildEnd(target.finished_build) >= sinceMs) {
			return {
				status: S.SUCCEEDED,
				message: 'Job ' + target.name + ' succeeded (build #' + target.finished_build.name + ').',
				build: describe(target, target.finished_build)
			};
		}

		// 2. Something is running
		for (var r = 0; r < jobs.length; r++) {
			var nb = jobs[r].next_build;
			if (nb && CycloidDeploymentTracker.BUILD_RUNNING.indexOf(nb.status) >= 0) {
				return {
					status: S.RUNNING,
					message: 'Job ' + jobs[r].name + ' is ' + (nb.status === 'pending' ? 'pending' : 'running') +
						' (build #' + nb.name + ').',
					build: describe(jobs[r], nb)
				};
			}
		}

		// 3. Most recent failure since the request
		var failedJob = null;
		for (var f = 0; f < jobs.length; f++) {
			var fb = jobs[f].finished_build;
			if (fb && CycloidDeploymentTracker.BUILD_FAILED.indexOf(fb.status) >= 0 && buildEnd(fb) >= sinceMs) {
				if (!failedJob || buildEnd(fb) > buildEnd(failedJob.finished_build)) {
					failedJob = jobs[f];
				}
			}
		}
		if (failedJob) {
			return {
				status: S.FAILED,
				message: 'Job ' + failedJob.name + ' ' + failedJob.finished_build.status +
					' (build #' + failedJob.finished_build.name + ').',
				build: describe(failedJob, failedJob.finished_build)
			};
		}

		return {
			status: S.WAITING_PIPELINE,
			message: 'Pipeline ready, waiting for job ' + target.name + ' to run.',
			build: null
		};
	},

	/** First job whose name matches the pattern, otherwise the last job of the pipeline. */
	_targetJob: function(jobs, pattern) {
		var re = null;
		try {
			re = pattern ? new RegExp(pattern, 'i') : null;
		} catch (e) {
			re = null;
		}
		if (re) {
			for (var i = 0; i < jobs.length; i++) {
				if (re.test(jobs[i].name)) {
					return jobs[i];
				}
			}
		}
		return jobs[jobs.length - 1];
	},

	/* ------------------------------------------------------------------ */
	/* Helpers                                                             */
	/* ------------------------------------------------------------------ */

	_onComponentFound: function(dep, component, ritm) {
		var api = this.api();
		var project = dep.getValue('project_canonical');
		var env = dep.getValue('environment_canonical');
		var url = api.componentUrl(project, env, component.canonical);

		dep.setValue('component_canonical', component.canonical);
		dep.setValue('component_name', component.name || component.canonical);
		dep.setValue('component_url', url);
		dep.setValue('component_found_at', new GlideDateTime().getValue());
		dep.setValue('status', CycloidDeploymentTracker.STATUS.WAITING_PIPELINE);
		dep.setValue('status_message', 'Component ' + (component.name || component.canonical) + ' created in Cycloid.');
		this._touch(dep);

		if (ritm) {
			this._updateRitm(ritm, null, 'Component "' + (component.name || component.canonical) +
				'" was created in Cycloid. The deployment status will be reported here.', url, 'Open component');
		}
	},

	_applyBuild: function(dep, build) {
		if (!build) {
			return;
		}
		dep.setValue('pipeline_name', build.pipeline);
		dep.setValue('job_name', build.job);
		dep.setValue('build_id', String(build.id));
		dep.setValue('build_name', String(build.name));
		dep.setValue('build_status', build.status);
		dep.setValue('build_url', this.api().buildUrl(dep.getValue('project_canonical'), dep.getValue('environment_canonical'),
			dep.getValue('component_canonical'), build.pipeline, build.job, build.name));
	},

	_finish: function(dep, status, message, ritm, ritmState, link) {
		dep.setValue('status', status);
		dep.setValue('status_message', message);
		dep.setValue('active', false);
		dep.setValue('finished_at', new GlideDateTime().getValue());
		this._touch(dep);
		if (ritm && ritmState) {
			this._updateRitm(ritm, ritmState, 'Cycloid deployment ' + status.toLowerCase() + ': ' + message,
				link || null, 'Open in Cycloid');
		}
	},

	_touch: function(dep) {
		dep.setValue('last_checked', new GlideDateTime().getValue());
		dep.update();
	},

	_ms: function(gr, field) {
		var v = gr.getValue(field);
		return v ? new GlideDateTime(v).getNumericValue() : new GlideDateTime().getNumericValue();
	},

	/** Adds a customer visible comment (with an optional link) and optionally changes the state. */
	_updateRitm: function(ritm, state, text, url, linkLabel) {
		var comment = text;
		if (url) {
			comment = '[code]<p>' + this._escape(text) + '</p><p><a href="' + this._escape(url) +
				'" target="_blank" rel="noopener">' + this._escape(linkLabel || url) + '</a></p>[/code]';
		}
		ritm.comments = comment;
		if (state) {
			ritm.setValue('state', state);
		}
		if (!ritm.update()) {
			CycloidApi.warn('Could not update ' + ritm.getValue('number'));
		}
	},

	_escape: function(s) {
		return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	},

	type: 'CycloidDeploymentTracker'
};
