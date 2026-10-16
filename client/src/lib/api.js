/**
 * =====================================================================
 * THE API CLIENT
 *
 * Two responsibilities:
 *   1. Attach the access token, and transparently refresh it once on 401
 *   2. Queue writes made while offline and replay them on reconnect
 *
 * REMOVED BY REQUEST: this used to also cache GET responses by URL and
 * revalidate them with If-None-Match against a matching ETag on the
 * server (see git history / the earlier delivered zip if that behaviour
 * is ever wanted back). Every request now goes straight to the network
 * and returns whatever the server sends, full body, every time.
 * =====================================================================
 */

const BASE = import.meta.env.VITE_API_URL || '/api';

/* ------------------------------------------------------------------ */
/* Access token                                                        */
/* Held in memory, never in localStorage. A token in localStorage is    */
/* readable by any script on the page, so one XSS flaw becomes a full   */
/* account takeover. In memory it dies with the tab, and the httpOnly   */
/* refresh cookie restores the session on reload.                      */
/* ------------------------------------------------------------------ */

let accessToken = null;
const authListeners = new Set();

export function setAccessToken(token) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export function onAuthLost(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function announceAuthLost() {
  accessToken = null;
  for (const listener of authListeners) listener();
}

/* ------------------------------------------------------------------ */
/* Token refresh, with request coalescing                              */
/* ------------------------------------------------------------------ */

let refreshInFlight = null;

async function refreshAccessToken() {
  // If five requests 401 at once, only one refresh call should be made.
  // Without this, the rotating refresh token is consumed five times in
  // parallel and the server's reuse detection correctly revokes the
  // whole family, signing the user out for doing nothing wrong.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include'
      });
      if (!response.ok) return null;
      const data = await response.json();
      accessToken = data.accessToken;
      return data;
    } catch {
      return null;
    } finally {
      // Cleared on the next tick so concurrent callers all see the same
      // in-flight promise rather than starting a second refresh.
      setTimeout(() => { refreshInFlight = null; }, 0);
    }
  })();

  return refreshInFlight;
}

/* ------------------------------------------------------------------ */
/* Core request                                                        */
/* ------------------------------------------------------------------ */

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || 'Something went wrong.');
    this.status = status;
    // The verification endpoint answers "not valid" with a 404 and a
    // meaningful body. Keeping the payload lets a caller distinguish a
    // real answer from a transport failure.
    this.payload = payload;
    this.code = payload?.error?.code;
    this.details = payload?.error?.details;
    this.requestId = payload?.error?.requestId;
  }
}

async function request(path, { method = 'GET', body, retryOn401 = true, signal } = {}) {
  const url = `${BASE}${path}`;
  const headers = { Accept: 'application/json' };

  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    credentials: 'include',
    signal,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  if (response.status === 401 && retryOn401 && !path.startsWith('/auth/')) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request(path, { method, body, retryOn401: false, signal });
    announceAuthLost();
    throw new ApiError(401, { error: { code: 'UNAUTHENTICATED', message: 'Your session ended. Sign in again.' } });
  }

  const text = await response.text();
  const payload = text ? safeParse(text) : null;

  if (!response.ok) throw new ApiError(response.status, payload);

  return payload;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Offline write queue                                                 */
/*                                                                     */
/* REQ-NFR-006. A participant on an intermittent connection should not  */
/* lose work because the network dropped mid-tap. Writes that fail with */
/* a network error are queued in localStorage and replayed when the     */
/* browser reports it is back online.                                   */
/*                                                                     */
/* This only works because the server's progress endpoint is            */
/* idempotent: replaying the same write twice produces the same state.  */
/* Queueing non-idempotent writes would create duplicates.             */
/* ------------------------------------------------------------------ */

const QUEUE_KEY = 'ycp.queue.v1';
const QUEUEABLE = ['PUT'];

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(items) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-50)));
  } catch {
    // Storage full or blocked in private mode. Losing the queue is
    // acceptable; crashing the app is not.
  }
}

export function queuedCount() {
  return readQueue().length;
}

