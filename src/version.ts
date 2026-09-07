/**
 * The one version string.
 *
 * digger-node carried three — CalVer in package.json, a hard-coded
 * SERVER_VERSION in mcp.ts (also createApp's default), and the add-on's
 * config.yaml — and they drifted. trace-node reads package.json once at module
 * load; /health, /api/health and serverInfo all report this value (PRD §6.4).
 */

import pkg from "../package.json";

export const VERSION: string = String(pkg.version);
