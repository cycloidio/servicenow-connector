/**
 * CycloidApi
 *
 * Thin client for the Cycloid HTTP API plus helpers to build Cycloid console
 * deep links. Every outbound call made by the connector goes through this
 * class.
 *
 * Usage:
 *   var api = new x_1829062_cycloi_1.CycloidApi();          // reads the config record
 *   var stacks = api.listStacks();
 *   var url = api.createComponentUrl('my-project', 'staging', 'my-org:stack-aws-vm');
 *
 * Notes:
 *   - The API base URL has no version suffix (e.g. https://api.us.cycloid.io).
 *   - The API key is sent as a Bearer token and is never written to the logs.
 *   - List endpoints are paginated with page_index / page_size.
 */
var CycloidApi = Class.create();

CycloidApi.SCOPE = 'x_1829062_cycloi_1';
CycloidApi.CONFIG_TABLE = 'x_1829062_cycloi_1_cycloid_config';
CycloidApi.LOG_PREFIX = '[Cycloid] ';
CycloidApi.PAGE_SIZE = 100;
CycloidApi.MAX_PAGES = 100;
CycloidApi.HTTP_TIMEOUT_MS = 30000;

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

CycloidApi.info = function(msg) {
	gs.info(CycloidApi.LOG_PREFIX + msg);
};
CycloidApi.warn = function(msg) {
	gs.warn(CycloidApi.LOG_PREFIX + msg);
};
CycloidApi.error = function(msg) {
	gs.error(CycloidApi.LOG_PREFIX + msg);
};

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