export async function flushQueue() {
  const items = readQueue();
  if (!items.length) return { flushed: 0, failed: 0 };

  const remaining = [];
  let flushed = 0;

  for (const item of items) {
    try {
      await request(item.path, { method: item.method, body: item.body });
      flushed += 1;
    } catch (error) {
      // 4xx means the server rejected it on its merits. Retrying will
      // never succeed, so drop it rather than looping forever.
      if (!(error instanceof ApiError)) remaining.push(item);
    }
  }

  writeQueue(remaining);
  return { flushed, failed: remaining.length };
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { flushQueue(); });
}

/* ------------------------------------------------------------------ */
/* Public surface, one function per endpoint                           */
/* ------------------------------------------------------------------ */

export const api = {
  // Auth
  register: (body) => request('/auth/register', { method: 'POST', body }),
  signIn: (body) => request('/auth/login', { method: 'POST', body }),
  signInWithGoogle: (credential) => request('/auth/google', { method: 'POST', body: { credential } }),
  signOut: () => request('/auth/logout', { method: 'POST' }),
  refresh: refreshAccessToken,
  me: () => request('/auth/me'),

  // Discovery and activities
  activities: (params = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== '' && value != null)
    ).toString();
    return request(`/activities${query ? `?${query}` : ''}`);
  },
  activity: (id) => request(`/activities/${id}`),
  enrol: (id) => request(`/activities/${id}/enrolments`, { method: 'POST' }),

  /**
   * Progress writes go through the queue-aware path. If the network is
   * down the write is stored and the UI proceeds optimistically, which
   * is what makes the app usable on an unreliable connection.
   */
  setModuleProgress: async (activityId, moduleId, body) => {
    const path = `/activities/${activityId}/modules/${moduleId}/progress`;
    try {
      return await request(path, { method: 'PUT', body });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const items = readQueue();
      items.push({ path, method: 'PUT', body, queuedAt: Date.now() });
      writeQueue(items);
      return { queued: true };
    }
  },

  // Discussion
  threads: (activityId) => request(`/activities/${activityId}/threads`),
  createThread: (activityId, body) =>
    request(`/activities/${activityId}/threads`, { method: 'POST', body }),
  reply: (threadId, body) =>
    request(`/threads/${threadId}/posts`, { method: 'POST', body }),
  itemComments: (itemId) => request(`/items/${itemId}/comments`),
  postItemComment: (itemId, body) =>
    request(`/items/${itemId}/comments`, { method: 'POST', body: { body } }),

  // Assessment
  assessment: (id) => request(`/assessments/${id}`),
  checkAnswer: (id, questionId, selected) =>
    request(`/assessments/${id}/questions/${questionId}/check`, { method: 'POST', body: { selected } }),
  submit: (id, body) => request(`/assessments/${id}/submissions`, { method: 'POST', body }),
  feedback: (submissionId) => request(`/assessments/submissions/${submissionId}/feedback`),
  // Marking feedback read is an explicit action, not a side effect of
  // fetching it: a GET that changes state breaks its own ETag. See the
  // note in server/src/routes/assessment.routes.js.
  markFeedbackRead: (submissionId) =>
    request(`/assessments/submissions/${submissionId}/feedback/read`, { method: 'POST' }),

  // Public catalogue. No token is attached by request(): these work
  // signed out, which is the point of them.
  courses: () => request('/courses'),
  course: (slug) => request(`/courses/${encodeURIComponent(slug)}`),

  // Pacing and grades
  schedule: (activityId) => request(`/activities/${activityId}/schedule`),
  resetSchedule: (activityId) =>
    request(`/activities/${activityId}/schedule/reset`, { method: 'POST' }),
  grades: (activityId) => request(`/activities/${activityId}/grades`),
  updateModuleMeta: (activityId, moduleId, body) =>
    request(`/activities/${activityId}/modules/${moduleId}/meta`, { method: 'PATCH', body }),

  // Certificates
  myCertificates: () => request('/me/certificates'),
  claimCertificate: (activityId) =>
    request(`/activities/${activityId}/certificate`, { method: 'POST' }),
  verifyCertificate: (code) => request(`/verify/${encodeURIComponent(code)}`),

  // Facilitator
  facilitatorActivities: () => request('/facilitator/activities'),
  createActivity: (body) => request('/activities', { method: 'POST', body }),
  updateActivity: (id, body) => request(`/activities/${id}`, { method: 'PATCH', body }),
  createModule: (activityId, body) =>
    request(`/activities/${activityId}/modules`, { method: 'POST', body }),
  updateModule: (activityId, moduleId, body) =>
    request(`/activities/${activityId}/modules/${moduleId}`, { method: 'PATCH', body }),
  deleteModule: (activityId, moduleId) =>
    request(`/activities/${activityId}/modules/${moduleId}`, { method: 'DELETE' }),
  // Course structure
  createItem: (activityId, moduleId, body) =>
    request(`/activities/${activityId}/modules/${moduleId}/items`, { method: 'POST', body }),
  updateItem: (activityId, itemId, body) =>
    request(`/activities/${activityId}/items/${itemId}`, { method: 'PATCH', body }),
  deleteItem: (activityId, itemId) =>
    request(`/activities/${activityId}/items/${itemId}`, { method: 'DELETE' }),
  uploadMaterial: (activityId, itemId, body) =>
    request(`/activities/${activityId}/items/${itemId}/materials`, { method: 'POST', body }),
  deleteMaterial: (activityId, materialId) =>
    request(`/activities/${activityId}/materials/${materialId}`, { method: 'DELETE' }),
  setItemProgress: async (activityId, itemId, body) => {
    const path = `/activities/${activityId}/items/${itemId}/progress`;
    try {
      return await request(path, { method: 'PUT', body });
    } catch (error) {
      // Same offline queue as module progress: the endpoint is
      // idempotent, so replaying it is safe.
      if (error instanceof ApiError) throw error;
      const items = JSON.parse(localStorage.getItem('ycp.queue.v1') || '[]');
      items.push({ path, method: 'PUT', body, queuedAt: Date.now() });
      localStorage.setItem('ycp.queue.v1', JSON.stringify(items.slice(-50)));
      return { queued: true };
    }
  },

  activityAssessments: (activityId) => request(`/activities/${activityId}/assessments`),
  createAssessment: (activityId, body) =>
    request(`/activities/${activityId}/assessments`, { method: 'POST', body }),
  updateAssessment: (activityId, assessmentId, body) =>
    request(`/activities/${activityId}/assessments/${assessmentId}`, { method: 'PATCH', body }),
  activitySubmissions: (activityId) => request(`/activities/${activityId}/submissions`),
  activityParticipants: (activityId) => request(`/activities/${activityId}/participants`),
  giveFeedback: (submissionId, body) =>
    request(`/assessments/submissions/${submissionId}/feedback`, { method: 'POST', body }),

  // Admin
  adminOverview: () => request('/admin/overview'),
  adminUsers: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== '' && value != null)
    ).toString();
    return request(`/admin/users${qs ? `?${qs}` : ''}`);
  },
  adminUpdateUser: (id, body) => request(`/admin/users/${id}`, { method: 'PATCH', body }),
  adminSecurity: () => request('/admin/security'),
  adminReports: () => request('/admin/reports'),

  // Account
  disciplines: () => request('/disciplines'),
  changePassword: (body) => request('/auth/password', { method: 'POST', body }),
  uploadAvatar: (userId, base64) =>
    request(`/profiles/${userId}/avatar`, { method: 'PUT', body: { data: base64 } }),
  deleteAvatar: (userId) => request(`/profiles/${userId}/avatar`, { method: 'DELETE' }),

  // Profile and progress
  profile: (id) => request(`/profiles/${id}`),
  updateProfile: (id, body) => request(`/profiles/${id}`, { method: 'PATCH', body }),
  progress: () => request('/me/progress'),
  notifications: () => request('/me/notifications'),
  markNotificationsRead: () => request('/me/notifications/read', { method: 'POST' })
};

export { QUEUEABLE };
