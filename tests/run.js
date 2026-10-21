/*
 * End-to-end tests of the connector logic against in-memory ServiceNow and
 * Cycloid fakes.
 *
 *   node tests/run.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { createEnvironment } = require('./glide-mock');
const { createCycloid } = require('./cycloid-mock');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'servicenow', 'src');

const T = {
	config: 'x_1829062_cycloi_1_cycloid_config',
	stack: 'x_1829062_cycloi_1_cycloid_stack',
	project: 'x_1829062_cycloi_1_cycloid_project',
	env: 'x_1829062_cycloi_1_cycloid_environment',
	deployment: 'x_1829062_cycloi_1_cycloid_deployment'
};
const VARIABLE_SET = 'a0000000000000000000000000000001';
const CATEGORY = 'c0000000000000000000000000000001';
const CATALOG = 'e0d08b13c3330100c8b837659bba8fb4';
const API_KEY = 'super-secret-api-key';
const HOUR = 3600 * 1000;

let passed = 0;
const failures = [];

function test(name, fn) {
	try {
		fn();
		passed++;
		console.log('  ok   ' + name);
	} catch (e) {
		failures.push(name);
		console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       '));
	}
}

function setup() {
	const sn = createEnvironment();
	sn.displayFields = {
		sc_req_item: 'number', sc_request: 'number', sys_user: 'name',
		[T.stack]: 'name', [T.project]: 'name', [T.env]: 'name'
	};
	sn.references = {
		[T.deployment]: { requested_item: 'sc_req_item', stack: T.stack, project: T.project, environment: T.env },
		[T.env]: { project: T.project }
	};
	sn.unique = { [T.deployment]: ['requested_item'] };
	const cy = createCycloid({ apiUrl: 'https://api.us.cycloid.io', apiKey: API_KEY, org: 'acme' });
	sn.http = cy.handler;

	sn.insert('sc_category', { sys_id: CATEGORY, title: 'Cloud services', sc_catalog: CATALOG });
	sn.insert(T.config, {
		organization_canonical: 'acme',
		api_url: 'https://api.us.cycloid.io/v1/', // tolerated: trailing /v1 and slash
		console_url: 'https://console.us.cycloid.io/',
		api_key: API_KEY,
		catalog_category: CATEGORY,
		component_timeout_hours: '24',
		monitoring_window_hours: '24',
		deploy_job_pattern: 'apply|deploy'
	});

	cy.stacks = [
		{ ref: 'acme:stack-aws-vm', canonical: 'stack-aws-vm', name: 'AWS virtual machine', description: 'An EC2 instance',
			image: 'https://img.example.com/aws-vm.png', keywords: ['aws', 'vm'], cloud_providers: [{ canonical: 'aws', name: 'AWS' }] },
		{ ref: 'acme:stack-k8s-app', canonical: 'stack-k8s-app', name: 'Kubernetes app', description: 'A Helm release',
			image: '', keywords: [] },
		{ ref: 'cycloid:blueprint-aws', canonical: 'blueprint-aws', name: 'AWS blueprint', blueprint: true },
		{ ref: 'acme:stack-hidden', canonical: 'stack-hidden', name: 'Hidden stack', visibility: 'hidden' }
	];
	cy.images['https://img.example.com/aws-vm.png'] = true;
	cy.projects = [
		{ canonical: 'webshop', name: 'Web shop', environments: [{ canonical: 'staging', name: 'Staging' }, { canonical: 'prod', name: 'Production' }] },
		{ canonical: 'data', name: 'Data platform', environments: [{ canonical: 'dev', name: '' }] }
	];

	const scope = sn.loadScriptIncludes(path.join(SRC, 'script_includes'),
		['CycloidApi', 'CycloidSync', 'CycloidDeploymentTracker', 'CycloidIntegration'],
		{ '@@VARIABLE_SET_SYS_ID@@': VARIABLE_SET });
	return { sn: sn, cy: cy, scope: scope };
}

function sync(ctx) {
	sn(ctx).run(path.join(SRC, 'scheduled_jobs', 'sync_catalog.js'));
}

function poll(ctx) {
	sn(ctx).run(path.join(SRC, 'scheduled_jobs', 'track_deployments.js'));
}

function sn(ctx) {
	return ctx.sn;
}

function byField(ctx, table, field, value) {
	return ctx.sn.find(table, function(r) {
		return r[field] === value;
	})[0];
}

function widgetServer(ctx, widgetId, input, options) {
	const data = {};
	ctx.sn.run(path.join(SRC, 'widgets', widgetId, 'server_script.js'),
		{ data: data, input: input, options: options || {}, $sp: {} });
	return data;
}

function order(ctx, stackRef, projectCanonical, envCanonical) {
	const stack = byField(ctx, T.stack, 'u_cycloid_stack_ref', stackRef);
	const project = byField(ctx, T.project, 'canonical', projectCanonical);
	const env = ctx.sn.find(T.env, function(r) {
		return r.canonical === envCanonical && r.project === project.sys_id;
	})[0];
	return widgetServer(ctx, 'cycloid_catalog', {
		action: 'deploy', stack: stack.sys_id, project: project.sys_id, environment: env.sys_id
	});
}

function deploymentOf(ctx, ritmSysId) {
	return byField(ctx, T.deployment, 'requested_item', ritmSysId);
}

function ritm(ctx, sysId) {
	return byField(ctx, 'sc_req_item', 'sys_id', sysId);
}

function lastComment(row) {
	const c = row.__comments || [];
	return c[c.length - 1] || '';
}

function job(name, finished, next) {
	return { name: name, finished_build: finished || null, next_build: next || null };
}

function build(id, status, endSec) {
	return { id: id, name: String(id), status: status, start_time: endSec - 60, end_time: endSec };
}

console.log('Cycloid connector v2 - logic tests');

/* ---------------------------------------------------------------------- */
test('configuration is normalised', function() {
	const ctx = setup();
	const config = ctx.scope.CycloidApi.getConfig();
	assert.strictEqual(config.apiUrl, 'https://api.us.cycloid.io');
	assert.strictEqual(config.consoleUrl, 'https://console.us.cycloid.io');
	assert.strictEqual(config.componentTimeoutHours, 24);
});

