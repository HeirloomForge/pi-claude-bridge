/** Run the bridge suite against the candidate Pi host, not its development peers.
 * Usage: PI_COMPAT_HOST_ROOT=/path/to/pi-coding-agent npm run test:unit
 * Node hooks are inherited by each test worker through --import. */
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_COMPAT_HOST_ROOT;
if (root) {
	const hostParent = pathToFileURL(join(root, "package.json")).href;
	registerHooks({
		resolve(specifier, context, next) {
			if (specifier === "@earendil-works/pi-coding-agent") {
				return { url: pathToFileURL(join(root, "dist/index.js")).href, shortCircuit: true };
			}
			if (/^@earendil-works\/(pi-ai|pi-agent-core|pi-tui)(\/|$)/.test(specifier)) {
				return next(specifier, { ...context, parentURL: hostParent });
			}
			return next(specifier, context);
		},
	});
}