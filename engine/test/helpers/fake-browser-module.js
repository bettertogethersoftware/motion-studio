/**
 * ES module form of the fake browser, loadable across process boundaries via
 * the MOTION_STUDIO_BROWSER_MODULE env hook (see cli/render.js). Used by the
 * parallel-render and MCP integration tests.
 */
import { makeFakeBrowserFactory } from './fake-browser.js';

export const createBrowser = makeFakeBrowserFactory();