test('console deep links', function() {
	const ctx = setup();
	const api = new ctx.scope.CycloidApi();
	assert.strictEqual(api.createComponentUrl('webshop', 'staging', 'acme:stack-aws-vm'),
		'https://console.us.cycloid.io/organizations/acme/projects/webshop/environments/staging/components/create?canonical=stack-aws-vm');
	assert.strictEqual(api.buildUrl('webshop', 'staging', 'vm-1', 'webshop-staging', 'terraform-apply', '3'),
		'https://console.us.cycloid.io/organizations/acme/projects/webshop/environments/staging/components/vm-1/pipelines/webshop-staging/jobs/terraform-apply/builds/3');
});

test('sync publishes stacks as catalog items, projects and environments', function() {
	const ctx = setup();
	sync(ctx);
	const items = ctx.sn.find(T.stack);
	assert.strictEqual(items.length, 2, 'blueprints and hidden stacks are skipped');
	const vm = byField(ctx, T.stack, 'u_cycloid_stack_ref', 'acme:stack-aws-vm');
	assert.strictEqual(vm.name, 'AWS virtual machine');
	assert.strictEqual(vm.category, CATEGORY);
	assert.strictEqual(vm.sc_catalogs, CATALOG);
	assert.strictEqual(vm.active, '1');
	assert.strictEqual(vm.stack_canonical, 'stack-aws-vm');
	assert.ok(vm.picture, 'picture attachment set');
	const att = byField(ctx, 'sys_attachment', 'sys_id', vm.picture);
	assert.strictEqual(att.table_name, 'ZZ_YY' + T.stack);
	assert.strictEqual(att.file_name, 'picture');
	assert.strictEqual(ctx.sn.find('io_set_item').length, 2, 'variable set attached to each item');
	assert.ok(ctx.sn.find('io_set_item').every(function(l) {
		return l.variable_set === VARIABLE_SET;
	}));
	assert.strictEqual(ctx.sn.find(T.project).length, 2);
	assert.strictEqual(ctx.sn.find(T.env).length, 3);
	const dev = byField(ctx, T.env, 'canonical', 'dev');
	assert.strictEqual(dev.name, 'dev', 'empty environment name falls back to canonical');
});

