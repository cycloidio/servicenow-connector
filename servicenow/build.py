#!/usr/bin/env python3
"""
Builds the ServiceNow update set of the Cycloid connector.

    python3 servicenow/build.py            # writes dist/cycloid-servicenow-connector-v<version>.xml

Inputs
  servicenow/base/   records exported from the v1 application (kept as-is)
  servicenow/src/    scripts, widgets... (readable sources)
  this file          the list of v2 records (tables, fields, ACLs, jobs, widgets...)

The output is a "Retrieved Update Set" XML: in ServiceNow, go to
System Update Sets > Retrieved Update Sets > Import Update Set from XML,
then Preview and Commit.

sys_ids of v2 records are derived from stable keys, so rebuilding produces
the same sys_ids and re-importing a newer build updates records in place.
"""
import glob
import hashlib
import json
import os
import re
import sys
from xml.sax.saxutils import escape, quoteattr

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SN = os.path.join(ROOT, 'servicenow')
SRC = os.path.join(SN, 'src')
BASE = os.path.join(SN, 'base')
DIST = os.path.join(ROOT, 'dist')

VERSION = '2.0.0'
APP_ID = '7033a6013bff26102b1ebffe23e45a17'
APP_NAME = 'Cycloid Stack Catalog Connector'
SCOPE = 'x_1829062_cycloi_1'
ADMIN_ROLE = ('c533a6013bff26102b1ebffe23e45a1d', SCOPE + '.admin')
STAMP = '2026-10-21 12:00:00'
AUTHOR = 'admin'

T_CONFIG = SCOPE + '_cycloid_config'
T_STACK = SCOPE + '_cycloid_stack'
T_PROJECT = SCOPE + '_cycloid_project'
T_ENV = SCOPE + '_cycloid_environment'
T_DEPLOY = SCOPE + '_cycloid_deployment'

V1_WIDGET_ID = '85347eed3b7fe6102b1ebffe23e45acc'
V1_SCRIPT_INCLUDE_ID = 'a7e2fa053b3366102b1ebffe23e45ad6'
CONFIG_SECTION_ID = '111bc7053bb366102b1ebffe23e45ac4'


def sid(key):
    """Stable 32 hex sys_id for a v2 record."""
    return hashlib.md5(('cycloid-servicenow-connector/' + key).encode()).hexdigest()


def read(*parts):
    with open(os.path.join(SRC, *parts), encoding='utf-8') as f:
        return f.read()


class Script(str):
    """A value written as CDATA."""


class Ref(object):
    def __init__(self, value, display=None, **attrs):
        self.value, self.display, self.attrs = value, display, attrs


def cdata(text):
    return '<![CDATA[' + text.replace(']]>', ']]]]><![CDATA[>') + ']]>'


def element(name, value, indent='        '):
    if value is None or value == '':
        return '%s<%s/>' % (indent, name)
    if isinstance(value, Ref):
        attrs = ''
        if value.display is not None:
            attrs += ' display_value=%s' % quoteattr(value.display)
        for k, v in value.attrs.items():
            attrs += ' %s=%s' % (k, quoteattr(v))
        return '%s<%s%s>%s</%s>' % (indent, name, attrs, escape(value.value), name)
    if isinstance(value, Script):
        return '%s<%s>%s</%s>' % (indent, name, cdata(value), name)
    if isinstance(value, bool):
        value = 'true' if value else 'false'
    return '%s<%s>%s</%s>' % (indent, name, escape(str(value)), name)


def scope_fields():
    return {
        'sys_package': Ref(APP_ID, APP_NAME, source=SCOPE),
        'sys_scope': Ref(APP_ID, APP_NAME),
    }


def audit_fields():
    return {
        'sys_created_by': AUTHOR, 'sys_created_on': STAMP,
        'sys_updated_by': AUTHOR, 'sys_updated_on': STAMP,
        'sys_mod_count': '0', 'sys_policy': None,
    }


class Update(object):
    """One sys_update_xml entry."""

    def __init__(self, name, table, payload, target, action='INSERT_OR_UPDATE', target_table=None):
        self.name, self.table, self.payload, self.target, self.action = name, table, payload, target, action
        self.target_table = target_table  # sys_update_xml.table for dictionary, label and form records


UPDATES = []


def record(table, sys_id, fields, target=None, action='INSERT_OR_UPDATE'):
    """Standard record update (most tables)."""
    values = dict(fields)
    values.setdefault('sys_class_name', table)
    values['sys_id'] = sys_id
    values.update(scope_fields())
    values.update(audit_fields())
    update_name = '%s_%s' % (table, sys_id)
    values['sys_update_name'] = update_name
    body = '\n'.join(element(k, values[k]) for k in sorted(values))
    payload = ('<?xml version="1.0" encoding="UTF-8"?><record_update table="%s">\n'
               '    <%s action="%s">\n%s\n    </%s>\n</record_update>') % (table, table, action, body, table)
    UPDATES.append(Update(update_name, table, payload, target or values.get('name') or sys_id, action))
    return sys_id


