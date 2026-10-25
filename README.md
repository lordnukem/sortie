# Galaga Squadron

A first-person space combat game that runs entirely in the browser. Launch from
the carrier *Halcyon*, break the Swarm's attack formations before they reach the
fleet, and stay out of the Wardens' tractor beams.

Built with [three.js](https://threejs.org/). No build step, no bundler, no
server-side code — `index.html` plus a folder of textures is the whole thing.

## Play

- **GitHub Pages:** https://lordnukem.github.io/galaga-squadron/
- **VPS:** http://72.62.196.152/galaga-squadron/

Needs a browser with WebGL2. Gamepad support requires HTTPS, so controllers work
on the Pages URL but not over plain HTTP.

## Controls

| | Keyboard & mouse | Controller | Touch |
|---|---|---|---|
| Steer | `W` `A` `S` `D` or mouse | Left stick | Left half of screen |
| Roll | `Q` `E` | Right stick ↔ | On-screen ⟲ ⟳ |
| Throttle | `[` `]` or wheel | Right stick ↕ | THR slider |
| Afterburner | `Shift` | LB | BURN |
| Lasers | `Space` or left click | RT or A | FIRE |
| Missile | `F` or right click | LT or B | MSL |
| Target | `T` nearest · `Tab` next · `R` attacker | X · Y · RB | TGT · ATK |
| Camera | `C` | Right stick click | VIEW |
| Invert pitch | `I` | Back | — |
| Sound | `M` all · `V` voice callouts | — | — |
| Pause | `P` or `Esc` | Start | PAUSE |

## How it works

Everything is generated at runtime except the ship meshes and four surface
textures:

- **Sound** is synthesised with the Web Audio API — no audio files. Engines are
  detuned sawtooths through a resonant lowpass; explosions are filtered noise
  bursts into a generated convolution reverb.
- **Callouts** from Halcyon control use the browser's speech synthesis, with
  per-phrase rate/pitch shaping and a cooldown per message so repeats don't pile
  up.
- **Hull plating, Swarm carapace and asteroid rock** have procedural fallback
  textures drawn to canvas, used if the downloaded ones fail to load.
- **Ship meshes** arrive as OBJ text in `assets/ship-models.js` and are scaled
  and re-oriented at load so every ship flies along its own +z.

## Deployment

It is static files; any web server will do. On the VPS it is an additive nginx
`location` block, so it shares the default server without affecting anything else:

```nginx
location = /galaga-squadron { return 301 /galaga-squadron/; }
location /galaga-squadron/ {
    alias /var/www/galaga-squadron/;
    index index.html;
    try_files $uri $uri/ =404;
    gzip on;
    gzip_types application/javascript text/javascript text/plain;
    gzip_min_length 1024;
    add_header Cache-Control "public, max-age=3600";
}
```

gzip matters here: `assets/ship-models.js` is 1,021 KB raw and 357 KB compressed.

## Credits

Third-party assets are all **CC0 1.0 (public domain)** — see
[`assets/LICENSES.txt`](assets/LICENSES.txt):

- Ship models and `q_*.jpg` textures: [Ultimate Spaceships](https://quaternius.com/)
  by Quaternius (Striker, Dispatcher, Spitfire, Imperial, Pancake)
- `metal_*.jpg`: MetalPlates006 from [ambientCG](https://ambientcg.com/)
- `rock_*.jpg`: Rock063 from [ambientCG](https://ambientcg.com/)

three.js is loaded from jsDelivr at runtime and is not vendored here.

The game code itself has no license yet — add one if you want others to reuse it.
