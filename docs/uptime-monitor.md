# Router uptime alerts

Tulip runs `scripts/monitor-router.mjs` every minute as the Windows scheduled task **Teleport Router uptime**, independently of the Phala CVM. Installation files and configuration are under `%LOCALAPPDATA%/teleport-router/monitor`.

The monitor checks `/health` and the homepage, and checks the entries API every five minutes. It validates the response content as well as HTTP status. Three consecutive failed checks produce one outage alert; two successful checks produce a recovery alert. Alerts go to the configured Paseo conversation. A persisted outbox retries failed delivery. A lock prevents overlapping checks and is reclaimed after a crashed process.

The monitor never restarts or redeploys Router. An outage asks the Paseo agent to notify James and permits read-only investigation. Test alerts are explicitly labeled and are not posted to the public notebook. The initial real test was delivered to Paseo on 2026-11-05.

Run `node --test scripts/monitor-router.test.mjs` for transition and response-validation tests. To test an installed monitor, pass its state directory and `--test-alert`. The machine must be online, the scheduled task must be able to run, and the configured Paseo conversation must remain available. This is one external monitoring location, not a multi-region uptime guarantee.
