/**
 * The committed Grafana dashboard (dashboards/usage.json) against the
 * GET /reports/usage contract: every query names a real view, reads only
 * fields that view returns, uses Infinity's backend parser (Grafana alerting
 * needs it), and carries no credential. Credentials live in the data source's
 * secure headers, never in the dashboard.
 */

import { describe, it, expect } from 'vitest';
import dashboard from '../../dashboards/usage.json';
import alerts from '../../dashboards/usage-alerts.json';
import { USAGE_REPORT_FIELDS } from '../../src/db/usage-report';
import { USAGE_REPORT_VIEWS, type UsageReportView } from '../../src/handlers/reports';

type Column = { selector: string; type: string };
type Param = { key: string; value: string };
type Target = {
  datasource: { type: string; uid: string };
  type: string;
  source: string;
  parser: string;
  url: string;
  url_options: { method: string; params: Param[] };
  columns: Column[];
  root_selector: string;
  filterExpression?: string;
};
type Panel = { title: string; targets?: Target[] };

const panels: readonly Panel[] = dashboard.panels;
const targets = panels.flatMap((panel) => (panel.targets ?? []).map((target) => ({ panel: panel.title, target })));

const isView = (value: string | undefined): value is UsageReportView =>
  USAGE_REPORT_VIEWS.some((view) => view === value);

const paramOf = (target: Target, key: string): string | undefined =>
  target.url_options.params.find((param) => param.key === key)?.value;

describe('dashboards/usage.json', () => {
  it('asks for the Infinity data source on import instead of naming one', () => {
    expect(dashboard.__inputs).toEqual([expect.objectContaining({
      name: 'DS_UFOBEER', type: 'datasource', pluginId: 'yesoreyeram-infinity-datasource',
    })]);
  });

  it('has the panels the plan lists', () => {
    expect(panels.map((panel) => panel.title)).toEqual([
      'Active installs and sessions',
      'Events per day',
      'Feature adoption',
      'App versions',
      'Apple Intelligence status',
      'Reports received and dropped',
      'Event entries dropped',
    ]);
  });

  it.each(targets)('$panel queries a real view through the backend parser', ({ target }) => {
    expect(target.datasource).toEqual({ type: 'yesoreyeram-infinity-datasource', uid: '${DS_UFOBEER}' });
    expect(target).toMatchObject({ type: 'json', source: 'url', parser: 'backend', url: '' });
    expect(target.url_options.method).toBe('GET');
    expect(isView(paramOf(target, 'view'))).toBe(true);
    expect(paramOf(target, 'from')).toBe('${__from}');
    expect(paramOf(target, 'to')).toBe('${__to}');
  });

  it.each(targets)('$panel reads only fields its view returns', ({ target }) => {
    const view = paramOf(target, 'view');
    const fields: readonly string[] = isView(view) ? USAGE_REPORT_FIELDS[view] : [];

    expect(target.columns.length).toBeGreaterThan(0);
    expect(target.columns.map((column) => column.selector).filter((selector) => !fields.includes(selector))).toEqual([]);
  });

  it.each(targets.filter(({ target }) => paramOf(target, 'view') === 'breakdown'))(
    '$panel filters on one breakdown dimension, through a column it selects',
    ({ target }) => {
      expect(target.columns.map((column) => column.selector)).toContain('dimension');
      expect(target.filterExpression).toMatch(/^dimension == '(app_version|ai_status|os_major)'$/);
    },
  );

  it.each(targets)('$panel reads every row of its view without a rows selector', ({ target }) => {
    expect(target.root_selector).toBe('');
  });

  it.each(targets.filter(({ target }) => paramOf(target, 'view') !== 'breakdown'))(
    '$panel does not filter its view',
    ({ target }) => {
      expect(target.filterExpression).toBeUndefined();
    },
  );

  it('carries no credential or header', () => {
    const text = JSON.stringify(dashboard);

    expect(text).not.toMatch(/authorization|x-api-key|bearer|secure/i);
  });
});

type AlertModel = {
  type: string;
  source?: string;
  parser?: string;
  url?: string;
  root_selector?: string;
  url_options?: { method: string; params: Param[] };
  columns?: Column[];
};
type AlertQuery = { refId: string; datasourceUid: string; relativeTimeRange?: { from: number; to: number }; model: AlertModel };
type AlertRule = { uid: string; title: string; condition: string; noDataState: string; execErrState: string; data: AlertQuery[]; notification_settings: { receiver: string } };

describe('dashboards/usage-alerts.json', () => {
  const rules: readonly AlertRule[] = alerts.rules;
  const queryOf = (rule: AlertRule) => rule.data.find((step) => step.datasourceUid !== '__expr__');
  const numberColumns = (rule: AlertRule) =>
    (queryOf(rule)?.model.columns ?? []).filter((column) => column.type === 'number').map((column) => column.selector);

  it('has the no-reports rule and one rule per drop counter, evaluated hourly', () => {
    expect(alerts.interval).toBe(3600);
    expect(rules.map((rule) => numberColumns(rule))).toEqual([
      ['posts'], ['dropped_post_cap'], ['dropped_new_install'], ['dropped_all_events'], ['dropped_events'],
    ]);
  });

  it.each(rules)('$title asks for the last complete UTC day through the backend parser', (rule) => {
    const query = queryOf(rule);

    expect(query?.datasourceUid).toBe('${DS_UFOBEER}');
    expect(query?.relativeTimeRange).toEqual({ from: 172800, to: 86400 });
    expect(query?.model).toMatchObject({ type: 'json', source: 'url', parser: 'backend', url: '', root_selector: '' });
    expect(query?.model.url_options?.params).toEqual([
      { key: 'view', value: 'daily' }, { key: 'from', value: '${__from}' }, { key: 'to', value: '${__to}' },
    ]);
  });

  it.each(rules)('$title reads one number the daily view returns, so each rule yields one series', (rule) => {
    const columns = numberColumns(rule);

    expect(columns).toHaveLength(1);
    expect(USAGE_REPORT_FIELDS.daily).toEqual(expect.arrayContaining(columns));
  });

  it.each(rules)('$title alerts on query errors and notifies the usage contact point', (rule) => {
    expect(rule.execErrState).toBe('Alerting');
    expect(rule.notification_settings.receiver).toBe('BeerSelector usage email');
  });

  it('treats missing data as an alert for reports, but as no drops before the counters existed', () => {
    expect(rules.map((rule) => rule.noDataState)).toEqual(['Alerting', 'OK', 'OK', 'OK', 'OK']);
  });

  it('carries no credential', () => {
    expect(JSON.stringify(alerts)).not.toMatch(/authorization|x-api-key|bearer|secure/i);
  });
});