def delete_record(table, sys_id, target):
    payload = ('<?xml version="1.0" encoding="UTF-8"?><record_update table="%s">\n'
               '    <%s action="DELETE">\n        <sys_id>%s</sys_id>\n    </%s>\n</record_update>') % (
        table, table, sys_id, table)
    UPDATES.append(Update('%s_%s' % (table, sys_id), table, payload, target, 'DELETE'))


# --------------------------------------------------------------------------
# Tables and fields
# --------------------------------------------------------------------------

DICT_DEFAULTS = {
    'active': 'true', 'array': 'false', 'attributes': None, 'audit': 'false', 'calculation': None,
    'choice': '0', 'choice_field': None, 'choice_table': None, 'comments': None, 'create_roles': None,
    'default_value': None, 'defaultsort': None, 'delete_roles': None, 'dependent': None,
    'dependent_on_field': None, 'display': 'false', 'dynamic_creation': 'false',
    'dynamic_creation_script': None, 'dynamic_default_value': None, 'dynamic_ref_qual': None,
    'element_reference': 'false', 'foreign_database': None, 'formula': None, 'function_definition': None,
    'function_field': 'false', 'mandatory': 'false', 'next_element': None, 'primary': 'false',
    'read_only': 'false', 'read_roles': None, 'reference': None, 'reference_cascade_rule': None,
    'reference_floats': 'false', 'reference_key': None, 'reference_qual': None,
    'reference_qual_condition': None, 'reference_type': None, 'spell_check': 'false', 'staged': 'false',
    'sys_class_name': 'sys_dictionary', 'table_reference': 'false', 'text_index': 'false',
    'unique': 'false', 'use_dependent_field': 'false', 'use_dynamic_default': 'false',
    'use_reference_qualifier': 'simple', 'virtual': 'false', 'virtual_type': 'script', 'widget': None,
    'write_roles': None, 'xml_view': 'false',
}

TYPE_LABELS = {
    'string': 'String', 'boolean': 'True/False', 'integer': 'Integer', 'glide_date_time': 'Date/Time',
    'url': 'URL', 'reference': 'Reference', 'collection': 'Collection',
}


def dictionary(table, element_name, label, internal_type, max_length, extends=None, **opts):
    values = dict(DICT_DEFAULTS)
    values.update({
        'column_label': label, 'element': element_name or None,
        'internal_type': Ref(internal_type, TYPE_LABELS[internal_type]),
        'max_length': str(max_length), 'name': table, 'sys_name': element_name or table,
    })
    for k, v in opts.items():
        values[k] = v if not isinstance(v, bool) else ('true' if v else 'false')
    values.update(scope_fields())
    values.update(audit_fields())
    update_name = 'sys_dictionary_%s_%s' % (table, element_name or 'null')
    values['sys_update_name'] = update_name
    attrs = 'element=%s' % quoteattr(element_name or '')
    if extends:
        attrs += ' extends=%s' % quoteattr(extends)
    attrs += ' table=%s' % quoteattr(table)
    body = '\n'.join(element(k, values[k]) for k in sorted(values))
    payload = ('<?xml version="1.0" encoding="UTF-8"?><record_update>\n'
               '    <sys_dictionary action="INSERT_OR_UPDATE" %s>\n%s\n    </sys_dictionary>\n</record_update>'
               ) % (attrs, body)
    UPDATES.append(Update(update_name, 'sys_dictionary', payload, '%s.%s' % (table, element_name or ''),
                          target_table=table))


def documentation(table, element_name, label, plural=None):
    update_name = 'sys_documentation_%s_%s_en' % (table, element_name or '')
    values = {
        'element': element_name or None, 'help': None, 'hint': None, 'label': label, 'language': 'en',
        'name': table, 'plural': plural, 'sys_class_name': 'sys_documentation', 'sys_name': label,
        'url': None, 'url_target': None, 'sys_update_name': update_name,
    }
    values.update(scope_fields())
    values.update(audit_fields())
    body = '\n'.join(element(k, values[k], '            ') for k in sorted(values))
    payload = ('<?xml version="1.0" encoding="UTF-8"?><record_update>\n'
               '    <sys_documentation element=%s label=%s language="en" table=%s>\n'
               '        <sys_documentation action="INSERT_OR_UPDATE">\n%s\n'
               '        </sys_documentation>\n    </sys_documentation>\n</record_update>') % (
        quoteattr(element_name or ''), quoteattr(label), quoteattr(table), body)
    UPDATES.append(Update(update_name, 'sys_documentation', payload, '%s.%s' % (table, element_name or ''),
                          target_table=table))


def table(name, label, plural, fields, display_field):
    """Creates a new table (sys_db_object + collection + fields + labels)."""
    record('sys_db_object', sid('table/' + name), {
        'access': 'public', 'actions_access': False, 'alter_access': False, 'caller_access': None,
        'client_scripts_access': False, 'configuration_access': False, 'create_access': False,
        'create_access_controls': False, 'delete_access': False, 'filter_extension': None,
        'is_df_table': False, 'is_extendable': False, 'label': label, 'live_feed_enabled': False,
        'name': name, 'number_ref': None, 'provider_class': None, 'read_access': True,
        'scriptable_table': False, 'super_class': None, 'sys_name': label, 'update_access': False,
        'user_role': None, 'ws_access': True,
    }, target=label)
    dictionary(name, '', None, 'collection', 40)
    documentation(name, '', label, plural)
    for f in fields:
        add_field(name, f, display=(f[0] == display_field))