test('re-sync is idempotent and deactivates what disappeared', function() {
	const ctx = setup();
	sync(ctx);
	const pictureBefore = byField(ctx, T.stack, 'u_cycloid_stack_ref', 'acme:stack-aws-vm').picture;
	const imageCalls = ctx.cy.calls.filter(function(c) {
		return c.indexOf('img.example.com') >= 0;
	}).length;
	ctx.cy.stacks = ctx.cy.stacks.filter(function(s) {
		return s.ref !== 'acme:stack-k8s-app';
	});
	ctx.cy.projects[0].environments.pop();
	sync(ctx);
	assert.strictEqual(ctx.sn.find(T.stack).length, 2);
	assert.strictEqual(byField(ctx, T.stack, 'u_cycloid_stack_ref', 'acme:stack-k8s-app').active, '0');
	assert.strictEqual(byField(ctx, T.env, 'canonical', 'prod').active, '0');
	assert.strictEqual(ctx.sn.find('io_set_item').length, 2, 'no duplicate variable set links');
	assert.strictEqual(byField(ctx, T.stack, 'u_cycloid_stack_ref', 'acme:stack-aws-vm').picture, pictureBefore);
	assert.strictEqual(ctx.cy.calls.filter(function(c) {
		return c.indexOf('img.example.com') >= 0;
	}).length, imageCalls, 'unchanged image is not downloaded again');
});

test('pagination walks every page', function() {
	const ctx = setup();
	for (let i = 0; i < 230; i++) {
		ctx.cy.stacks.push({ ref: 'acme:s' + i, canonical: 's' + i, name: 'Stack ' + i });
	}
	const stacks = new ctx.scope.CycloidApi().listStacks();
	assert.strictEqual(stacks.length, 234);
});

test('catalog widget lists services, projects and environments', function() {
	const ctx = setup();
	sync(ctx);
	const data = widgetServer(ctx, 'cycloid_catalog', null);
	assert.strictEqual(data.configured, true);
	assert.strictEqual(data.items.length, 2);
	assert.ok(data.items[0].picture === '' || /^\/[0-9a-f]{32}\.iix$/.test(data.items[0].picture));
	assert.strictEqual(data.projects.length, 2);
	assert.strictEqual(data.environments.length, 3);
});

test('ordering creates the request, the deployment and the console link', function() {
	const ctx = setup();
	sync(ctx);
	ctx.cy.addComponent('webshop', 'staging', { canonical: 'old-vm', name: 'Old VM',
		service_catalog: { ref: 'acme:stack-aws-vm' }, created_at: 1700000000 });
	const data = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging');
	assert.ok(!data.result.error, data.result.error);
	assert.strictEqual(data.result.create_url,
		'https://console.us.cycloid.io/organizations/acme/projects/webshop/environments/staging/components/create?canonical=stack-aws-vm');
	assert.ok(/^RITM/.test(data.result.ritm_number));
	const r = ritm(ctx, data.result.ritm_sys_id);
	assert.strictEqual(r.state, '2');
	assert.ok(lastComment(r).indexOf('Continue in Cycloid') >= 0);
	const d = deploymentOf(ctx, r.sys_id);
	assert.strictEqual(d.status, 'Awaiting component');
	assert.strictEqual(d.requested_for, ctx.sn.userId);
	assert.deepStrictEqual(JSON.parse(d.baseline_components), ['old-vm']);
});

test('the business rule does not create a second deployment', function() {
	const ctx = setup();
	sync(ctx);
	const data = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging');
	const current = ctx.sn.GlideRecord('sc_req_item');
	current.get(data.result.ritm_sys_id);
	ctx.sn.run(path.join(SRC, 'business_rules', 'create_cycloid_deployment.js'), { current: current, previous: null });
	assert.strictEqual(ctx.sn.find(T.deployment).length, 1);
});

