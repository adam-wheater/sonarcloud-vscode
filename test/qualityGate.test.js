'use strict';

/**
 * Why the quality gate failed. The whole point is to save a trip to the web
 * UI, so a condition that is described vaguely — or with the comparison the
 * wrong way round — is worse than not showing it at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, cleanup } = require('./harness');

const {
    describeCondition,
    failingConditions,
    formatMetricValue,
    metricLabel,
    summariseFailures
} = load('qualityGate');
const { SonarCloudClient } = load('client');

test.afterEach(() => cleanup());

function condition(overrides = {}) {
    return {
        metricKey: 'new_coverage',
        comparator: 'LT',
        errorThreshold: '80',
        actualValue: '42.35',
        status: 'ERROR',
        periodIndex: 1,
        ...overrides
    };
}

test('new-code metrics are named as such', () => {
    assert.equal(metricLabel('new_coverage'), 'Coverage on New Code');
    assert.equal(metricLabel('coverage'), 'Coverage');
    assert.equal(metricLabel('new_duplicated_lines_density'), 'Duplicated Lines on New Code');
});

test('an unknown metric is humanised rather than dropped', () => {
    // SonarCloud adds metrics; an unmapped key must still be readable.
    assert.equal(metricLabel('new_pull_request_thing'), 'Pull Request Thing on New Code');
    assert.equal(metricLabel('mystery'), 'Mystery');
});

test('values are formatted the way the metric means them', () => {
    assert.equal(formatMetricValue('new_coverage', '42.35'), '42.4%');
    assert.equal(formatMetricValue('security_rating', '4'), 'D');
    assert.equal(formatMetricValue('bugs', '1234'), '1,234');
    assert.equal(formatMetricValue('new_coverage', undefined), '—');
});

test('the requirement is the inverse of the failing comparison', () => {
    // SonarCloud states the condition that *fails*; showing that verbatim
    // ("coverage GT 80") tells you the opposite of what you must do.
    assert.equal(
        describeCondition(condition()),
        'Coverage on New Code is 42.4%, required ≥ 80.0%',
        'LT fails below, so the requirement is at least'
    );
    assert.equal(
        describeCondition(condition({ metricKey: 'new_bugs', comparator: 'GT', errorThreshold: '0', actualValue: '3' })),
        'Bugs on New Code is 3, required ≤ 0'
    );
});

test('a condition that was never measured says so instead of showing a dash', () => {
    const described = describeCondition(condition({ status: 'NO_VALUE', actualValue: undefined }));
    assert.match(described, /was not measured/);
    assert.match(described, /required ≥ 80\.0%/);
});

test('only the failing conditions are surfaced', () => {
    const status = {
        status: 'ERROR',
        conditions: [condition(), condition({ metricKey: 'new_bugs', status: 'OK' })]
    };
    assert.deepEqual(
        failingConditions(status).map(c => c.metricKey),
        ['new_coverage'],
        'a list of everything that passed is noise on a failure'
    );
    assert.deepEqual(failingConditions(undefined), []);
    assert.equal(summariseFailures({ status: 'OK', conditions: [] }), undefined);
});

test('several failures are summarised in one line', () => {
    const summary = summariseFailures({
        status: 'ERROR',
        conditions: [condition(), condition({ metricKey: 'new_bugs', comparator: 'GT', errorThreshold: '0', actualValue: '2' })]
    });
    assert.match(summary, /Coverage on New Code is 42\.4%/);
    assert.match(summary, /Bugs on New Code is 2/);
});

// -------------------------------------------------------------- client ---

test('the project status response is mapped to conditions', async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async url => {
        calls.push(String(url));
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () =>
                JSON.stringify({
                    projectStatus: {
                        status: 'ERROR',
                        conditions: [
                            {
                                status: 'ERROR',
                                metricKey: 'new_coverage',
                                comparator: 'LT',
                                errorThreshold: '80',
                                actualValue: '42.35',
                                periodIndex: 1
                            }
                        ],
                        ignoredConditions: false
                    }
                })
        };
    };
    try {
        const client = new SonarCloudClient(
            async () => 'token',
            () => 'org'
        );
        const status = await client.getQualityGateStatus('proj', 'feature/x');
        assert.equal(status.status, 'ERROR');
        assert.equal(status.conditions.length, 1);
        assert.equal(describeCondition(status.conditions[0]), 'Coverage on New Code is 42.4%, required ≥ 80.0%');
        assert.match(calls[0], /qualitygates\/project_status/);
        assert.match(calls[0], /projectKey=proj/);
        assert.match(calls[0], /branch=feature%2Fx/, 'the branch matters — main can pass while yours fails');
    } finally {
        globalThis.fetch = original;
    }
});

test('a project with no quality gate reports none rather than throwing', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({})
    });
    try {
        const client = new SonarCloudClient(
            async () => 'token',
            () => 'org'
        );
        const status = await client.getQualityGateStatus('proj');
        assert.equal(status.status, 'NONE');
        assert.deepEqual(status.conditions, []);
    } finally {
        globalThis.fetch = original;
    }
});