def add_field(table_name, f, display=False):
    element_name, label, ftype, length = f[0], f[1], f[2], f[3]
    opts = dict(f[4]) if len(f) > 4 else {}
    if display:
        opts['display'] = True
    if ftype == 'reference':
        ref_table = opts.pop('ref')
        opts['reference'] = Ref(ref_table, ref_table)
    dictionary(table_name, element_name, label, ftype, length, **opts)
    documentation(table_name, element_name, label)


def build_tables():
    # New fields on the v1 configuration table
    for f in [
        ('component_timeout_hours', 'Component timeout (hours)', 'integer', 40, {'default_value': '24'}),
        ('monitoring_window_hours', 'Pipeline monitoring window (hours)', 'integer', 40, {'default_value': '24'}),
        ('deploy_job_pattern', 'Deployment job pattern', 'string', 255, {'default_value': 'apply|deploy'}),
    ]:
        add_field(T_CONFIG, f)

    # New fields on the v1 stack table (extends sc_cat_item)
    for f in [
        ('stack_canonical', 'Stack canonical', 'string', 255),
        ('image_url', 'Image URL', 'string', 1024),
        ('last_synced', 'Last synced', 'glide_date_time', 40),
    ]:
        add_field(T_STACK, f)

    table(T_PROJECT, 'Cycloid Project', 'Cycloid Projects', [
        ('name', 'Name', 'string', 255, {'mandatory': True}),
        ('canonical', 'Canonical', 'string', 255, {'mandatory': True}),
        ('description', 'Description', 'string', 1000),
        ('active', 'Active', 'boolean', 40, {'default_value': 'true'}),
        ('last_synced', 'Last synced', 'glide_date_time', 40),
    ], 'name')

    table(T_ENV, 'Cycloid Environment', 'Cycloid Environments', [
        ('name', 'Name', 'string', 255, {'mandatory': True}),
        ('canonical', 'Canonical', 'string', 255, {'mandatory': True}),
        ('project', 'Project', 'reference', 32, {'ref': T_PROJECT, 'mandatory': True}),
        ('active', 'Active', 'boolean', 40, {'default_value': 'true'}),
        ('last_synced', 'Last synced', 'glide_date_time', 40),
    ], 'name')

    table(T_DEPLOY, 'Cycloid Deployment', 'Cycloid Deployments', [
        ('requested_item', 'Requested item', 'reference', 32, {'ref': 'sc_req_item', 'unique': True}),
        ('requested_for', 'Requested for', 'reference', 32, {'ref': 'sys_user'}),
        ('stack', 'Stack', 'reference', 32, {'ref': T_STACK}),
        ('stack_ref', 'Stack reference', 'string', 255),
        ('project', 'Project', 'reference', 32, {'ref': T_PROJECT}),
        ('environment', 'Environment', 'reference', 32, {'ref': T_ENV}),
        ('project_canonical', 'Project canonical', 'string', 255),
        ('environment_canonical', 'Environment canonical', 'string', 255),
        ('status', 'Status', 'string', 40),
        ('status_message', 'Status message', 'string', 1000),
        ('active', 'Active', 'boolean', 40, {'default_value': 'true'}),
        ('create_url', 'Create component URL', 'url', 1024),
        ('baseline_components', 'Components before the request', 'string', 4000),
        ('component_canonical', 'Component canonical', 'string', 255),
        ('component_name', 'Component name', 'string', 255),
        ('component_url', 'Component URL', 'url', 1024),
        ('pipeline_name', 'Pipeline', 'string', 255),
        ('job_name', 'Job', 'string', 255),
        ('build_id', 'Build ID', 'string', 40),
        ('build_name', 'Build number', 'string', 40),
        ('build_status', 'Build status', 'string', 40),
        ('build_url', 'Build URL', 'url', 1024),
        ('notified_build', 'Last notified build', 'string', 40),
        ('requested_at', 'Requested at', 'glide_date_time', 40),
        ('component_found_at', 'Component found at', 'glide_date_time', 40),
        ('finished_at', 'Finished at', 'glide_date_time', 40),
        ('last_checked', 'Last checked', 'glide_date_time', 40),
    ], 'requested_item')


# --------------------------------------------------------------------------
# Forms
# --------------------------------------------------------------------------

