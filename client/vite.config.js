import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * DESIGN DECISION (ADR-007): a client-rendered SPA, not server rendering.
 *
 * Alternatives considered:
 *   a) Server-side rendering (Next.js). Better first paint, but every
 *      navigation is a round trip. On a 3G connection with 300ms of
 *      latency, a user who opens five activities pays five round trips.
 *   b) Multi-page application. Simplest, but every navigation re-downloads
 *      the shell.
 *
 * Chosen: an SPA with aggressive code splitting and a service worker.
 * The first load is larger, but it happens once. Every navigation after
 * that is a JSON fetch of a few hundred bytes, and with the ETag layer
 * an unchanged view costs headers only.
 *
 * Trade-off accepted: worse first-visit performance and no HTML for
 * crawlers. Neither matters for an authenticated learning platform where
 * the same participants return repeatedly. If YCP later needs a public
 * marketing surface, that should be a separate statically generated site
 * rather than a reason to rebuild this one.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:4000',
        changeOrigin: true
      }
    }
  },
  build: {
    target: 'es2020',
    // Report the real cost. The performance budget in the report is
    // stated in compressed bytes, so measure compressed bytes.
    reportCompressedSize: true,
    chunkSizeWarningLimit: 200,
    rollupOptions: {
      output: {
        // Router and React change rarely, so they are split out and
        // stay in the browser cache across deploys. Shipping them in the
        // same chunk as application code means every bug fix re-downloads
        // the entire framework.
        //
        // A function is used rather than the object form because
        // react-router-dom imports React, and with the object form
        // Rollup hoists React into the router chunk, leaving the vendor
        // chunk empty. Matching on the module path is unambiguous.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('react-router')) return 'router';
          return 'vendor';
        }
      }
    }
  }
});
