/*
 * Minimal in-memory imitation of the ServiceNow server-side APIs used by the
 * connector (GlideRecord, GlideDateTime, gs, sn_ws.RESTMessageV2,
 * sn_sc.CartJS, GlideSysAttachment, Class). It is only meant to exercise the
 * connector logic from Node; it is not a ServiceNow emulator.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function newSysId() {
	return crypto.randomBytes(16).toString('hex');
}

function pad(n) {
	return n < 10 ? '0' + n : String(n);
}

function formatUtc(ms) {
	const d = new Date(ms);
	return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
		pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}

function createEnvironment(options) {
	const env = {
		db: {},
		logs: [],
		messages: [],
		clock: { now: Date.UTC(2026, 9, 21, 9, 0, 0) },
		userId: 'user_olivier',
		http: null, // function(method, url, headers) -> { status, body }
		displayFields: {},
		counters: { REQ: 10000, RITM: 10000 },
		schemas: (options && options.schemas) || {}
	};

	function table(name) {
		if (!env.db[name]) {
			env.db[name] = [];
		}
		return env.db[name];
	}

	function toStored(v) {
		if (v === true) {
			return '1';
		}
		if (v === false) {
			return '0';
		}
		if (v === null || v === undefined) {
			return '';
		}
		return String(v);
	}

	class GlideDateTime {
		constructor(value) {
			if (value === undefined || value === null || value === '') {
				this.ms = env.clock.now;
			} else if (typeof value === 'object' && value.ms !== undefined) {
				this.ms = value.ms;
			} else {
				const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value));
				if (!m) {
					throw new Error('Bad GlideDateTime value ' + value);
				}
				this.ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
			}
		}
		getNumericValue() {
			return this.ms;
		}
		setNumericValue(ms) {
			this.ms = ms;
		}
		getValue() {
			return formatUtc(this.ms);
		}
		getDisplayValue() {
			return formatUtc(this.ms);
		}
		toString() {
			return this.getValue();
		}
	}

	class GlideRecordImpl {
		constructor(tableName) {
			this._table = tableName;
			this._conds = [];
			this._order = [];
			this._limit = null;
			this._rows = [];
			this._idx = -1;
			this._cur = null;
		}
		getTableName() {
			return this._table;
		}
		addQuery(field, op, value) {
			if (arguments.length === 2) {
				value = op;
				op = '=';
			}
			this._conds.push({ field: field, op: op, value: value });
		}
		addActiveQuery() {
			this.addQuery('active', true);
		}
		addNotNullQuery(field) {
			this._conds.push({ field: field, op: 'NOTNULL' });
		}
		addNullQuery(field) {
			this._conds.push({ field: field, op: 'NULL' });
		}
		orderBy(field) {
			this._order.push({ field: field, desc: false });
		}
		orderByDesc(field) {
			this._order.push({ field: field, desc: true });
		}
		setLimit(n) {
			this._limit = n;
		}
		_match(row) {
			return this._conds.every(function(c) {
				const v = row[c.field] === undefined ? '' : row[c.field];
				switch (c.op) {
				case '=':
					return v === toStored(c.value);
				case '!=':
					return v !== toStored(c.value);
				case 'NOTNULL':
					return v !== '';
				case 'NULL':
					return v === '';
				case 'IN':
					return String(c.value).split(',').indexOf(v) >= 0;
				default:
					throw new Error('Unsupported operator ' + c.op);
				}
			});
		}
		query() {
			let rows = table(this._table).filter(this._match.bind(this));
			const order = this._order;
			if (order.length) {
				rows = rows.slice().sort(function(a, b) {
					for (const o of order) {
						const x = a[o.field] || '';
						const y = b[o.field] || '';
						if (x !== y) {
							return (x < y ? -1 : 1) * (o.desc ? -1 : 1);
						}
					}
					return 0;
				});
			}
			if (this._limit) {
				rows = rows.slice(0, this._limit);
			}
			this._rows = rows.map(function(r) {
				return Object.assign({}, r);
			});
			this._idx = -1;
			this._cur = null;
		}
		next() {
			this._idx++;
			if (this._idx < this._rows.length) {
				this._cur = this._rows[this._idx];
				return true;
			}
			this._cur = null;
			return false;
		}
		hasNext() {
			return this._idx + 1 < this._rows.length;
		}
		getRowCount() {
			return this._rows.length;
		}
		get(a, b) {
			this._conds = [];
			if (b === undefined) {
				if (!a) {
					return false;
				}
				this.addQuery('sys_id', a);
			} else {
				this.addQuery(a, b);
			}
			this.query();
			return this.next();
		}
		initialize() {
			this._cur = { __new: true };
		}
		isNewRecord() {
			return !!(this._cur && this._cur.__new);
		}
		isValidRecord() {
			return !!this._cur;
		}
		isValidField(field) {
			const schema = env.schemas[this._table];
			return !schema || schema.indexOf(field) >= 0;
		}
		getValue(field) {
			if (!this._cur) {
				return null;
			}
			const v = this._cur[field];
			return v === undefined || v === '' ? null : v;
		}
		setValue(field, value) {
			if (!this._cur) {
				throw new Error('setValue on no current record (' + this._table + '.' + field + ')');
			}
			this._cur[field] = toStored(value);
		}
		getDisplayValue(field) {
			if (!field) {
				const df = env.displayFields[this._table] || 'name';
				return this.getValue(df) || '';
			}
			const v = this.getValue(field);
			if (!v) {
				return '';
			}
			if (field === 'picture') {
				return v + '.iix';
			}
			const refs = env.references[this._table] || {};
			if (refs[field]) {
				const target = table(refs[field]).filter(function(r) {
					return r.sys_id === v;
				})[0];
				const df = env.displayFields[refs[field]] || 'name';
				return target ? target[df] || '' : '';
			}
			return v;
		}
		getUniqueValue() {
			return this._cur ? this._cur.sys_id : null;
		}
		insert() {
			const row = this._cur;
			delete row.__new;
			if (!row.sys_id) {
				row.sys_id = newSysId();
			}
			const now = formatUtc(env.clock.now);
			row.sys_created_on = row.sys_created_on || now;
			row.sys_updated_on = now;
			const uniques = env.unique[this._table] || [];
			for (const f of uniques) {
				if (row[f] && table(this._table).some(function(r) {
					return r[f] === row[f];
				})) {
					return null; // unique index violation
				}
			}
			if (env.onInsert[this._table]) {
				env.onInsert[this._table](row);
			}
			this._applyJournal(row);
			table(this._table).push(Object.assign({}, row));
			return row.sys_id;
		}
		update() {
			if (!this._cur || this._cur.__new) {
				return this.insert();
			}
			const rows = table(this._table);
			const row = this._cur;
			row.sys_updated_on = formatUtc(env.clock.now);
			this._applyJournal(row);
			for (let i = 0; i < rows.length; i++) {
				if (rows[i].sys_id === row.sys_id) {
					rows[i] = Object.assign({}, row);
					return row.sys_id;
				}
			}
			return null;
		}
		_applyJournal(row) {
			if (row.__comment) {
				row.__comments = (row.__comments || []).concat([row.__comment]);
				delete row.__comment;
			}
		}
		deleteRecord() {
			const rows = table(this._table);
			const id = this.getUniqueValue();
			env.db[this._table] = rows.filter(function(r) {
				return r.sys_id !== id;
			});
			return true;
		}
	}

	const INTERNAL = new Set(['_table', '_conds', '_order', '_limit', '_rows', '_idx', '_cur']);

	function GlideRecord(tableName) {
		const impl = new GlideRecordImpl(tableName);
		return new Proxy(impl, {
			get: function(target, prop) {
				if (prop in target || typeof prop === 'symbol') {
					const v = target[prop];
					return typeof v === 'function' ? v.bind(target) : v;
				}
				if (prop === 'variables') {
					return (target._cur && target._cur.__variables) || {};
				}
				return target._cur ? target._cur[prop] : undefined;
			},
			set: function(target, prop, value) {
				if (INTERNAL.has(prop)) {
					target[prop] = value;
				} else if (prop === 'comments' || prop === 'work_notes') {
					target._cur.__comment = String(value);
				} else {
					target.setValue(prop, value);
				}
				return true;
			}
		});
	}

	env.references = {};
	env.unique = {};
	env.onInsert = {
		sc_request: function(row) {
			row.number = row.number || 'REQ00' + (++env.counters.REQ);
		},
		sc_req_item: function(row) {
			row.number = row.number || 'RITM00' + (++env.counters.RITM);
			row.active = row.active || '1';
			row.state = row.state || '1';
		}
	};

	const gs = {
		info: function(m) {
			env.logs.push(['info', String(m)]);
		},
		warn: function(m) {
			env.logs.push(['warn', String(m)]);
		},
		error: function(m) {
			env.logs.push(['error', String(m)]);
		},
		debug: function() {},
		getUserID: function() {
			return env.userId;
		},
		getMessage: function(m) {
			return m;
		},
		addInfoMessage: function(m) {
			env.messages.push(['info', String(m)]);
		},
		addErrorMessage: function(m) {
			env.messages.push(['error', String(m)]);
		}
	};

	class RESTResponseV2 {
		constructor(status, body, headers, attachmentId, error) {
			this._status = status;
			this._body = body;
			this._headers = headers || {};
			this._attachmentId = attachmentId || null;
			this._error = error || null;
		}
		getStatusCode() {
			return this._status;
		}
		getBody() {
			return this._body;
		}
		getHeader(name) {
			return this._headers[name] || null;
		}
		haveError() {
			return !!this._error || this._status >= 400;
		}
		getErrorMessage() {
			return this._error || '';
		}
		getResponseAttachmentSysid() {
			return this._attachmentId;
		}
	}

	class RESTMessageV2 {
		constructor() {
			this.headers = {};
			this.method = 'get';
			this.endpoint = null;
			this.saveAs = null;
		}
		setHttpMethod(m) {
			this.method = String(m).toLowerCase();
		}
		setEndpoint(e) {
			this.endpoint = e;
		}
		setRequestHeader(k, v) {
			this.headers[k] = v;
		}
		setHttpTimeout() {}
		saveResponseBodyAsAttachment(tableName, sysId, fileName) {
			this.saveAs = { table: tableName, sysId: sysId, fileName: fileName };
		}
		execute() {
			env.requests = env.requests || [];
			env.requests.push({ method: this.method, url: this.endpoint, headers: Object.assign({}, this.headers) });
			let res;
			try {
				res = env.http(this.method, this.endpoint, this.headers);
			} catch (e) {
				return new RESTResponseV2(0, '', {}, null, e.message);
			}
			let attachmentId = null;
			if (this.saveAs && res.status === 200) {
				attachmentId = newSysId();
				table('sys_attachment').push({
					sys_id: attachmentId,
					table_name: this.saveAs.table,
					table_sys_id: this.saveAs.sysId,
					file_name: this.saveAs.fileName,
					content_type: (res.headers && res.headers['Content-Type']) || 'image/png'
				});
			}
			return new RESTResponseV2(res.status, this.saveAs ? '' : res.body, res.headers, attachmentId);
		}
	}

	class GlideSysAttachment {
		deleteAttachment(sysId) {
			env.db.sys_attachment = table('sys_attachment').filter(function(a) {
				return a.sys_id !== sysId;
			});
		}
	}

	class CartJS {
		orderNow(request) {
			const req = GlideRecord('sc_request');
			req.initialize();
			req.setValue('requested_for', env.userId);
			const reqId = req.insert();
			const ritm = GlideRecord('sc_req_item');
			ritm.initialize();
			ritm.setValue('request', reqId);
			ritm.setValue('cat_item', request.sysparm_id);
			ritm.setValue('requested_for', env.userId);
			ritm.setValue('opened_by', env.userId);
			ritm._cur.__variables = Object.assign({}, request.variables || {});
			const ritmId = ritm.insert();
			env.lastOrder = { requestId: reqId, ritmId: ritmId };
			const r = GlideRecord('sc_request');
			r.get(reqId);
			return { request_id: reqId, request_number: r.getValue('number'), table: 'sc_request' };
		}
	}

	const Class = {
		create: function() {
			return function() {
				this.initialize.apply(this, arguments);
			};
		}
	};

	const context = {
		GlideRecord: GlideRecord,
		GlideDateTime: GlideDateTime,
		GlideSysAttachment: GlideSysAttachment,
		gs: gs,
		sn_ws: { RESTMessageV2: RESTMessageV2 },
		sn_sc: { CartJS: CartJS },
		Class: Class,
		JSON: JSON,
		console: console
	};
	vm.createContext(context);

	env.context = context;
	env.GlideRecord = GlideRecord;
	env.GlideDateTime = GlideDateTime;
	env.table = table;
	env.formatUtc = formatUtc;

	/** Loads script includes into the context and exposes them under the scope namespace. */
	env.loadScriptIncludes = function(dir, names, replacements) {
		const scope = {};
		for (const name of names) {
			let code = fs.readFileSync(path.join(dir, name + '.js'), 'utf8');
			for (const k in (replacements || {})) {
				code = code.split(k).join(replacements[k]);
			}
			vm.runInContext(code + '\nthis.' + name + ' = ' + name + ';', context, { filename: name + '.js' });
			scope[name] = context[name];
		}
		context.x_1829062_cycloi_1 = scope;
		return scope;
	};

	/** Runs a server script (scheduled job, business rule, UI action, widget server script). */
	env.run = function(file, globals) {
		const code = fs.readFileSync(file, 'utf8');
		const local = Object.assign({}, globals || {});
		const names = Object.keys(local);
		const fn = vm.runInContext('(function(' + names.join(',') + ') {\n' + code + '\n})', context, { filename: file });
		fn.apply(null, names.map(function(n) {
			return local[n];
		}));
		return local;
	};

	env.insert = function(tableName, values) {
		const gr = GlideRecord(tableName);
		gr.initialize();
		for (const k in values) {
			gr.setValue(k, values[k]);
		}
		return gr.insert();
	};

	env.find = function(tableName, predicate) {
		return table(tableName).filter(predicate || function() {
			return true;
		});
	};

	env.advance = function(ms) {
		env.clock.now += ms;
	};

	return env;
}

module.exports = { createEnvironment: createEnvironment, formatUtc: formatUtc };
