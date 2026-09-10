/*
 * Stands in for `sidequest start` with no Slack to attach to: an Attacher
 * pointed at a port nothing is serving. Nothing here keeps the event loop
 * alive except the poll loop itself, so this process staying up is exactly the
 * property test/attacher.lifetime.test.ts is checking.
 */
import { Attacher } from "../../src/cdp/attacher.js";

const port = Number(process.argv[2]);
const attacher = new Attacher({ cdpPort: port, targetUrlPattern: "app\\.slack\\.com" });

await attacher.start();
// Only printed once the first sweep has been and gone, so the test is not
// racing the startup path.
console.log("polling");
