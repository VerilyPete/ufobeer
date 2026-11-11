/**
 * The committed Grafana dashboard (dashboards/usage.json) against the
 * GET /reports/usage contract: every query names a real view, reads only
 * fields that view returns, uses Infinity's backend parser (Grafana alerting
 * needs it), and carries no credential. Credentials live in the data source's
 * secure headers, never in the dashboard.
 */

import { describe, it, expect } from 'vitest';
import dashboard from '../../dashboards/usage.json';
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
