import { Link } from 'react-router-dom';
import { Brand } from './Brand.jsx';

/**
 * Coursera-style footer: a dense multi-column link block plus a base
 * bar with the wordmark and a copyright line.
 *
 * Used only on the pages a signed-out visitor can actually land on (the
 * course landing page, the way Coursera's own footer only appears on
 * its public pages, not inside the logged-in learning shell).
 */
export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-col">
          <h4>YouthConnect</h4>
          <ul>
            <li><Link to="/">Discover activities</Link></li>
            <li><Link to="/certificates">Certificates</Link></li>
            <li><Link to="/verify">Verify a certificate</Link></li>
          </ul>
        </div>
        <div className="site-footer-col">
          <h4>Community</h4>
          <ul>
            <li><Link to="/register">Join for free</Link></li>
            <li><Link to="/signin">Sign in</Link></li>
          </ul>
        </div>
        <div className="site-footer-col">
          <h4>About</h4>
          <ul>
            <li>Learning and collaboration for young people across East Africa</li>
          </ul>
        </div>
        <div className="site-footer-col">
          <h4>Built for low bandwidth</h4>
          <ul>
            <li>Every activity shows what it costs in data before you open it.</li>
          </ul>
        </div>
      </div>
      <div className="site-footer-base">
        <span className="site-footer-brand"><Brand size={22} /></span>
        <span>&copy; {year} YouthConnect Programme</span>
      </div>
    </footer>
  );
}