test('the business rule handles orders from the standard catalog', function() {
	const ctx = setup();
	sync(ctx);
	const stack = byField(ctx, T.stack, 'u_cycloid_stack_ref', 'acme:stack-k8s-app');
	const project = byField(ctx, T.project, 'canonical', 'data');
	const env = byField(ctx, T.env, 'canonical', 'dev');
	const cart = new ctx.sn.context.sn_sc.CartJS();
	cart.orderNow({ sysparm_id: stack.sys_id, variables: { cycloid_project: project.sys_id, cycloid_environment: env.sys_id } });
	const current = ctx.sn.GlideRecord('sc_req_item');
	current.get(ctx.sn.lastOrder.ritmId);
	ctx.sn.run(path.join(SRC, 'business_rules', 'create_cycloid_deployment.js'), { current: current, previous: null });
	const d = deploymentOf(ctx, ctx.sn.lastOrder.ritmId);
	assert.ok(d, 'deployment created');
	assert.strictEqual(d.project_canonical, 'data');
	assert.strictEqual(d.create_url,
		'https://console.us.cycloid.io/organizations/acme/projects/data/environments/dev/components/create?canonical=stack-k8s-app');
});

test('a concurrent creation for the same RITM returns the existing record', function() {
	const ctx = setup();
	sync(ctx);
	const res = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	const tracker = new ctx.scope.CycloidDeploymentTracker();
	const realFind = tracker._findByRitm;
	let calls = 0;
	tracker._findByRitm = function(id) {
		calls++;
		return calls === 1 ? null : realFind.call(this, id); // first check misses (race)
	};
	const dep = tracker.ensureDeploymentForRitm(res.ritm_sys_id);
	assert.ok(dep, 'existing record returned');
	assert.strictEqual(dep.getUniqueValue(), res.deployment_sys_id);
	assert.strictEqual(ctx.sn.find(T.deployment).length, 1);
});

test('ordering fails before creating a request when the connector is not configured', function() {
	const ctx = setup();
	sync(ctx);
	const stack = byField(ctx, T.stack, 'u_cycloid_stack_ref', 'acme:stack-aws-vm');
	const project = byField(ctx, T.project, 'canonical', 'webshop');
	const env = byField(ctx, T.env, 'canonical', 'staging');
	ctx.sn.db[T.config] = [];
	const data = widgetServer(ctx, 'cycloid_catalog', { action: 'deploy', stack: stack.sys_id, project: project.sys_id, environment: env.sys_id });
	assert.ok(/configuration is missing/.test(data.result.error), data.result.error);
	assert.strictEqual(ctx.sn.find('sc_req_item').length, 0);
});

test('a component deleted in Cycloid ends the tracking', function() {
	const ctx = setup();
	sync(ctx);
	const res = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	const sec = Math.floor(ctx.sn.clock.now / 1000);
	ctx.cy.addComponent('webshop', 'staging', { canonical: 'vm-1', service_catalog: { ref: 'acme:stack-aws-vm' }, created_at: sec + 5 });
	poll(ctx);
	assert.strictEqual(deploymentOf(ctx, res.ritm_sys_id).status, 'Waiting for pipeline');
	ctx.cy.projects[0].canonical = 'renamed'; // project gone -> 404
	poll(ctx);
	const d = deploymentOf(ctx, res.ritm_sys_id);
	assert.strictEqual(d.status, 'Failed');
	assert.strictEqual(d.active, '0');
	assert.strictEqual(ritm(ctx, res.ritm_sys_id).state, '4');
});

test('time limits still apply while the API is failing', function() {
	const ctx = setup();
	sync(ctx);
	const res = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	ctx.cy.down = true;
	poll(ctx);
	assert.strictEqual(deploymentOf(ctx, res.ritm_sys_id).active, '1');
	ctx.sn.advance(25 * HOUR);
	poll(ctx);
	const d = deploymentOf(ctx, res.ritm_sys_id);
	assert.strictEqual(d.status, 'Timed out');
	assert.strictEqual(d.active, '0');
	assert.strictEqual(ritm(ctx, res.ritm_sys_id).state, '4');
});

test('build ids returned as strings do not repeat failure comments', function() {
	const ctx = setup();
	sync(ctx);
	const res = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	const sec = Math.floor(ctx.sn.clock.now / 1000);
	ctx.cy.addComponent('webshop', 'staging', { canonical: 'vm-1', service_catalog: { ref: 'acme:stack-aws-vm' }, created_at: sec + 5 });
	poll(ctx);
	ctx.cy.setPipeline('webshop', 'staging', 'vm-1', [{ name: 'p', jobs: [job('deploy', { id: '77', name: '2', status: 'failed', end_time: sec + 50 })] }]);
	poll(ctx);
	const n = (ritm(ctx, res.ritm_sys_id).__comments || []).length;
	poll(ctx);
	poll(ctx);
	assert.strictEqual((ritm(ctx, res.ritm_sys_id).__comments || []).length, n);
});

