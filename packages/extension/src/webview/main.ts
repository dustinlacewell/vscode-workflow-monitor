/**
 * Extension-bundle entry point: mount the webview against `document`.
 * The docs-site preview imports `mount` from controller.ts directly and
 * passes its own shadow root.
 */
import { mount } from "./controller.js";

mount();
