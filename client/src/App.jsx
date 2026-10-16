import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import SignIn from './pages/SignIn.jsx';
import { Loading } from './components/ui.jsx';

/**
 * Routes are lazy loaded so the first visit downloads the sign-in screen
 * and nothing else. A participant who never opens an assessment never
 * downloads the assessment code. On a metered connection that is the
 * difference between paying for what you use and paying for the whole
 * application up front.
 *
 * Register is eager because a new participant needs it immediately after
 * the sign-in screen and a second round trip there is a bad first
 * impression.
 */
const Register = lazy(() => import('./pages/Register.jsx'));
const Discover = lazy(() => import('./pages/Discover.jsx'));
const Activity = lazy(() => import('./pages/Activity.jsx'));
const Assessment = lazy(() => import('./pages/Assessment.jsx'));
const ProgressPage = lazy(() => import('./pages/ProgressPage.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));
const Manage = lazy(() => import('./pages/Manage.jsx'));
const ManageActivity = lazy(() => import('./pages/ManageActivity.jsx'));
const NewActivity = lazy(() => import('./pages/NewActivity.jsx'));
const Admin = lazy(() => import('./pages/Admin.jsx'));
const CoursePlayer = lazy(() => import('./pages/CoursePlayer.jsx'));
const CourseLanding = lazy(() => import('./pages/CourseLanding.jsx'));
const Certificates = lazy(() =>
  import('./pages/Certificates.jsx').then((m) => ({ default: m.Certificates })));
const Verify = lazy(() =>
  import('./pages/Certificates.jsx').then((m) => ({ default: m.Verify })));

/**
 * Route guard.
 *
 * This is a convenience, not a security control. It stops a signed-out
 * participant seeing an empty broken screen. It does NOT protect data:
 * every endpoint the page calls enforces its own authorisation server
 * side. Treating a client-side guard as protection is exactly the
 * mistake behind the URL-tampering incident in the brief.
 */
function RequireAuth({ children }) {
  const { user, restoring } = useAuth();
  const location = useLocation();

  if (restoring) return <div className="main"><Loading rows={2} label="Restoring your session" /></div>;
  if (!user) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  return children;
}

/**
 * Role gate for routes.
 *
 * Exactly the same caveat as RequireAuth: this stops someone seeing a
 * screen that would fail every request it makes. It is not a security
 * control. Anyone can edit the JavaScript; nobody can edit the server's
 * policy layer.
 */
function RequireRole({ roles, children }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function PublicOnly({ children }) {
  const { user, restoring } = useAuth();
  if (restoring) return <div className="main"><Loading rows={1} label="Loading" /></div>;
  if (user) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<div className="main"><Loading rows={2} /></div>}>
          <Routes>
            {/* Verification sits OUTSIDE the authenticated shell on
                purpose. An employer checking a printed certificate must
                not need an account, so this route is reachable signed
                in or out. */}
            {/* The course landing page is public for the same reason
                verification is: a catalogue nobody can browse without
                an account cannot be shared, and being shared is how
                this programme reaches people. See ADR-018. */}
            <Route path="/courses/:slug" element={<CourseLanding />} />

            <Route path="/verify" element={<Verify />} />
            <Route path="/verify/:code" element={<Verify />} />

            <Route path="/signin" element={<PublicOnly><SignIn /></PublicOnly>} />
            <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />

            {/* Layout itself no longer requires an account: the
                catalogue (the index route below) is the home page for
                everyone, signed in or not, same as Coursera's own
                homepage. Every other route nested here still requires
                one, asserted individually rather than once for the
                whole group. */}
            <Route element={<Layout />}>
              <Route index element={<Discover />} />
              <Route path="activities/:id" element={<RequireAuth><Activity /></RequireAuth>} />
              <Route path="learn/:id" element={<RequireAuth><CoursePlayer /></RequireAuth>} />
              <Route path="certificates" element={<RequireAuth><Certificates /></RequireAuth>} />
              <Route path="assessments/:id" element={<RequireAuth><Assessment /></RequireAuth>} />
              <Route path="progress" element={<RequireAuth><ProgressPage /></RequireAuth>} />
              <Route path="profile" element={<RequireAuth><Profile /></RequireAuth>} />

              {/* Role-gated routes. RequireRole is a convenience that
                  avoids showing an empty broken screen; the server
                  enforces the actual permission on every endpoint. */}
              <Route path="manage" element={
                <RequireRole roles={['facilitator', 'mentor', 'admin', 'super_admin']}><Manage /></RequireRole>
              } />
              {/* BEFORE manage/:id. React Router matches a static segment
                  ahead of a dynamic one, but the order is stated here
                  anyway because the failure it prevents was real: /manage/new
                  matched :id, the editor fetched /api/activities/new, and
                  the facilitator was told the page was not available to
                  them. There was no way to create a course in the
                  interface at all. */}
              <Route path="manage/new" element={
                <RequireRole roles={['facilitator', 'mentor', 'admin', 'super_admin']}><NewActivity /></RequireRole>
              } />
              <Route path="manage/:id" element={
                <RequireRole roles={['facilitator', 'mentor', 'admin', 'super_admin']}><ManageActivity /></RequireRole>
              } />
              <Route path="admin" element={
                <RequireRole roles={['admin', 'super_admin']}><Admin /></RequireRole>
              } />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