def form_section(table_name, section_id, elements):
    """Default view form layout of a table (single section)."""
    items = []
    for i, el in enumerate(elements):
        items.append('\n'.join([
            '        <sys_ui_element action="INSERT_OR_UPDATE">',
            element('element', el, '            '),
            element('position', str(i), '            '),
            element('sys_created_by', AUTHOR, '            '),
            element('sys_created_on', STAMP, '            '),
            element('sys_id', sid('ui_element/%s/%s' % (table_name, el)), '            '),
            element('sys_mod_count', '0', '            '),
            '            <sys_ui_formatter/>',
            '            <sys_ui_section caption="NULL" display_value="" name="%s" sys_domain="global" '
            'view="Default view">%s</sys_ui_section>' % (table_name, section_id),
            element('sys_updated_by', AUTHOR, '            '),
            element('sys_updated_on', STAMP, '            '),
            '            <sys_user/>',
            element('type', el if el.startswith('.') else None, '            '),
            '        </sys_ui_element>']))
    update_name = 'sys_ui_section_%s' % section_id
    values = {
        'caption': None, 'header': 'false', 'name': table_name, 'roles': None,
        'sys_class_name': 'sys_ui_section', 'sys_domain': 'global', 'sys_domain_path': '/',
        'sys_id': section_id, 'sys_name': table_name, 'sys_overrides': None,
        'sys_update_name': update_name, 'sys_user': None, 'title': 'true',
        'view': Ref('Default view', 'Default view', name='NULL'), 'view_name': None,
    }
    values.update(scope_fields())
    values.update(audit_fields())
    head = '\n'.join(element(k, values[k], '            ') for k in sorted(values))
    payload = ('<?xml version="1.0" encoding="UTF-8"?><record_update>\n'
               '    <sys_ui_section caption="" section_id="%s" sys_domain="global" table="%s" version="3" view="">\n'
               '%s\n        <sys_ui_section action="INSERT_OR_UPDATE">\n%s\n        </sys_ui_section>\n'
               '    </sys_ui_section>\n</record_update>') % (section_id, table_name, '\n'.join(items), head)
    UPDATES.append(Update(update_name, 'sys_ui_section', payload, table_name, target_table=table_name))


def build_forms():
    form_section(T_CONFIG, CONFIG_SECTION_ID, [
        'organization_canonical', 'api_url', 'console_url', 'api_key', 'catalog_category',
        'component_timeout_hours', 'monitoring_window_hours', 'deploy_job_pattern'])
    form_section(T_PROJECT, sid('section/project'), [
        'name', 'canonical', 'description', 'active', 'last_synced'])
    form_section(T_ENV, sid('section/environment'), [
        'name', 'canonical', 'project', 'active', 'last_synced'])
    form_section(T_DEPLOY, sid('section/deployment'), [
        'requested_item', 'requested_for', 'status', 'status_message', 'active',
        '.begin_split', 'stack', 'project', 'environment', 'component_name', '.split',
        'requested_at', 'component_found_at', 'finished_at', 'last_checked', '.end_split',
        'create_url', 'component_url', 'build_url',
        '.begin_split', 'stack_ref', 'project_canonical', 'environment_canonical', 'component_canonical', '.split',
        'pipeline_name', 'job_name', 'build_name', 'build_status', '.end_split',
        'baseline_components'])


# --------------------------------------------------------------------------
# Security
# --------------------------------------------------------------------------

def acl(table_name, operation, roles):
    acl_id = sid('acl/%s/%s/%s' % (table_name, operation, ','.join(r[1] for r in roles) or 'everyone'))
    record('sys_security_acl', acl_id, {
        'active': True, 'admin_overrides': True, 'advanced': False, 'applies_to': None,
        'condition': None, 'controlled_by_refs': None, 'decision_type': 'allow',
        'description': 'Cycloid connector v2' + ('' if roles else ' - any authenticated user'),
        'local_or_existing': 'Existing', 'name': table_name,
        'operation': Ref(operation, operation), 'script': None, 'security_attribute': None,
        'sys_name': table_name, 'type': Ref('record', 'record'),
    }, target='%s.%s' % (table_name, operation))
    for role_id, role_name in roles:
        record('sys_security_acl_role', sid('acl_role/%s/%s' % (acl_id, role_name)), {
            'sys_name': '%s.%s' % (table_name, role_name),
            'sys_security_acl': Ref(acl_id, table_name),
            'sys_user_role': Ref(role_id, role_name, name=role_name),
        }, target='%s.%s' % (table_name, role_name))


def build_security():
    admin = [ADMIN_ROLE]
    # Catalog items must be readable by every requester
    acl(T_STACK, 'read', [])
    for t in (T_PROJECT, T_ENV):
        acl(t, 'read', [])
        for op in ('write', 'create', 'delete'):
            acl(t, op, admin)
    for op in ('read', 'write', 'create', 'delete'):
        acl(T_DEPLOY, op, admin)

    # Cross scope privileges used by v2 (v1 ones are in servicenow/base)
    for target, ttype, op in [
        ('sc_req_item', 'sys_db_object', 'read'),
        ('sc_req_item', 'sys_db_object', 'write'),
        ('sc_request', 'sys_db_object', 'read'),
        ('io_set_item', 'sys_db_object', 'read'),
        ('io_set_item', 'sys_db_object', 'create'),
        ('sc_category', 'sys_db_object', 'read'),
        ('ScriptableRESTMessageClient.saveResponseBodyAsAttachment', 'scriptable', 'execute'),
        ('ScriptableRESTMessageClient.setHttpTimeout', 'scriptable', 'execute'),
        ('ScriptableRESTResponse.getResponseAttachmentSysid', 'scriptable', 'execute'),
        ('ScriptableRESTResponse.haveError', 'scriptable', 'execute'),
        ('ScriptableRESTResponse.getErrorMessage', 'scriptable', 'execute'),
        ('GlideSysAttachment.deleteAttachment', 'scriptable', 'execute'),
    ]:
        record('sys_scope_privilege', sid('privilege/%s/%s' % (target, op)), {
            'operation': op, 'source_scope': Ref(APP_ID, APP_NAME), 'status': 'allowed',
            'sys_name': target, 'target_name': target, 'target_scope': Ref('global', 'Global'),
            'target_type': ttype,
        }, target=target)