test('an environment from another project is rejected', function() {
	const ctx = setup();
	sync(ctx);
	const stack = byField(ctx, T.stack, 'u_cycloid_stack_ref', 'acme:stack-aws-vm');
	const project = byField(ctx, T.project, 'canonical', 'webshop');
	const env = byField(ctx, T.env, 'canonical', 'dev');
	const data = widgetServer(ctx, 'cycloid_catalog', {
		action: 'deploy', stack: stack.sys_id, project: project.sys_id, environment: env.sys_id
	});
	assert.ok(/does not belong/.test(data.result.error));
	assert.strictEqual(ctx.sn.find('sc_req_item').length, 0, 'nothing ordered');
});

test('full life cycle: component, running, failed, re-run, succeeded', function() {
	const ctx = setup();
	sync(ctx);
	ctx.cy.addComponent('webshop', 'staging', { canonical: 'old-vm', service_catalog: { ref: 'acme:stack-aws-vm' }, created_at: 1700000000 });
	const res = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	const nowSec = function() {
		return Math.floor(ctx.sn.clock.now / 1000);
	};

	poll(ctx);
	assert.strictEqual(deploymentOf(ctx, res.ritm_sys_id).status, 'Awaiting component');

	// Another stack in the same env and a component for another env must not match
	ctx.sn.advance(5 * 60 * 1000);
	ctx.cy.addComponent('webshop', 'staging', { canonical: 'k8s-x', service_catalog: { ref: 'acme:stack-k8s-app' }, created_at: nowSec() });
	ctx.cy.addComponent('webshop', 'prod', { canonical: 'vm-prod', service_catalog: { ref: 'acme:stack-aws-vm' }, created_at: nowSec() });
	poll(ctx);
	assert.strictEqual(deploymentOf(ctx, res.ritm_sys_id).status, 'Awaiting component');

	// The user creates the component in Cycloid
	ctx.cy.addComponent('webshop', 'staging', { canonical: 'shop-vm', name: 'Shop VM', service_catalog: { ref: 'acme:stack-aws-vm' }, created_at: nowSec() });
	poll(ctx);
	let d = deploymentOf(ctx, res.ritm_sys_id);
	assert.strictEqual(d.status, 'Waiting for pipeline');
	assert.strictEqual(d.component_canonical, 'shop-vm');
	assert.strictEqual(d.component_url, 'https://console.us.cycloid.io/organizations/acme/projects/webshop/environments/staging/components/shop-vm');
	assert.ok(lastComment(ritm(ctx, res.ritm_sys_id)).indexOf('Shop VM') >= 0);

	// Pipeline exists, nothing ran
	ctx.cy.setPipeline('webshop', 'staging', 'shop-vm', [{ name: 'webshop-staging', jobs: [job('terraform-plan'), job('terraform-apply')] }]);
	poll(ctx);
	d = deploymentOf(ctx, res.ritm_sys_id);
	assert.strictEqual(d.status, 'Waiting for pipeline');
	assert.ok(/terraform-apply/.test(d.status_message));

	// Plan done, apply running
	ctx.sn.advance(60 * 1000);
	ctx.cy.setPipeline('webshop', 'staging', 'shop-vm', [{ name: 'webshop-staging', jobs: [
		job('terraform-plan', build(11, 'succeeded', nowSec())),
		job('terraform-apply', null, { id: 12, name: '1', status: 'started' })
	] }]);
	poll(ctx);
	d = deploymentOf(ctx, res.ritm_sys_id);
	assert.strictEqual(d.status, 'Running');
	assert.strictEqual(d.job_name, 'terraform-apply');
	assert.strictEqual(d.build_url, 'https://console.us.cycloid.io/organizations/acme/projects/webshop/environments/staging/components/shop-vm/pipelines/webshop-staging/jobs/terraform-apply/builds/1');
	const commentsAfterRunning = (ritm(ctx, res.ritm_sys_id).__comments || []).length;
	poll(ctx);
	assert.strictEqual((ritm(ctx, res.ritm_sys_id).__comments || []).length, commentsAfterRunning, 'no duplicate comment');

	// Apply fails: request stays open
	ctx.sn.advance(60 * 1000);
	ctx.cy.setPipeline('webshop', 'staging', 'shop-vm', [{ name: 'webshop-staging', jobs: [
		job('terraform-plan', build(11, 'succeeded', nowSec() - 60)),
		job('terraform-apply', build(12, 'failed', nowSec()))
	] }]);
	poll(ctx);
	d = deploymentOf(ctx, res.ritm_sys_id);
	assert.strictEqual(d.status, 'Failed');
	assert.strictEqual(d.active, '1');
	assert.strictEqual(ritm(ctx, res.ritm_sys_id).state, '2');
	assert.ok(/failed/.test(lastComment(ritm(ctx, res.ritm_sys_id))));

	// Re-run succeeds: request closed complete
	ctx.sn.advance(5 * 60 * 1000);
	ctx.cy.setPipeline('webshop', 'staging', 'shop-vm', [{ name: 'webshop-staging', jobs: [
		job('terraform-plan', build(11, 'succeeded', nowSec() - 400)),
		job('terraform-apply', build(13, 'succeeded', nowSec()))
	] }]);
	poll(ctx);
	d = deploymentOf(ctx, res.ritm_sys_id);
	assert.strictEqual(d.status, 'Succeeded');
	assert.strictEqual(d.active, '0');
	assert.strictEqual(d.build_name, '13');
	const r = ritm(ctx, res.ritm_sys_id);
	assert.strictEqual(r.state, '3');
	assert.ok(/succeeded/.test(lastComment(r)));

	// Finished deployments are not polled anymore
	const calls = ctx.cy.calls.length;
	poll(ctx);
	assert.strictEqual(ctx.cy.calls.length, calls);

	// My deployments widget
	const w = widgetServer(ctx, 'cycloid_my_deployments', null, {});
	assert.strictEqual(w.items.length, 1);
	assert.strictEqual(w.items[0].status, 'Succeeded');
	assert.strictEqual(w.items[0].stack, 'AWS virtual machine');
	assert.strictEqual(w.items[0].project, 'Web shop');
	assert.strictEqual(w.items[0].ritm_number, res.ritm_number);
});