CycloidApi._trimSlash = function(url) {
	return String(url || '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
};

CycloidApi._int = function(value, fallback) {
	var n = parseInt(value, 10);
	return isNaN(n) || n <= 0 ? fallback : n;
};

/**
 * Returns the connector configuration as a plain object, or null when no
 * usable configuration record exists. The first record (oldest) wins.
 */
CycloidApi.getConfig = function() {
	var gr = new GlideRecord(CycloidApi.CONFIG_TABLE);
	gr.orderBy('sys_created_on');
	gr.setLimit(1);
	gr.query();
	if (!gr.next()) {
		return null;
	}

	var apiUrl = CycloidApi._trimSlash(gr.getValue('api_url'));
	// The Cycloid API is not versioned in the path: tolerate a trailing /v1.
	apiUrl = apiUrl.replace(/\/v1$/i, '');

	var config = {
		sysId: gr.getUniqueValue(),
		apiUrl: apiUrl,
		consoleUrl: CycloidApi._trimSlash(gr.getValue('console_url')),
		org: String(gr.getValue('organization_canonical') || '').replace(/^\s+|\s+$/g, ''),
		apiKey: String(gr.getValue('api_key') || '').replace(/^\s+|\s+$/g, ''),
		catalogCategory: String(gr.getValue('catalog_category') || '').replace(/^\s+|\s+$/g, ''),
		componentTimeoutHours: CycloidApi._int(gr.getValue('component_timeout_hours'), 24),
		monitoringWindowHours: CycloidApi._int(gr.getValue('monitoring_window_hours'), 24),
		deployJobPattern: String(gr.getValue('deploy_job_pattern') || 'apply|deploy')
	};

	if (!config.apiUrl || !config.consoleUrl || !config.org || !config.apiKey) {
		return null;
	}
	return config;
};

/* ------------------------------------------------------------------ */
/* Instance methods                                                    */
/* ------------------------------------------------------------------ */

CycloidApi.prototype = {

	/**
	 * @param {Object} [config] configuration object (see CycloidApi.getConfig)
	 */
	initialize: function(config) {
		this.config = config || CycloidApi.getConfig();
		if (!this.config) {
			throw new Error('Cycloid configuration is missing or incomplete. ' +
				'Fill in api_url, console_url, organization_canonical and api_key in the Cycloid Configuration table.');
		}
	},

	/* ---------------- low level ---------------- */

	_path: function(segments) {
		var parts = [];
		for (var i = 0; i < segments.length; i++) {
			parts.push(encodeURIComponent(String(segments[i])));
		}
		return '/' + parts.join('/');
	},

	_query: function(query) {
		if (!query) {
			return '';
		}
		var parts = [];
		for (var key in query) {
			if (query.hasOwnProperty(key) && query[key] !== undefined && query[key] !== null && query[key] !== '') {
				parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(query[key])));
			}
		}
		return parts.length ? '?' + parts.join('&') : '';
	},

	/**
	 * Executes a request and returns the parsed JSON body.
	 * Throws an Error (with .status) on transport errors and non-2xx answers.
	 */
	request: function(method, segments, query) {
		var endpoint = this.config.apiUrl + this._path(segments) + this._query(query);

		var rm = new sn_ws.RESTMessageV2();
		rm.setHttpMethod(method);
		rm.setEndpoint(endpoint);
		rm.setRequestHeader('Accept', 'application/json');
		rm.setRequestHeader('Content-Type', 'application/json');
		rm.setRequestHeader('Authorization', 'Bearer ' + this.config.apiKey);
		rm.setHttpTimeout(CycloidApi.HTTP_TIMEOUT_MS);

		var response = rm.execute();
		var status = response.getStatusCode();
		var body = response.getBody();

		if (response.haveError && response.haveError() && !status) {
			var transportError = new Error('Cycloid API unreachable (' + method.toUpperCase() + ' ' + endpoint + '): ' +
				response.getErrorMessage());
			transportError.status = 0;
			throw transportError;
		}

		if (status < 200 || status >= 300) {
			var detail = this._errorDetail(body);
			var err = new Error('Cycloid API returned HTTP ' + status + ' for ' + method.toUpperCase() + ' ' +
				endpoint + (detail ? ': ' + detail : ''));
			err.status = status;
			throw err;
		}

		if (!body) {
			return {};
		}
		try {
			return JSON.parse(body);
		} catch (e) {
			var parseError = new Error('Cycloid API returned a non JSON answer for ' + endpoint);
			parseError.status = status;
			throw parseError;
		}
	},

	_errorDetail: function(body) {
		try {
			var json = JSON.parse(body);
			if (json && json.errors && json.errors.length) {
				var msgs = [];
				for (var i = 0; i < json.errors.length; i++) {
					msgs.push((json.errors[i].code || '') + ' ' + (json.errors[i].message || ''));
				}
				return msgs.join('; ');
			}
		} catch (e) {
			// ignore, fall back to raw body
		}
		return String(body || '').substring(0, 300);
	},

	/** GET returning the unwrapped "data" field. */
	get: function(segments, query) {
		var json = this.request('get', segments, query);
		return json && json.hasOwnProperty('data') ? json.data : json;
	},

	/** GET over every page of a list endpoint, returns a flat array. */
	list: function(segments, query) {
		var all = [];
		for (var page = 1; page <= CycloidApi.MAX_PAGES; page++) {
			var q = {};
			for (var k in (query || {})) {
				if (query.hasOwnProperty(k)) {
					q[k] = query[k];
				}
			}
			q.page_index = page;
			q.page_size = CycloidApi.PAGE_SIZE;

			var json = this.request('get', segments, q);
			var data = json && json.data;
			if (!data || !data.length) {
				break;
			}
			for (var i = 0; i < data.length; i++) {
				all.push(data[i]);
			}
			var total = json.pagination && json.pagination.total;
			if (!total || all.length >= total || data.length < CycloidApi.PAGE_SIZE) {
				break;
			}
		}
		return all;
	},

	/* ---------------- resources ---------------- */

	org: function() {
		return this.config.org;
	},

	/** All stacks of the organization (blueprints included, caller filters). */
	listStacks: function() {
		return this.list(['organizations', this.org(), 'service_catalogs']);
	},

	listProjects: function() {
		return this.list(['organizations', this.org(), 'projects']);
	},

	listProjectEnvironments: function(project) {
		return this.list(['organizations', this.org(), 'projects', project, 'environments']);
	},

	listComponents: function(project, env) {
		return this.list(['organizations', this.org(), 'projects', project, 'environments', env, 'components']);
	},

	listComponentPipelines: function(project, env, component) {
		return this.list(['organizations', this.org(), 'projects', project, 'environments', env,
			'components', component, 'pipelines']);
	},

	listPipelineJobs: function(project, env, component, pipeline) {
		var data = this.get(['organizations', this.org(), 'projects', project, 'environments', env,
			'components', component, 'pipelines', pipeline, 'jobs']);
		return data || [];
	},

	/* ---------------- console deep links ---------------- */

	_consoleProjectEnvBase: function(project, env) {
		return this.config.consoleUrl + this._path(['organizations', this.org(), 'projects', project, 'environments', env]);
	},

	/**
	 * Console page to create a component in a project/environment. The stack
	 * list on that page is pre-filtered on the stack canonical.
	 */
	createComponentUrl: function(project, env, stackRef) {
		return this._consoleProjectEnvBase(project, env) + '/components/create' +
			this._query({ canonical: CycloidApi.stackCanonical(stackRef) });
	},

	componentUrl: function(project, env, component) {
		return this._consoleProjectEnvBase(project, env) + this._path(['components', component]);
	},

	buildUrl: function(project, env, component, pipeline, job, buildName) {
		return this._consoleProjectEnvBase(project, env) +
			this._path(['components', component, 'pipelines', pipeline, 'jobs', job, 'builds', buildName]);
	},

	stackUrl: function(stackRef) {
		return this.config.consoleUrl + this._path(['organizations', this.org(), 'stacks', stackRef]);
	},

	type: 'CycloidApi'
};

/** "my-org:stack-aws-vm" -> "stack-aws-vm" */
CycloidApi.stackCanonical = function(stackRef) {
	var ref = String(stackRef || '');
	var idx = ref.lastIndexOf(':');
	return idx >= 0 ? ref.substring(idx + 1) : ref;
};

/** Cycloid timestamps are Unix seconds; tolerate milliseconds. Returns ms. */
CycloidApi.toMillis = function(ts) {
	var n = Number(ts || 0);
	if (!n) {
		return 0;
	}
	return n < 100000000000 ? n * 1000 : n;
};