# --------------------------------------------------------------------------
# Logic: script includes, business rule, jobs, UI actions
# --------------------------------------------------------------------------

def script_include(name, sys_id, description):
    code = read('script_includes', name + '.js')
    code = code.replace('@@VARIABLE_SET_SYS_ID@@', sid('variable_set'))
    record('sys_script_include', sys_id, {
        'access': 'public', 'active': True, 'api_name': '%s.%s' % (SCOPE, name), 'caller_access': None,
        'client_callable': False, 'description': description, 'mobile_callable': False, 'name': name,
        'sandbox_callable': False, 'script': Script(code), 'sys_name': name,
    }, target=name)


def build_logic():
    script_include('CycloidApi', sid('si/CycloidApi'), 'Cycloid HTTP API client and console deep links.')
    script_include('CycloidSync', sid('si/CycloidSync'),
                   'Replicates Cycloid stacks, projects and environments into ServiceNow.')
    script_include('CycloidDeploymentTracker', sid('si/CycloidDeploymentTracker'),
                   'Orders Cycloid services and follows the matching component pipeline.')
    script_include('CycloidIntegration', V1_SCRIPT_INCLUDE_ID, 'v1 entry points, delegates to the v2 classes.')

    record('sys_script', sid('br/create_deployment'), {
        'abort_action': False, 'access': 'package_private', 'action_delete': False, 'action_insert': True,
        'action_query': False, 'action_update': False, 'active': True, 'add_message': False,
        'advanced': True, 'change_fields': False, 'client_callable': False, 'collection': 'sc_req_item',
        'condition': "current.cat_item.sys_class_name == '%s'" % T_STACK, 'description':
            'Creates the Cycloid deployment record when a Cycloid catalog item is ordered.',
        'execute_function': False, 'filter_condition': None, 'is_rest': False, 'message': None,
        'name': 'Cycloid - Create deployment', 'order': '100', 'priority': '100', 'rest_method': None,
        'rest_method_text': None, 'rest_service': None, 'rest_service_text': None, 'rest_variables': None,
        'role_conditions': None, 'script': Script(read('business_rules', 'create_cycloid_deployment.js')),
        'sys_name': 'Cycloid - Create deployment', 'template': None, 'when': 'async',
    }, target='Cycloid - Create deployment')

    for key, name, period, script in [
        ('job/sync', 'Cycloid - Sync catalog', '1970-01-01 00:15:00', 'sync_catalog.js'),
        ('job/track', 'Cycloid - Track deployments', '1970-01-01 00:01:00', 'track_deployments.js'),
    ]:
        record('sysauto_script', sid(key), {
            'active': True, 'business_calendar': None, 'condition': None, 'conditional': False,
            'entered_time': '1970-01-01 00:00:00', 'max_drift': None, 'name': name, 'offset': None,
            'offset_type': '0', 'run_as': None, 'run_as_tz': None, 'run_dayofmonth': '1',
            'run_dayofweek': '1', 'run_period': period, 'run_start': '2026-01-01 00:00:00',
            'run_time': '1970-01-01 00:00:00', 'run_type': 'periodically',
            'script': Script(read('scheduled_jobs', script)), 'sys_name': name, 'time_zone': None,
            'upgrade_safe': False,
        }, target=name)

    for key, name, action_name, script, order in [
        ('ua/test', 'Test connection', 'cycloid_test_connection', 'test_connection.js', '100'),
        ('ua/sync', 'Sync now', 'cycloid_sync_now', 'sync_now.js', '200'),
    ]:
        record('sys_ui_action', sid(key), {
            'action_name': action_name, 'active': True, 'client': False, 'comments': None,
            'condition': '!current.isNewRecord()', 'form_action': True, 'form_button': True,
            'form_context_menu': False, 'form_link': False, 'form_style': None, 'hint': None,
            'isolate_script': True, 'list_action': False, 'list_banner_button': False,
            'list_button': False, 'list_choice': False, 'list_context_menu': False, 'list_link': False,
            'list_save_with_form_button': False, 'list_style': None, 'messages': None, 'name': name,
            'onclick': None, 'order': order, 'script': Script(read('ui_actions', script)),
            'show_insert': False, 'show_multiple_update': False, 'show_query': False,
            'show_update': True, 'sys_name': name, 'table': T_CONFIG, 'ui11_compatible': True,
            'ui16_compatible': True,
        }, target=name)


# --------------------------------------------------------------------------
# Catalog: variable set shared by every Cycloid catalog item
# --------------------------------------------------------------------------

