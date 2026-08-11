import type { NextConfig } from "next";

/**
 * Proxies /api/* to the Express API server-side, so the browser only ever talks to this
 * app's own origin.
 *
 * Without this, web (vercel.app) and api (onrender.com) are genuinely different sites, and
 * the session cookie is a third-party cookie from the browser's point of view — Safari and
 * Brave block that by default, and Chrome/Edge do too in private mode and increasingly in
 * normal mode. The symptom is exactly what showed up in testing: login succeeds (it only sets
 * a cookie, so it works regardless of policy), and the very next request that needs to read
 * the cookie back fails as unauthenticated.
 *
 * With the rewrite, the response the browser sees appears to come from this app's own domain,
 * so Set-Cookie is stored as an ordinary first-party cookie. `API_URL` is intentionally not
 * NEXT_PUBLIC_-prefixed — this runs on the Next.js server, never in the browser bundle.
 */
const nextConfig: NextConfig = {
  async rewrites() {
    const apiUrl = process.env.API_URL ?? "http://localhost:4000";
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  // Default bottom-left collides with the sidebar's sticky footer (Sign out).
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
