'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, cleanup } = require('./harness');

const { SonarCloudClient, SonarCloudError, getRetryDelayMs } = load('client');

test.afterEach(() => cleanup());

// Pass null to mean "not configured" — undefined would hit the defaults below.
function client({ token = 'tok', organization = 'org' } = {}) {
    return new SonarCloudClient(
        () => Promise.resolve(token ?? undefined),
        () => organization ?? undefined
    );
}

/** Swap global fetch for a scripted sequence of responses. */
function withFetch(responses) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        const next = responses[Math.min(calls.length - 1, responses.length - 1)];
        if (next instanceof Error) {
            throw next;
        }
        return {
            ok: next.status >= 200 && next.status < 300,
            status: next.status,
            headers: { get: name => (next.headers ? next.headers[name.toLowerCase()] : undefined) ?? null },
            json: async () => JSON.parse(next.body ?? '{}'),
            text: async () => next.body ?? ''
        };
    };
    return { calls, restore: () => (globalThis.fetch = original) };
}

test('retry delay honours Retry-After but never blocks for minutes', () => {
    assert.equal(getRetryDelayMs('2', 1), 2000);
    assert.equal(getRetryDelayMs('3600', 1), 15000, 'a one-hour Retry-After must be clamped');
    assert.equal(getRetryDelayMs(null, 1), 1000);
    assert.equal(getRetryDelayMs(null, 3), 3000);
    assert.equal(getRetryDelayMs(null, 99), 15000, 'backoff is clamped too');
    assert.equal(getRetryDelayMs('not-a-number', 2), 2000, 'garbage headers fall back to backoff');
});

test('a missing token fails before any request is made', async () => {
    const fetchStub = withFetch([{ status: 200, body: '{}' }]);
    try {
        await assert.rejects(() => client({ token: null }).listProjects(), SonarCloudError);
        assert.equal(fetchStub.calls.length, 0);
    } finally {
        fetchStub.restore();
    }
});

test('a missing organization is reported as configuration, not a network error', () => {
    assert.throws(() => client({ organization: null }).organization(), /Set Organization/);
});

test('401 is translated into token guidance', async () => {
    const fetchStub = withFetch([{ status: 401, body: '{}' }]);
    try {
        await assert.rejects(() => client().listProjects(), error => {
            assert.match(error.message, /rejected the API token/);
            assert.equal(error.status, 401);
            return true;
        });
    } finally {
        fetchStub.restore();
    }
});

test('server error messages are surfaced verbatim', async () => {
    const fetchStub = withFetch([{ status: 404, body: '{"errors":[{"msg":"No organizationDto for key"}]}' }]);
    try {
        await assert.rejects(() => client().listProjects(), /No organizationDto for key/);
    } finally {
        fetchStub.restore();
    }
});

test('GET retries a transient failure and then succeeds', async () => {
    const fetchStub = withFetch([
        { status: 503, body: '{}', headers: { 'retry-after': '0' } },
        { status: 200, body: '{"components":[{"key":"k","name":"n"}],"paging":{"total":1}}' }
    ]);
    try {
        const { projects, total } = await client().listProjects();
        assert.equal(fetchStub.calls.length, 2, 'the first attempt was retried');
        assert.deepEqual(projects, [{ key: 'k', name: 'n' }]);
        assert.equal(total, 1);
    } finally {
        fetchStub.restore();
    }
});

test('POST is never retried — it is not idempotent', async () => {
    const fetchStub = withFetch([{ status: 503, body: '{}' }]);
    try {
        await assert.rejects(() => client().assignIssue('issue-1', 'someone'));
        assert.equal(fetchStub.calls.length, 1);
        assert.equal(fetchStub.calls[0].init.method, 'POST');
    } finally {
        fetchStub.restore();
    }
});

test('POST sends form-encoded parameters in the body, not the query string', async () => {
    const fetchStub = withFetch([{ status: 200, body: '' }]);
    try {
        await client().addIssueComment('issue-1', 'a comment');
        const { url, init } = fetchStub.calls[0];
        assert.ok(!url.includes('?'), 'parameters must not leak into the URL');
        assert.match(init.headers['Content-Type'], /x-www-form-urlencoded/);
        assert.match(init.body, /issue=issue-1/);
        assert.match(init.body, /text=a\+comment/);
    } finally {
        fetchStub.restore();
    }
});

test('an empty POST response body does not break JSON handling', async () => {
    const fetchStub = withFetch([{ status: 200, body: '' }]);
    try {
        await client().transitionIssue('issue-1', 'wontfix');
    } finally {
        fetchStub.restore();
    }
});

test('the token is sent as HTTP basic auth', async () => {
    const fetchStub = withFetch([{ status: 200, body: '{"rule":{"key":"k","name":"n"}}' }]);
    try {
        await client({ token: 'secret-token' }).getRule('typescript:S1481');
        const header = fetchStub.calls[0].init.headers.Authorization;
        assert.equal(header, 'Basic ' + Buffer.from('secret-token:').toString('base64'));
    } finally {
        fetchStub.restore();
    }
});

test('network failures are reported as unreachable, not as HTTP errors', async () => {
    const fetchStub = withFetch([new Error('getaddrinfo ENOTFOUND')]);
    try {
        await assert.rejects(() => client().getRule('x'), /Could not reach SonarCloud/);
    } finally {
        fetchStub.restore();
    }
});

test('measures read new-code values from the period payload', async () => {
    const fetchStub = withFetch([
        {
            status: 200,
            body: JSON.stringify({
                component: {
                    measures: [
                        { metric: 'coverage', value: '81.2' },
                        { metric: 'new_coverage', period: { value: '92.5' } },
                        { metric: 'new_bugs', periods: [{ value: '3' }] }
                    ]
                }
            })
        }
    ]);
    try {
        const measures = await client().getMeasures('proj', undefined, ['coverage', 'new_coverage', 'new_bugs']);
        assert.equal(measures.get('coverage'), '81.2');
        assert.equal(measures.get('new_coverage'), '92.5');
        assert.equal(measures.get('new_bugs'), '3');
    } finally {
        fetchStub.restore();
    }
});

test('issue and project URLs carry the branch when one is selected', () => {
    const api = client();
    const issue = { key: 'AX1', project: 'proj', rule: 'r', severity: 'MAJOR', component: 'c', message: 'm', type: 'BUG', status: 'OPEN' };
    assert.equal(
        api.issueUrl(issue, 'feature/x'),
        'https://sonarcloud.io/project/issues?id=proj&open=AX1&branch=feature%2Fx'
    );
    assert.ok(!api.issueUrl(issue).includes('branch='));
    assert.match(api.projectUrl('a b'), /id=a%20b/);
});

test('every request carries a timeout, so a stalled connection cannot hang a view', async () => {
    // Without one, fetch waits forever: the tree spins, the generation guard
    // never fires, and nothing ever tells the user why.
    const fetchStub = withFetch([{ status: 200, body: '{"components":[],"paging":{"total":0}}' }]);
    try {
        await client().listProjects();
        const signal = fetchStub.calls[0].init.signal;
        assert.ok(signal, 'no abort signal was attached');
        assert.equal(typeof signal.aborted, 'boolean');
    } finally {
        fetchStub.restore();
    }
});

test('a timed-out request says so in words a user can act on', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchStub = withFetch([timeout]);
    try {
        await assert.rejects(() => client().listProjects(), /no response within 30s/);
        assert.equal(fetchStub.calls.length, 3, 'a stall is transient, so a GET still retries');
    } finally {
        fetchStub.restore();
    }
});