def build_catalog():
    vset = sid('variable_set')
    record('item_option_new_set', vset, {
        'description': 'Cycloid project and environment where the service is deployed.',
        'display_title': False, 'internal_name': 'cycloid_deployment_target', 'layout': 'normal',
        'name': 'Cycloid deployment target', 'order': '100', 'read_roles': None, 'write_roles': None,
        'create_roles': None, 'title': 'Cycloid deployment target', 'type': 'one_to_one',
        'sys_name': 'Cycloid deployment target', 'version': '1',
    }, target='Cycloid deployment target')

    common = {
        'active': True, 'cat_item': None, 'category': None, 'default_value': None, 'delete_roles': None,
        'description': None, 'do_not_select_first': False, 'dynamic_ref_qual': None, 'global': False,
        'help_tag': 'More information', 'help_text': None, 'hidden': False, 'instructions': None,
        'mandatory': True, 'read_only': False, 'read_roles': None, 'show_help': False,
        'sys_class_name': 'item_option_new', 'variable_set': Ref(vset, 'Cycloid deployment target'),
        'visible_guide': True, 'visible_standalone': True, 'visible_summary': True, 'write_roles': None,
        'create_roles': None, 'type': Ref('8', 'Reference'),
    }
    project_var = sid('variable/cycloid_project')
    fields = dict(common)
    fields.update({
        'name': 'cycloid_project', 'question_text': 'Cycloid project', 'order': '100',
        'reference': Ref(T_PROJECT, 'Cycloid Project'), 'reference_qual': None,
        'reference_qual_condition': 'active=true^EQ', 'use_reference_qualifier': 'simple',
        'attributes': None, 'tooltip': 'Project in which the component is created',
        'sys_name': 'cycloid_project',
    })
    record('item_option_new', project_var, fields, target='cycloid_project')

    fields = dict(common)
    fields.update({
        'name': 'cycloid_environment', 'question_text': 'Cycloid environment', 'order': '200',
        'reference': Ref(T_ENV, 'Cycloid Environment'),
        'reference_qual': "javascript:'active=true^project=' + current.variables.cycloid_project;",
        'reference_qual_condition': None, 'use_reference_qualifier': 'advanced',
        'attributes': 'ref_qual_elements=cycloid_project', 'tooltip': 'Environment of the selected project',
        'sys_name': 'cycloid_environment',
    })
    record('item_option_new', sid('variable/cycloid_environment'), fields, target='cycloid_environment')

    record('catalog_script_client', sid('catalog_client/clear_env'), {
        'active': True, 'applies_catalog': True, 'applies_req_item': False, 'applies_sc_task': False,
        'applies_target_record': False, 'applies_to': 'set', 'cat_item': None,
        'cat_variable': 'IO:' + project_var, 'condition': None, 'description': None,
        'field': None, 'global': True, 'isolate_script': True, 'messages': None,
        'name': 'Cycloid - Clear environment when the project changes', 'order': '100',
        'script': Script(read('catalog_client_scripts', 'clear_environment_on_project_change.js')),
        'sys_name': 'Cycloid - Clear environment when the project changes', 'type': 'onChange',
        'ui_type': '10', 'va_set': None, 'variable_set': Ref(vset, 'Cycloid deployment target'),
        'view': None,
    }, target='Cycloid - Clear environment when the project changes')


# --------------------------------------------------------------------------
# Service Portal
# --------------------------------------------------------------------------

def widget(widget_id, name, description):
    base = os.path.join('widgets', widget_id)
    sys_id = sid('widget/' + widget_id)
    option_schema = json.dumps(json.load(open(os.path.join(SRC, base, 'option_schema.json'))))
    record('sp_widget', sys_id, {
        'category': 'custom', 'client_script': Script(read(base, 'client_script.js')),
        'controller_as': 'c', 'css': Script(read(base, 'style.css')), 'data_table': 'sp_instance',
        'demo_data': None, 'description': description, 'docs': None, 'field_list': None,
        'has_preview': False, 'id': widget_id, 'internal': False,
        'link': Script('function link(scope, element, attrs, controller) {\n}'), 'name': name,
        'option_schema': Script(option_schema), 'public': False, 'roles': None,
        'script': Script(read(base, 'server_script.js')), 'servicenow': False, 'sys_name': name,
        'template': Script(read(base, 'template.html')),
    }, target=name)
    return sys_id


