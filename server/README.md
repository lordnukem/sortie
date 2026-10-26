# The leader board service

A deliberately small thing: Node's own `http` and `node:sqlite`, no dependencies, bound to
localhost and reached through nginx. One row per posted score, and it answers the top twenty.

```
server.js            the service
sortie-api.service   systemd unit (deployed to /etc/systemd/system/)
nginx-sortie.conf    the vhost (deployed to /etc/nginx/sites-available/sortie)
```

## Endpoints

| | |
|---|---|
| `GET /api/health` | liveness, and the row count |
| `GET /api/scores?limit=20` | the board: name, score, wave, date, country |
| `POST /api/scores` | submit a run |

Only name, score, wave, date and country are ever served back. Everything else the service
records is write-only as far as the API is concerned.

## What it records, and why

A posted run carries its own numbers — score, wave, kills, shots, hits, asteroids, seconds — plus
three characters and the client's time zone and local clock. The service adds, from the request
itself: the IP address, the country/region/city that address resolves to, the user-agent string,
and the OS, browser and device family read out of it.

**The client is never asked for any of that.** A client that can set its own country can set its
own score, and the browser's own geolocation API is a permission prompt nobody wants mid-game.
IP-to-place is resolved through [ip-api.com](https://ip-api.com/) and cached for a month, which
does mean a player's IP is sent to that service; the game says so on its About page. Nothing is
recorded at all unless the player confirms a name on the debrief screen.

## Keeping forged scores out

Plausibility, not proof. Anyone who reads the minified client can post numbers that satisfy all
of it; the point is to cost them an afternoon rather than a `curl` command.

- three characters from `A-Z 0-9 . -`, nothing else
- `hits <= shots`, `kills <= shots`
- `seconds >= wave * 8` — the spawn queue alone takes that long to deliver
- `score <= 2000 + wave*14000 + kills*1200 + rocks*150`, the richest plausible wave
- 20 submissions per IP per hour, 120 reads per minute

Soft oddities (no shots, no clock) are recorded in `flags` rather than refused.

## Deploying

```sh
sudo cp sortie-api.service /etc/systemd/system/
sudo cp nginx-sortie.conf /etc/nginx/sites-available/sortie
sudo ln -sf /etc/nginx/sites-available/sortie /etc/nginx/sites-enabled/sortie
sudo systemctl daemon-reload && sudo systemctl enable --now sortie-api
sudo nginx -t && sudo systemctl reload nginx
```

The vhost listens on port 80 only. certbot needs to answer an ACME challenge there before there
is a certificate to listen with; `sudo certbot --nginx -d sortie.questfor.ge` rewrites the file
with the 443 block and the redirect once the name resolves to this host.

## Reading the data

```sh
sqlite3 /home/ubuntu/sortie-api/scores.db \
  'SELECT created_at, name, score, wave, country, city, os, browser, device FROM scores ORDER BY id DESC LIMIT 20;'
```