test('two requests on the same stack and environment get distinct components', function() {
	const ctx = setup();
	sync(ctx);
	const a = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	ctx.sn.advance(60 * 1000);
	const b = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	const sec = Math.floor(ctx.sn.clock.now / 1000);
	ctx.cy.addComponent('webshop', 'staging', { canonical: 'vm-a', service_catalog: { ref: 'acme:stack-aws-vm' }, created_at: sec + 10 });
	ctx.cy.addComponent('webshop', 'staging', { canonical: 'vm-b', service_catalog: { ref: 'acme:stack-aws-vm' }, created_at: sec + 20 });
	poll(ctx);
	const da = deploymentOf(ctx, a.ritm_sys_id);
	const db = deploymentOf(ctx, b.ritm_sys_id);
	assert.strictEqual(da.component_canonical, 'vm-a');
	assert.strictEqual(db.component_canonical, 'vm-b');
});

test('a component that existed before the request is never matched', function() {
	const ctx = setup();
	sync(ctx);
	const sec = Math.floor(ctx.sn.clock.now / 1000);
	// created one minute before the request: inside the clock skew tolerance, excluded by the baseline
	ctx.cy.addComponent('webshop', 'staging', { canonical: 'just-before', service_catalog: { ref: 'acme:stack-aws-vm' }, created_at: sec - 60 });
	const res = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	poll(ctx);
	assert.strictEqual(deploymentOf(ctx, res.ritm_sys_id).status, 'Awaiting component');
	ctx.cy.addComponent('webshop', 'staging', { canonical: 'mine', service_catalog: { ref: 'acme:stack-aws-vm' }, created_at: sec + 30 });
	poll(ctx);
	assert.strictEqual(deploymentOf(ctx, res.ritm_sys_id).component_canonical, 'mine');
});

