import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

/**
 * =====================================================================
 * LOAD TEST: the participant journey under concurrency
 *
 * The brief specifies roughly 4,000 participants. This script exists so
 * the scalability section of the report cites measurements rather than
 * assertions.
 *
 * Run it:
 *   k6 run --vus 50 --duration 2m server/load/participant-journey.js
 *
 * Against a deployed instance:
 *   k6 run -e BASE_URL=https://ycp-api.onrender.com --vus 200 \
 *          --duration 5m server/load/participant-journey.js
 *
 * READ THIS BEFORE QUOTING THE RESULTS.
 *
 * Virtual users are not people. 4,000 registered participants do not
 * produce 4,000 concurrent requests: on a learning platform, peak
 * concurrency is typically 2 to 5 percent of the registered population.
 * So 100 to 200 VUs is the honest model of 4,000 participants, and
 * running 4,000 VUs would test a scenario that will never occur while
 * making the numbers look worse than reality.
 *
 * State that reasoning in the report. A committee will respect a
 * defended model far more than a big number with no justification.
 * =====================================================================
 */

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const PASSWORD = __ENV.PASSWORD || 'YcpDemo2026!';

const ACCOUNTS = [
  'amina@ycp.africa',
  'kwame@ycp.africa',
  'joseph@ycp.africa'
];

// Custom metrics, so the report can separate cheap calls from expensive
// ones instead of quoting one meaningless average across all endpoints.
const discoveryTime = new Trend('discovery_duration', true);
const dashboardTime = new Trend('dashboard_duration', true);
const revalidated = new Rate('served_from_cache_304');
const bytesTransferred = new Counter('response_bytes');

export const options = {
  scenarios: {
    steady: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },   // warm up
        { duration: '2m', target: 50 },    // sustained load
        { duration: '30s', target: 150 },  // spike, a cohort starting together
        { duration: '1m', target: 150 },
        { duration: '30s', target: 0 }     // drain
      ],
      gracefulRampDown: '20s'
    }
  },

  /**
   * Thresholds are the pass/fail criteria. A load test without them
   * produces graphs nobody can interpret. These are the numbers to put
   * in the report as the performance requirement.
   */
  thresholds: {
    http_req_failed: ['rate<0.01'],                    // under 1% errors
    http_req_duration: ['p(95)<800', 'p(99)<2000'],    // 95th under 800ms
    discovery_duration: ['p(95)<600'],
    dashboard_duration: ['p(95)<900'],
    checks: ['rate>0.99']
  }
};

export function setup() {
  // Confirm the target is alive before spending five minutes on it.
  const health = http.get(`${BASE}/api/health`);
  if (health.status !== 200) {
    throw new Error(`Target not healthy at ${BASE}: ${health.status}`);
  }
  return { base: BASE };
}

export default function (data) {
  const email = ACCOUNTS[__VU % ACCOUNTS.length];
  let token;

  group('sign in', () => {
    const response = http.post(
      `${data.base}/api/auth/login`,
      JSON.stringify({ email, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } }
    );

    check(response, {
      'signed in': (r) => r.status === 200,
      'token issued': (r) => Boolean(r.json('accessToken'))
    });

    token = response.json('accessToken');
    bytesTransferred.add(response.body ? response.body.length : 0);
  });

  if (!token) return;

  const auth = { Authorization: `Bearer ${token}` };

  let etag;

  group('discover activities', () => {
    const response = http.get(`${data.base}/api/activities?limit=20`, {
      headers: auth,
      tags: { name: 'discovery' }
    });

    check(response, { 'catalogue returned': (r) => r.status === 200 });
    discoveryTime.add(response.timings.duration);
    bytesTransferred.add(response.body ? response.body.length : 0);
    etag = response.headers['Etag'];
  });

  sleep(1 + Math.random());

  /**
   * The behaviour the brief's incident describes: a participant
   * refreshing repeatedly. With conditional requests this should cost
   * a 304 and no body. The revalidation rate is the headline metric for
   * the bandwidth section of the report.
   */
  group('refresh the same page', () => {
    for (let i = 0; i < 3; i += 1) {
      const response = http.get(`${data.base}/api/activities?limit=20`, {
        headers: { ...auth, 'If-None-Match': etag },
        tags: { name: 'revalidate' }
      });

      revalidated.add(response.status === 304);
      bytesTransferred.add(response.body ? response.body.length : 0);
      check(response, { 'revalidated or fresh': (r) => r.status === 304 || r.status === 200 });
      sleep(0.3);
    }
  });

  group('open the progress dashboard', () => {
    const response = http.get(`${data.base}/api/me/progress`, {
      headers: auth,
      tags: { name: 'dashboard' }
    });

    check(response, {
      'dashboard returned': (r) => r.status === 200,
      'aggregates present': (r) => r.json('summary') !== undefined
    });
    dashboardTime.add(response.timings.duration);
    bytesTransferred.add(response.body ? response.body.length : 0);
  });

  sleep(2 + Math.random() * 3);
}

export function handleSummary(data) {
  const metric = (name, stat) => {
    const value = data.metrics[name]?.values?.[stat];
    return value === undefined ? 'n/a' : value.toFixed(1);
  };

  const cacheRate = data.metrics.served_from_cache_304?.values?.rate ?? 0;
  const totalBytes = data.metrics.response_bytes?.values?.count ?? 0;

  const report = `
YCP load test summary
=====================

Requests            ${data.metrics.http_reqs?.values?.count ?? 0}
Failure rate        ${((data.metrics.http_req_failed?.values?.rate ?? 0) * 100).toFixed(2)}%
Peak virtual users  ${data.metrics.vus_max?.values?.max ?? 0}

Latency (ms)
  median            ${metric('http_req_duration', 'med')}
  95th percentile   ${metric('http_req_duration', 'p(95)')}
  99th percentile   ${metric('http_req_duration', 'p(99)')}

By endpoint (95th percentile, ms)
  discovery         ${metric('discovery_duration', 'p(95)')}
  dashboard         ${metric('dashboard_duration', 'p(95)')}

Bandwidth
  revalidated (304) ${(cacheRate * 100).toFixed(1)}% of refreshes
  total transferred ${(totalBytes / 1024 / 1024).toFixed(2)} MB

Paste these into the evaluation chapter. Record the date, the target
(local or deployed) and the VU count alongside them: a number without
its conditions is not evidence.
`;

  return {
    stdout: report,
    'load-summary.json': JSON.stringify(data, null, 2)
  };
}
