# Weather plugin — manual test guide

Reference plugin that exercises every documented `OraclePlugin` hook against a real upstream API (Open-Meteo — free, no API key). Use this guide to walk through each feature end-to-end.

**Start the app:** from `apps/qiforge-example`, run `pnpm dev`. Server boots on the port from `PORT` (default `5678` if unset, often `3000` in your `.env`).

## 1. HTTP endpoint (`getNestModules`)

```sh
curl 'http://localhost:3000/weather/now?city=Berlin'
```

**Expect:** `{"ok":true,"city":"Berlin","temp_c":<num>,"units":"celsius","conditions":"<label>","latitude":52.52,"longitude":13.405}`

**Auth gotcha:** the runtime's `AuthHeaderMiddleware` wraps every non-health route — `AUTH_EXCLUDED_ROUTES` is hardcoded in `packages/oracle-runtime/src/bootstrap/runtime-app-module.ts` and there is **no plugin hook to add to it**. So this curl returns `401 Missing x-ucan-delegation header` until either (a) you send a valid UCAN, or (b) the runtime grows a plugin exclusion API. Add `-H 'x-ucan-delegation: <token>'` to test with auth.

## 2. Plugin is on-demand (`manifest.visibility`)

The plugin's manifest sets `visibility: 'on-demand'`, so weather tools are NOT bound until the agent calls `load_capability`.

**Chat:** `what's the weather in Berlin?`

**Expect:** the agent should either (a) say it has weather available but not loaded, or (b) call `list_capabilities` / `load_capability` itself. If it calls `load_capability` with `name: "weather"`, the next turn has access to `get_current_weather` and `get_weather_forecast`.

If the agent doesn't auto-load: `load the weather capability` → on the next turn it will call the tool.

## 3. Boot-time tool (`getTools` → `get_current_weather`)

**Chat (after weather loaded):** `what's the temperature in Tokyo right now?`

**Expect:** `get_current_weather` fires with `{city:"Tokyo"}` and the agent replies with the temperature + conditions. Verify visually against a known weather site.

## 4. Request-time tool (`getRequestTools` → `get_weather_forecast`)

**Chat:** `forecast for São Paulo this week`

**Expect:** `get_weather_forecast` fires with `{city:"São Paulo", days:7}` (or similar). The handler reads `rtCtx.user.timezone` and passes it to Open-Meteo — observable via the response's `timezone` field if you sent `x-timezone` in your request, else `auto`.

## 5. Sub-agent + forwarded tools (`getSubAgents`, `forwardTools: true`)

**Chat:** `should I bring a jacket to Berlin tomorrow?`

**Expect:** the main agent calls `call_weather_planner_agent` with a task. Inside the sub-agent, it chains `get_weather_forecast` → `recommend_outfit`. Because `forwardTools: true`, BOTH inner tool calls + results appear in the main chat (UI renders them as tool invocation events).

## 6. Middleware (`getMiddlewares`)

Watch the server logs while any weather-using turn is in flight:

```
[weather] model call started
[weather] model call complete (Xms)
```

These bracket every LLM call on the main agent. Nothing weather-specific in the middleware itself — proves the hook fires.

## 7. Shared state (`getSharedState` → `lastWeatherQuery`)

After any weather lookup, the plugin writes `{city, latitude, longitude, queriedAt}` into a per-session store. Other plugins (or test code) can read it via `ctx.shared.lastWeatherQuery` inside their handlers. There is no agent-facing surface for this — verify via logs or a debugger.

## 8. Config schema + auto-detect (`configSchema`, `autoDetect`)

The plugin loads regardless of env (always-on). To switch to Fahrenheit:

```sh
WEATHER_DEFAULT_UNITS=fahrenheit pnpm dev
```

Then `curl 'http://localhost:3000/weather/now?city=Berlin'` should return `"units":"fahrenheit"` and a higher numeric value in `temp_c` (the field name reflects the spec contract — the `units` field disambiguates).

Invalid value (e.g. `WEATHER_DEFAULT_UNITS=kelvin`) fails boot with a Zod error pointing at the `weather` plugin — proves the schema merge worked.

## 9. Boot summary

When the app starts, the boot log line includes `weather` in `loaded plugins`. If you set `WEATHER_DEFAULT_UNITS=kelvin`, boot fails fast with a clear error pointing at the weather plugin.
