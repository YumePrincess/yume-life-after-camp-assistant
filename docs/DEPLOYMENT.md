# Deployment guide

English is the default. Read this guide in [简体中文](DEPLOYMENT.zh-CN.md) ·
[繁體中文](DEPLOYMENT.zh-TW.md) · [Français](DEPLOYMENT.fr.md) ·
[日本語](DEPLOYMENT.ja.md).

This guide deploys the camp website and API to Cloudflare Workers and connects
the optional local Mac Agent. Start with a new Cloudflare D1 database and R2
bucket for this installation; do not point a preview at another site's data.

## Why Workers, and can it be free?

Workers removes the need to provision and patch an always-on server. The site,
API, and static assets deploy together; Cloudflare operates the edge runtime,
and managed D1, R2, and Durable Objects connect through bindings. The included
`workers.dev` hostname is useful for a first deployment or preview without
setting up a custom domain. A paid Workers plan is not required: a small camp
can deploy on Workers Free while its Workers, D1, Durable Objects, and R2 usage
stays within current free allowances. Free allowances are limited and can
change. Exceeding them or enabling paid/third-party services can incur charges;
check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), and
[R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## 1. Cloudflare setup

You need a Cloudflare account, Node.js 22 or later, and a terminal. From the
repository root:

```sh
cd Workers
npm install
cp wrangler.example.jsonc wrangler.jsonc
```

Edit `wrangler.jsonc`:

1. Set a unique Worker `name` and keep `workers_dev: true` for a temporary
   `workers.dev` address. Add a custom domain only after its DNS zone is ready.
2. Create a D1 database and an R2 bucket in your Cloudflare account. Put the D1
   ID and database name in the `DB` binding, and set the `FILES` binding to the
   R2 bucket name. Keep `migrations_dir: "migrations"`.
3. Leave the four Durable Object bindings, migrations, static Assets binding,
   and scheduled trigger in place. Do not reuse production resources for a
   preview deployment.

Create resources with Wrangler if needed:

```sh
npx wrangler d1 create yume-camp-assistant
npx wrangler r2 bucket create yume-camp-assistant-files
```

### Wrangler fields to configure

| Field | What to set |
| --- | --- |
| `name` | A unique Worker name. Wrangler uses it as the first part of the `workers.dev` URL. |
| `workers_dev` / `preview_urls` | Keep `workers_dev: true` and `preview_urls: false` for the public `workers.dev` address without per-version preview URLs. |
| `routes` | Leave this out for a `workers.dev` deployment. If you later use a domain in a Cloudflare DNS zone, add its route and `custom_domain: true`. |
| `DB` | Keep `binding: "DB"`; set `database_name` and `database_id` to the D1 database you created. Keep `migrations_dir: "migrations"`; use the same database name in the migration command. |
| `FILES` | Keep `binding: "FILES"`; set `bucket_name` to the R2 bucket you created. |
| `vars.ENVIRONMENT` | Set a label such as `production` or `preview`; use `preview` for an isolated test deployment. |
| `vars.STORAGE_PREFIX` | Set a prefix for objects in R2. Use a different prefix for each installation if multiple installations share a bucket. |
| `vars.OIDC_ENABLED` | Use `false` for Key-only login, or `true` when you have configured an OIDC provider. |
| Other `vars.OIDC_*` | Configure only for OIDC: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_POST_LOGOUT_REDIRECT_URI`, `OIDC_ALLOWED_SUBJECTS`, `OIDC_SCOPES`, `OIDC_EMAIL_CLAIM`, `OIDC_AUTO_LOGIN`, `OIDC_TOKEN_AUTH_METHOD`, and `OIDC_SESSION_CHECK_INTERVAL_SECONDS`. The callback is `<site URL>/auth/oidc/callback`; allowlist `sub` values, not email addresses. |
| `secrets` | Add the secret values described below. Never put secret values in `vars` or commit them. |
| `assets`, `durable_objects`, `migrations`, `triggers`, `observability` | Keep the supplied static-asset binding, four Durable Object bindings, migration tags, scheduled trigger, and logging configuration unless you intentionally change the application architecture. |

The sample config omits `routes`, so a normal deployment uses the `workers.dev`
address printed by Wrangler. To attach a custom domain later, add a route like
this and replace the domain with one in your Cloudflare account:

```jsonc
"routes": [{ "pattern": "camp.example.com", "custom_domain": true }]
```

## 2. Configure administrator authentication

OIDC is optional. The admin console accepts OIDC or a Key through the same Key
sign-in flow. **Key-only setup** (also used by the temporary preview):

1. Set `OIDC_ENABLED` to `false` in `wrangler.jsonc`.
2. Add the permanent administrator Key as a Worker secret. It remains valid
   until that secret is rotated:

   ```sh
   npx wrangler secret put ADMIN_TEMPORARY_KEY
   ```

3. Generate independent random values of at least 32 bytes for the required
   runtime secrets:

   ```sh
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put AGENT_SHARED_TOKEN
   ```

`SESSION_SECRET` signs sessions and encrypts server-side secrets. Keep it stable
between deploys; rotating it invalidates existing sessions and encrypted data.
`AGENT_SHARED_TOKEN` authenticates the local Agent and must be entered unchanged
in the Mac app. `ADMIN_TEMPORARY_KEY` is required when using Key-only login and
is optional when OIDC alone is used. `OIDC_CLIENT_SECRET` is required only when
the selected provider token-auth method requires one.

The `ADMIN_TEMPORARY_KEY` value is entered into the same admin sign-in field as
Keys created in the console. A configured Wrangler Key has no expiry; rotating
the secret invalidates it. Console-created Keys support names, expiration,
revocation, and module-level permissions.

To use OIDC instead, set `OIDC_ENABLED` to `true`, configure the provider's
issuer, client ID, callback and post-logout URLs, and put the provider's
client secret in `OIDC_CLIENT_SECRET` when required by its token-auth method.
`OIDC_ALLOWED_SUBJECTS` is a comma-separated allowlist of OIDC `sub` values,
not email addresses. Keep all secrets in Wrangler Secrets or the Cloudflare
dashboard, never in `vars` or committed files.

## 3. Apply migrations and deploy

Apply every pending D1 migration to the new database, then validate and deploy:

```sh
npx wrangler d1 migrations apply yume-camp-assistant --remote --config wrangler.jsonc
npm run check
npm run deploy
```

Wrangler prints the Worker URL. With `workers_dev: true`, it has the form
`https://<worker-name>.<account-subdomain>.workers.dev`. Check the home page and
`/login`, then sign in at `/admin` with the permanent Key. Configure the camp
name, server, timezone, public content, and automation schedule in the admin
console. Configure SMTP there if identity application and recovery emails are
needed. Public DNS/custom domains are optional.

For WeChat Mini Program web-view use, add the deployed HTTPS hostname to the
Mini Program's request and web-view domain allowlists in the WeChat platform.

## 4. Install the Mac Agent

The Agent needs an Apple Silicon Mac, macOS 26 or later, the mainland China
edition of the MuMu Android emulator, the LifeAfter mainland China server
client, and Android platform-tools. The automation workflows are designed for
those mainland editions. Overseas game or emulator versions may use different
screens and flows, so users must adapt the relevant source code themselves.
Install the LifeAfter client from MuMu's built-in app store. In the game's
settings, change the default mouse-release key from `~` to `=`; the Agent uses
`=`. The Agent connects to MuMu's local loopback ADB port; do not expose ADB
publicly.

The optional local vision model may fail to download over a direct internet
connection in mainland China. If you need it, arrange your own network access
or obtain the model files yourself.

The automation Agent currently supports only Apple Silicon Macs running macOS 26 or later. The project may not develop additional Agents for Windows or other platforms.

The open-source Agent game automation was tested successfully as of
2026-11-22. Later LifeAfter updates may change key bindings, interaction flows,
or screen positions. The project may not provide fixes or updated releases for
those changes.

### Use the native app

Build the app from `MacApp/` or install a release `.dmg`:

```sh
cd MacApp
./scripts/build-app.sh
```

On the first launch, complete the setup assistant:

1. **Workers URL:** paste the exact HTTPS URL printed by Wrangler, for example
   `https://<worker>.<account-subdomain>.workers.dev`. Do not add `/admin`.
2. **Agent device name:** choose a recognizable name; use a different name for
   each Mac if you have multiple Agents.
3. **MuMu container name:** enter the exact container name shown in MuMu. The
   Agent matches this name and discovers that container's loopback ADB port.
4. **Agent token:** enter the same value stored as the Worker secret
   `AGENT_SHARED_TOKEN`.
5. **Local debug token:** enter an independent random token for the Agent's
   local control API. Do not reuse the Worker token; it stays on this Mac.
6. **Admin access Key (optional):** enter `ADMIN_TEMPORARY_KEY` or a Key created
   in the admin console if you want the app's embedded admin view to use it.
   Leave it blank to sign in through the embedded view when needed.
7. Review the generated device ID (the app creates it automatically) and the
   displayed timezone, which follows the Workers camp timezone. Choose **Save,
   Install and Finish** to write the local config and credentials, register the
   background LaunchAgent, and run the health check.

After setup, use the app to inspect logs, start or stop the Agent, run available
tasks, manage plugins, repair its installation, and open the web admin console.
An online Agent does not start game tasks by itself; configure and enable tasks
in the admin console deliberately.

### Install from the command line

From `Mac/`, create a local config from `config.example.json`, set its server
URL and matching `AGENT_SHARED_TOKEN`, then install and check the runtime:

```sh
cd Mac
cp config.example.json config.json
./scripts/manage-local-agent.sh install
./scripts/manage-local-agent.sh status
```

Keep `config.json` private. For full local-model setup, emulator configuration,
troubleshooting, and task calibration, see [`Mac/README.md`](../Mac/README.md)
and [`MacApp/README.md`](../MacApp/README.md).

## 5. Operate the camp

On a fresh installation, every automatic scheduled task starts disabled.
Review the emulator setup, schedules, and camp data before enabling tasks one
by one.

1. Add the camp's actual public notices and group instructions; replace the
   example QR-code images before inviting members.
2. Configure identity-code requirements and administrator review procedures.
3. Set technology voting hours, vote eligibility, daily polls/draws, and fixed
   technology rules. The current technology catalogue is incomplete because
   our camp has not unlocked every technology. Add missing choices in source if
   needed; we do not promise a future release will complete the catalogue.
4. Select the active Agent device and enable only the automation tasks the camp
   is ready to run. Begin with manual runs and inspect results before relying on
   a schedule.
5. Review task history, member/contribution snapshots, warnings, and chat
   settings in the admin console.

The application does not host game accounts or provide a member-kick feature.
See the root [README](../README.md) for the complete feature catalogue and the
project's license and third-party asset notes.
