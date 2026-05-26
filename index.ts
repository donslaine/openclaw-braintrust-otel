import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { IoBuffer } from "./src/io-buffer.js";
import { createBraintrustOtelService } from "./src/service.js";

export default definePluginEntry({
  id: "braintrust-otel",
  name: "Braintrust OTEL Exporter",
  description:
    "Subscribes to OpenClaw internal diagnostics and emits Braintrust-shaped OTEL spans.",
  register(api) {
    const ioBuffer = new IoBuffer();
    api.registerService(createBraintrustOtelService({ ioBuffer }));
  },
});
