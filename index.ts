import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createBraintrustOtelService } from "./src/service.js";

export default definePluginEntry({
  id: "braintrust-otel",
  name: "Braintrust OTEL Exporter",
  description:
    "Subscribes to OpenClaw internal diagnostics and emits Braintrust-shaped OTEL spans.",
  register(api) {
    api.registerService(createBraintrustOtelService());
  },
});