def build_portal():
    catalog_widget = widget('cycloid_catalog', 'Cycloid Services',
                            'Lists the Cycloid services and sends the user to the Cycloid console.')
    deployments_widget = widget('cycloid_my_deployments', 'My Cycloid Deployments',
                                'Cycloid deployments requested by the current user and their status.')
    delete_record('sp_widget', V1_WIDGET_ID, 'Cycloid Stacks (v1)')

    page = record('sp_page', sid('page/cycloid'), {
        'category': 'custom', 'css': None, 'draft': False, 'dynamic_title_structure': None,
        'human_readable_page_id': None, 'id': 'cycloid', 'internal': False, 'omit_watcher': False,
        'public': False, 'roles': None, 'seo_script': None, 'short_description':
            'Deploy Cycloid services and follow their status', 'sys_name': 'cycloid',
        'title': 'Cycloid services', 'use_seo_script': False,
    }, target='cycloid')
    container = record('sp_container', sid('page/cycloid/container'), {
        'background_color': None, 'background_image': None, 'background_style': 'default',
        'bootstrap_alt': False, 'class_name': None, 'container_class_name': None, 'name': 'Cycloid',
        'order': '1', 'semantic_tag': 'main', 'sp_page': Ref(page, 'cycloid'), 'subheader': False,
        'sys_name': 'Cycloid', 'title': None, 'width': 'container',
    }, target='Cycloid container')
    row = record('sp_row', sid('page/cycloid/row'), {
        'class_name': None, 'order': '1', 'semantic_tag': None, 'sp_column': None,
        'sp_container': Ref(container, 'Cycloid'), 'sys_name': 'Cycloid row',
    }, target='Cycloid row')
    for key, size, order, widget_sys_id, title in [
        ('catalog', '8', '1', catalog_widget, 'Cycloid services'),
        ('deployments', '4', '2', deployments_widget, 'My Cycloid deployments'),
    ]:
        column = record('sp_column', sid('page/cycloid/column/' + key), {
            'class_name': None, 'order': order, 'semantic_tag': None, 'size': size, 'size_lg': None,
            'size_sm': '12', 'size_xs': '12', 'sp_row': Ref(row, 'Cycloid row'),
            'sys_name': 'Cycloid column ' + key,
        }, target='Cycloid column ' + key)
        record('sp_instance', sid('page/cycloid/instance/' + key), {
            'active': True, 'async_load': False, 'class_name': None, 'color': 'default', 'css': None,
            'glyph': None, 'id': None, 'order': '1', 'preserve_placeholder_size': False, 'roles': None,
            'short_description': None, 'size': 'md', 'sp_column': Ref(column, 'Cycloid column ' + key),
            'sp_widget': Ref(widget_sys_id, title), 'sys_class_name': 'sp_instance', 'title': title,
            'url': None, 'widget_parameters': None, 'sys_name': title,
        }, target=title)


# --------------------------------------------------------------------------
# Navigation
# --------------------------------------------------------------------------

def build_navigation():
    app_menu = record('sys_app_application', sid('menu'), {
        'active': True, 'category': None, 'description': 'Cycloid connector', 'device_type': 'browser',
        'hint': 'Cycloid connector', 'name': 'cycloid', 'order': '500',
        'roles': ADMIN_ROLE[1], 'sys_name': 'Cycloid', 'title': 'Cycloid',
    }, target='Cycloid')
    modules = [
        ('configuration', 'Configuration', 'LIST', T_CONFIG, None, '100'),
        ('stacks', 'Stacks (catalog items)', 'LIST', T_STACK, None, '200'),
        ('projects', 'Projects', 'LIST', T_PROJECT, None, '300'),
        ('environments', 'Environments', 'LIST', T_ENV, None, '400'),
        ('deployments', 'Deployments', 'LIST', T_DEPLOY, None, '500'),
        ('portal', 'Service Portal page', 'DIRECT', None, 'sp?id=cycloid', '600'),
    ]
    for key, title, link_type, table_name, query, order in modules:
        record('sys_app_module', sid('module/' + key), {
            'active': True, 'application': Ref(app_menu, 'Cycloid'), 'assessment': None,
            'device_type': 'browser', 'filter': None, 'hint': None, 'link_type': link_type,
            'map_page': None, 'mobile_title': None, 'mobile_view_name': None, 'name': table_name,
            'order': order, 'override_menu_roles': False, 'query': query, 'report': None,
            'roles': ADMIN_ROLE[1], 'sys_name': title, 'timeline_page': None, 'title': title,
            'uncancelable': False, 'view_name': None, 'window_name': '_blank' if query else None,
        }, target=title)


# --------------------------------------------------------------------------
# Base records (v1) and update set wrapper
# --------------------------------------------------------------------------

def base_updates():
    """v1 records kept as-is (the sys_app record gets the new version)."""
    result = []
    for path in sorted(glob.glob(os.path.join(BASE, '*.xml'))):
        payload = open(path, encoding='utf-8').read()
        m = re.search(r'<sys_update_name>([^<]+)</sys_update_name>', payload)
        name = m.group(1) if m else os.path.basename(path)[:-4]
        m = re.search(r'<record_update[^>]*table="([^"]+)"', payload)
        tname = m.group(1) if m else re.search(r'<record_update>\s*<([a-z_0-9]+)', payload).group(1)
        if tname == 'sys_app':
            payload = re.sub(r'<version>[^<]*</version>', '<version>%s</version>' % VERSION, payload)
            payload = re.sub(r'<short_description/>',
                             '<short_description>Cycloid self-service from the ServiceNow portal</short_description>',
                             payload)
        target = os.path.basename(path)[:-4]
        target_table = None
        if tname in ('sys_dictionary', 'sys_documentation', 'sys_ui_section', 'sys_ui_form_sections'):
            m = re.search(r'<%s [^>]*table="([^"]+)"' % tname, payload)
            target_table = m.group(1) if m else None
        result.append(Update(name, tname, payload, target, target_table=target_table))
    # the application record goes first
    result.sort(key=lambda u: 0 if u.table == 'sys_app' else 1)
    return result


