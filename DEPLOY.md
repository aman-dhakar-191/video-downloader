# Deploying on a VPS

Two containers: the Node app (internal only) and Caddy, which terminates TLS and
gets a Let's Encrypt certificate automatically.

## Prerequisites

- A VPS with Docker Engine and the Compose plugin.
- A domain with an **A record pointing at the VPS IP**. Caddy cannot issue a
  certificate before DNS resolves, so do this first and let it propagate.
- Ports 80 and 443 open. Port 80 is required for the ACME challenge even though
  all real traffic ends up on 443.

## Deploy

```bash
git clone <this repo> && cd video-downloader
cp .env.example .env
$EDITOR .env            # set DOMAIN and ACME_EMAIL
docker compose up -d --build
```

Check it came up:

```bash
docker compose ps                    # both services running, app healthy
docker compose logs -f caddy         # watch the certificate get issued
curl https://your-domain/healthz     # {"ok":true}
```

The first request after startup can take a few seconds while Caddy completes the
ACME handshake. If it fails, the log names the reason — almost always DNS not yet
pointing at the box, or port 80 blocked by a firewall or another web server.

## Configuration

Everything lives in `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `DOMAIN` | *(required)* | Hostname Caddy serves and requests a cert for |
| `ACME_EMAIL` | empty | Let's Encrypt expiry notices; recommended |
| `RATE_LIMIT_PER_MIN` | `30` | API requests per client IP per minute |
| `TELEGRAM_TOKEN` | empty | Bot token from @BotFather; required for the bot |
| `TELEGRAM_ALLOWED_IDS` | empty | Comma-separated user ids; empty means anyone |

The app also reads `TRUST_PROXY` (set to `1` in compose). It must stay `1` while
Caddy is the only proxy in front: without it every request appears to come from
Caddy's container IP and the rate limit turns into one global bucket instead of
one per client. If you put Cloudflare or another proxy in front of Caddy, raise
it to `2`.

## Telegram bot

The bot runs as a third container behind a compose profile, so the default
`docker compose up -d` leaves it off. To enable it, put a token in `.env` and:

```bash
docker compose --profile bot up -d
docker compose logs -f bot        # should log "running as @yourbot"
```

It uses long polling, so it needs no inbound port and no webhook URL. Its
download buttons are built from `PUBLIC_BASE_URL`, which compose sets to
`https://$DOMAIN` — so the bot only works properly once TLS is up.

Set `TELEGRAM_ALLOWED_IDS` unless you want the bot public. An open bot is an open
proxy for your bandwidth, and it is discoverable by username.

## Operations

```bash
docker compose logs -f app           # application logs
docker compose up -d --build         # deploy a new version
docker compose down                  # stop (certificates survive in the volume)
docker compose pull && docker compose up -d   # update Caddy
```

Certificates live in the `caddy_data` volume. Don't delete it casually — Let's
Encrypt rate-limits reissuance for the same domain.

## Things that will bite you on a real VPS

**Bandwidth.** `/api/download` streams the file *through* your server, so every
download costs you the full file size in both ingress and egress. A 2 GB video
downloaded ten times is 40 GB of transfer. Most budget VPS plans meter this, and
some throttle hard once you cross the cap. If this gets any real traffic, the
honest fix is to hand the client the direct CDN URL and skip the proxy — you only
lose the nice filename and lose it entirely if the upstream checks `Referer`.

**Memory is fine, but connections aren't.** Downloads are streamed, not buffered,
so RAM stays flat. What does scale is open sockets: each in-flight download holds
one connection to the upstream and one to the client for its whole duration. A
1 GB VPS is fine for personal use and will not be fine as a public service.

**No authentication.** Anyone who finds the URL can use your server and your
bandwidth as a proxy. If it is not meant to be public, put Caddy `basic_auth` in
front of it or bind it behind a VPN or Cloudflare Access.

**The resolver is still unverified.** See the caveat in `README.md` — the
extraction patterns have never run against a live Diskwala page. Confirm it works
locally with `DEBUG_HTML=1 npm start` before you spend time on a deployment.

## What was and was not tested

The compose file is validated (`docker compose config` parses it). The app's
graceful shutdown, healthcheck endpoint, and unit tests run clean locally.

The image build, the container healthcheck, and the Caddyfile have **not** been
executed — the development environment had the Docker CLI but no daemon. Run
`docker compose up --build` locally once before pointing DNS at anything.
