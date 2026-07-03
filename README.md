# JobNimbus ChatGPT Bridge

Small authenticated bridge that lets a ChatGPT Custom GPT Action read and, when explicitly enabled, update JobNimbus.

## Safety

- Keep `JOBNIMBUS_API_KEY` only in Render environment variables.
- Set `JOBNIMBUS_BRIDGE_TOKEN` and use it as the Custom GPT bearer token.
- Leave `BRIDGE_ALLOW_WRITES=false` until you intentionally want approved write actions.
- Write endpoints are dry-run unless the request includes `execute:true` and Render has `BRIDGE_ALLOW_WRITES=true`.

## Render

Start command:

```bash
npm start
```

Health path:

```text
/health
```