TYPE_NAMES = {
    'sys_app': 'Application', 'sys_db_object': 'Table', 'sys_dictionary': 'Dictionary',
    'sys_documentation': 'Field Label', 'sys_script_include': 'Script Include', 'sys_script': 'Business Rule',
    'sysauto_script': 'Scheduled Script Execution', 'sys_ui_action': 'UI Action', 'sp_widget': 'Widget',
    'sp_page': 'Page', 'sp_container': 'Container', 'sp_row': 'Row', 'sp_column': 'Column',
    'sp_instance': 'Instance', 'sys_security_acl': 'Access Control', 'sys_security_acl_role':
        'Access Roles', 'sys_scope_privilege': 'Cross scope privilege', 'item_option_new': 'Variable',
    'item_option_new_set': 'Variable Set', 'catalog_script_client': 'Catalog Client Script',
    'sys_ui_section': 'Form Sections', 'sys_ui_form_sections': 'Form Sections', 'sys_user_role': 'Role',
    'sys_app_application': 'Application Menu', 'sys_app_module': 'Module',
}


def write_update_set(updates):
    remote_id = sid('remote_update_set/' + VERSION)
    set_name = 'Cycloid connector v%s' % VERSION
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<unload unload_date="%s">' % STAMP]
    out.append('\n'.join([
        '<sys_remote_update_set action="INSERT_OR_UPDATE">',
        element('application', Ref(APP_ID, APP_NAME), '    '),
        element('application_name', APP_NAME, '    '),
        element('application_scope', SCOPE, '    '),
        element('application_version', VERSION, '    '),
        '    <collisions/>', '    <commit_date/>', '    <deleted/>',
        element('description', 'Cycloid connector v%s: stacks catalog, project/environment selection, '
                               'redirection to the Cycloid console and pipeline status tracking.' % VERSION, '    '),
        '    <inserted/>',
        element('name', set_name, '    '),
        '    <origin_sys_id/>', '    <parent display_value=""/>', '    <release_date/>',
        '    <remote_base_update_set display_value=""/>', '    <remote_parent_id/>',
        element('remote_sys_id', remote_id, '    '),
        element('state', 'loaded', '    '),
        element('summary', None, '    '),
        element('sys_class_name', 'sys_remote_update_set', '    '),
        element('sys_created_by', AUTHOR, '    '), element('sys_created_on', STAMP, '    '),
        element('sys_id', remote_id, '    '), element('sys_mod_count', '0', '    '),
        element('sys_updated_by', AUTHOR, '    '), element('sys_updated_on', STAMP, '    '),
        '    <update_set display_value=""/>', '    <update_source display_value=""/>', '    <updated/>',
        '</sys_remote_update_set>']))

    recorded = 0x19a0000000
    for i, u in enumerate(updates):
        out.append('\n'.join([
            '<sys_update_xml action="INSERT_OR_UPDATE">',
            element('action', u.action, '    '),
            element('application', Ref(APP_ID, APP_NAME), '    '),
            element('category', 'customer', '    '),
            element('comments', None, '    '),
            element('name', u.name, '    '),
            element('payload', u.payload, '    '),
            element('payload_hash', None, '    '),
            element('remote_update_set', Ref(remote_id, set_name), '    '),
            element('replace_on_upgrade', 'false', '    '),
            element('sys_created_by', AUTHOR, '    '), element('sys_created_on', STAMP, '    '),
            element('sys_id', sid('update_xml/' + u.name), '    '),
            element('sys_mod_count', '0', '    '),
            element('sys_recorded_at', '%x%07x' % (recorded, i + 1), '    '),
            element('sys_updated_by', AUTHOR, '    '), element('sys_updated_on', STAMP, '    '),
            element('table', u.target_table, '    '),
            element('target_name', u.target, '    '),
            element('type', TYPE_NAMES.get(u.table, u.table), '    '),
            element('update_domain', 'global', '    '),
            element('update_guid', sid('guid/' + u.name), '    '),
            element('update_guid_history', sid('guid/' + u.name) + ':0', '    '),
            '    <update_set display_value=""/>',
            '    <view/>',
            '</sys_update_xml>']))
    out.append('</unload>')

    os.makedirs(DIST, exist_ok=True)
    path = os.path.join(DIST, 'cycloid-servicenow-connector-v%s.xml' % VERSION)
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out) + '\n')
    return path


def main():
    del UPDATES[:]
    build_tables()
    build_forms()
    build_security()
    build_logic()
    build_catalog()
    build_portal()
    build_navigation()
    updates = base_updates() + UPDATES
    names = [u.name for u in updates]
    duplicates = sorted(set(n for n in names if names.count(n) > 1))
    if duplicates:
        sys.exit('Duplicate update names: %s' % ', '.join(duplicates))
    path = write_update_set(updates)
    print('%s (%d records)' % (os.path.relpath(path, ROOT), len(updates)))
    return path


if __name__ == '__main__':
    main()