test('a request without component times out and closes the request', function() {
	const ctx = setup();
	sync(ctx);
	const res = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	ctx.sn.advance(25 * HOUR);
	poll(ctx);
	const d = deploymentOf(ctx, res.ritm_sys_id);
	assert.strictEqual(d.status, 'Timed out');
	assert.strictEqual(d.active, '0');
	assert.strictEqual(ritm(ctx, res.ritm_sys_id).state, '4');
});

test('a failure still failing after the monitoring window closes the request incomplete', function() {
	const ctx = setup();
	sync(ctx);
	const res = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	const sec = Math.floor(ctx.sn.clock.now / 1000);
	ctx.cy.addComponent('webshop', 'staging', { canonical: 'vm-1', service_catalog: { ref: 'acme:stack-aws-vm' }, created_at: sec + 5 });
	poll(ctx);
	ctx.cy.setPipeline('webshop', 'staging', 'vm-1', [{ name: 'p', jobs: [job('deploy', build(1, 'errored', sec + 100))] }]);
	ctx.sn.advance(10 * 60 * 1000);
	poll(ctx);
	assert.strictEqual(deploymentOf(ctx, res.ritm_sys_id).status, 'Failed');
	ctx.sn.advance(25 * HOUR);
	poll(ctx);
	const d = deploymentOf(ctx, res.ritm_sys_id);
	assert.strictEqual(d.status, 'Failed');
	assert.strictEqual(d.active, '0');
	assert.strictEqual(ritm(ctx, res.ritm_sys_id).state, '4');
});

test('a request closed in ServiceNow stops the tracking', function() {
	const ctx = setup();
	sync(ctx);
	const res = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	const r = ctx.sn.GlideRecord('sc_req_item');
	r.get(res.ritm_sys_id);
	r.setValue('active', false);
	r.setValue('state', '7');
	r.update();
	poll(ctx);
	const d = deploymentOf(ctx, res.ritm_sys_id);
	assert.strictEqual(d.status, 'Cancelled');
	assert.strictEqual(d.active, '0');
	assert.strictEqual(ritm(ctx, res.ritm_sys_id).state, '7', 'state left untouched');
});

test('API errors are reported on the deployment, not thrown', function() {
	const ctx = setup();
	sync(ctx);
	const res = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	ctx.cy.apiKey = 'rotated';
	poll(ctx);
	const d = deploymentOf(ctx, res.ritm_sys_id);
	assert.strictEqual(d.status, 'Awaiting component');
	assert.ok(/HTTP 403/.test(d.status_message), d.status_message);
	ctx.cy.apiKey = API_KEY;
	ctx.cy.down = true;
	poll(ctx);
	assert.ok(/unreachable/.test(deploymentOf(ctx, res.ritm_sys_id).status_message));
});

test('UI actions report the connection and sync results', function() {
	const ctx = setup();
	const current = ctx.sn.GlideRecord(T.config);
	current.query();
	current.next();
	const action = { setRedirectURL: function() {} };
	ctx.sn.run(path.join(SRC, 'ui_actions', 'test_connection.js'), { current: current, action: action });
	ctx.sn.run(path.join(SRC, 'ui_actions', 'sync_now.js'), { current: current, action: action });
	assert.ok(/Connected to Cycloid organization "acme": 4 stack/.test(ctx.sn.messages[0][1]), ctx.sn.messages[0][1]);
	assert.ok(/2 created/.test(ctx.sn.messages[1][1]), ctx.sn.messages[1][1]);
});

test('jobs stay silent when the connector is not configured', function() {
	const ctx = setup();
	ctx.sn.db[T.config] = [];
	sync(ctx);
	poll(ctx);
	assert.strictEqual(ctx.cy.calls.length, 0);
	const data = widgetServer(ctx, 'cycloid_catalog', null);
	assert.strictEqual(data.configured, false);
});

test('the API key never appears in the logs', function() {
	const ctx = setup();
	sync(ctx);
	const res = order(ctx, 'acme:stack-aws-vm', 'webshop', 'staging').result;
	ctx.cy.apiKey = 'rotated';
	poll(ctx);
	assert.ok(res.create_url);
	const leaked = ctx.sn.logs.filter(function(l) {
		return l[1].indexOf(API_KEY) >= 0;
	});
	assert.strictEqual(leaked.length, 0);
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
