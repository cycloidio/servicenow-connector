/*
 * In-memory Cycloid API used by the tests. Answers the endpoints the
 * connector calls with the same envelope as the real API:
 *   { "data": [...], "pagination": { "index": 1, "size": 100, "total": 3 } }
 */
'use strict';

function createCycloid(options) {
	const state = {
		apiUrl: options.apiUrl,
		apiKey: options.apiKey,
		org: options.org,
		stacks: [],
		projects: [], // { canonical, name, description, environments: [{ canonical, name }] }
		components: {}, // 'project/env' -> [ { canonical, name, service_catalog: { ref }, created_at } ]
		pipelines: {}, // 'project/env/component' -> [ { name, jobs: [ { name, finished_build, next_build } ] } ]
		images: {}, // url -> true
		calls: []
	};

	function page(items, query) {
		const size = parseInt(query.page_size || '1000', 10);
		const index = parseInt(query.page_index || '1', 10);
		const start = (index - 1) * size;
		return {
			status: 200,
			body: JSON.stringify({
				data: items.slice(start, start + size),
				pagination: { index: index, size: size, total: items.length }
			})
		};
	}

	function notFound(msg) {
		return { status: 404, body: JSON.stringify({ errors: [{ code: 'NotFound', message: msg }] }) };
	}

	function handler(method, url, headers) {
		state.calls.push(method.toUpperCase() + ' ' + url);

		if (state.images[url]) {
			return { status: 200, body: 'PNG', headers: { 'Content-Type': 'image/png' } };
		}
		if (url.indexOf(state.apiUrl) !== 0) {
			return { status: 404, body: 'not found' };
		}
		if (state.down) {
			throw new Error('Connection refused');
		}
		if (headers.Authorization !== 'Bearer ' + state.apiKey) {
			return {
				status: 403,
				body: JSON.stringify({ errors: [{ code: 'Unauthorized', message: 'Credential was rejected from API Request' }] })
			};
		}

		const rest = url.substring(state.apiUrl.length);
		const qIndex = rest.indexOf('?');
		const pathPart = qIndex >= 0 ? rest.substring(0, qIndex) : rest;
		const query = {};
		if (qIndex >= 0) {
			rest.substring(qIndex + 1).split('&').forEach(function(kv) {
				const p = kv.split('=');
				query[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
			});
		}
		const seg = pathPart.split('/').filter(Boolean).map(decodeURIComponent);

		if (seg[0] !== 'organizations' || seg[1] !== state.org) {
			return notFound('organization');
		}
		const s = seg.slice(2);

		if (s.length === 1 && s[0] === 'service_catalogs') {
			return page(state.stacks, query);
		}
		if (s.length === 1 && s[0] === 'projects') {
			return page(state.projects.map(function(p) {
				return { canonical: p.canonical, name: p.name, description: p.description || '' };
			}), query);
		}
		if (s[0] === 'projects') {
			const project = state.projects.filter(function(p) {
				return p.canonical === s[1];
			})[0];
			if (!project) {
				return notFound('project');
			}
			if (s.length === 3 && s[2] === 'environments') {
				return page(project.environments || [], query);
			}
			if (s.length === 5 && s[2] === 'environments' && s[4] === 'components') {
				return page(state.components[s[1] + '/' + s[3]] || [], query);
			}
			if (s.length === 7 && s[4] === 'components' && s[6] === 'pipelines') {
				return page((state.pipelines[s[1] + '/' + s[3] + '/' + s[5]] || []).map(function(p) {
					return { name: p.name, paused: false };
				}), query);
			}
			if (s.length === 9 && s[6] === 'pipelines' && s[8] === 'jobs') {
				const pipeline = (state.pipelines[s[1] + '/' + s[3] + '/' + s[5]] || []).filter(function(p) {
					return p.name === s[7];
				})[0];
				if (!pipeline) {
					return notFound('pipeline');
				}
				return { status: 200, body: JSON.stringify({ data: pipeline.jobs }) };
			}
		}
		return notFound(pathPart);
	}

	state.handler = handler;

	state.addComponent = function(project, env, component) {
		const key = project + '/' + env;
		state.components[key] = (state.components[key] || []).concat([component]);
	};

	state.setPipeline = function(project, env, component, pipelines) {
		state.pipelines[project + '/' + env + '/' + component] = pipelines;
	};

	return state;
}

module.exports = { createCycloid: createCycloid };
