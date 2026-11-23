# tilt4d

A browser demo of rendering as a projection from **four** dimensions to two.
The world is one fixed 4D scene (space plus scene time), and what is on screen
is a 3D slice of it. Besides turning and looking up and down, the camera has
one more rotation: *tilting*, which swings the line of sight out of space and
into time, so that ahead of you lies the past and behind you the future. The
further you tilt, the slower your own time passes: at 90° it stands still, and
beyond that it runs backwards. You move about with ordinary controls, but
within the slice you see. It looks a little like relativity but is not: the
rotation is Euclidean and light is instantaneous.

[CONCEPT.md](CONCEPT.md) is the note the project started from. There the
player always moves at a fixed speed C at right angles to the view, so that
tilting and speeding up are the same thing. The demo keeps the tilt and what
it does to time, but no longer ties it to the player's speed; see "How it
works" below.

## Running it

```
node tools/serve.mjs        # or: npm start
```

then open <http://localhost:8080/> in a browser with WebGPU (current Chrome or
Edge, Safari 26, Firefox 141 or later; on Linux it may need enabling in the
browser's flags). There is no build step and nothing to install: the page is
plain ES modules. Any static file server works, but the page has to come from
`http://localhost` or `https`, not from a `file:` URL (the single-file build
below can be opened from disk).

To use it from another machine, listen on more than localhost and serve HTTPS:

```
node tools/serve.mjs --host 0.0.0.0 --https     # optionally --port 8443
```

The HTTPS part matters: browsers only provide WebGPU to pages loaded over
https or from localhost, so plain http to another machine's address shows the
menu but cannot start. `--https` makes a self-signed certificate (kept in
`~/.cache/tilt4d`), which the browser asks you to accept once; pass
`--cert` and `--key` to use a real one. The alternative is to leave the server
on localhost and forward the port: `ssh -L 8080:localhost:8080 <host>`.

Pick a scene from the menu. `Esc` brings the menu back.

### As a single file

```
make
```

or, without make,

```
npm install                 # once: fetches esbuild for the tool
node tools/bundle.mjs       # or: npm run bundle
```

writes `dist/tilt4d.html`: the page with its stylesheet and all its scripts,
every scene included, minified into one file of about 360 kB (135 kB as a web
server sends it compressed). The shaders are minified too: they are the
template strings marked `/* wgsl */` in the scripts, and an unmarked one is
left as it is (the tool points out any it finds). It needs nothing beside it, so it can be uploaded
to any web host under any name (over https, as above), passed on to someone,
or opened straight from disk. It takes the same address parameters as the page
itself. `make` fetches the tool the first time and afterwards rebuilds the
file only when something it is made from has changed; `make clean` removes it
and `make OUT=public/index.html` writes it elsewhere. With the tool itself,
`--out` names the file and `--no-minify` leaves the code readable.
`node tools/shot.mjs --page dist/tilt4d.html --scene lab` renders from it,
which is a way to check a build.

## Controls

The one control that other games do not have is the **tilt**, and it is the
same everywhere: roll the **mouse wheel** forward, or hold `X`, and what lies
ahead of you turns to the past, further back the further off it is; roll it
back, or hold `Z`, for the future. It works standing still. The tilt stops for
a moment when the view is level again and at 90°, where the view runs straight
along time. `R` makes the view level and brings you to rest at once.

The tilt also sets the pace of your own time, which the HUD shows: standing
still it passes at the cosine of the tilt, so normally when level, at half
speed at 60°, not at all at 90° and backwards beyond. That holds on foot, in a
car and in the water. In flight there is nothing to hold you, and time passes
at its normal rate whatever the tilt.

Moving is done the usual way. Every scene starts in the control mode that
suits it; `M` switches.

| mode | controls |
|---|---|
| **Walk** | `W A S D` walk, `Shift` run, `Space` jump, mouse to look. |
| **Drive** | `W` / `S` speed up / slow down (the speed holds; `S` from rest reverses), `A` / `D` steer, `Space` brake. The mouse looks around without steering. |
| **Fly** | mouse to turn, `W A S D` and `Space` / `C` to thrust, `Q` / `E` roll, `Shift` for more thrust, `B` to brake. No drag. |
| **Swim** | as Fly, but the water brings you back to rest. `Shift` sprints. |

"Forward" is forward in the view. In a tilted view that is partly a direction
in time, so walking, driving or thrusting forward takes you into the past (or
the future) on top of that: going forward at speed v takes another
`v · sin(tilt) / C` off the pace of your time.

In every mode: `P` freezes you in place so you can look around the slice you
are in (and tilt it), `[` and `]` run everything in slow motion or fast
forward, `Backspace` returns to the start, `H` hides the HUD, `F` toggles full
screen.

The tilt turns more slowly the closer it is to 90° (or 270°), because that is
where the view changes fastest: a held key takes about 5 s for the first 75°,
7 s for the next 10° and 10 s for the last 5°, and a notch of the wheel
shrinks from 5.7° to 0.2°. Adding `?ease=0.04` to the address makes that
slowing milder (`1` turns it off, the default is `0.01`).

Whatever stands still is solid: walls, posts, trees, rocks. You slide along it,
and the part of your speed that went into it is gone. Arches and lanes are as
open as they look. What moves (trams, cars, people walking, fish) is not solid,
and neither are things that come and go, such as blinking lights.

On foot you can jump about 1.3 m high: over a fence at a run, or onto a low
wall or a bench, where you can stand and walk on until you step off the edge.
A jump stops under a ceiling.

The view is always coloured a little by time: what lies in your past has a
slight warm cast and what lies in your future a cool one, stronger the more
time lies between: it goes as the cube root of that time, so that it already
shows on things a fraction of a second away and keeps growing up to half a
minute. (A level view is not changed: everything in it is now.)
`T` goes round three settings: this slight colouring, the full one (amber and
blue outright, with a contour line for every whole second, which makes the
tilt of the slice directly visible), and none. Adding `?cast=2` to the address
makes the slight colouring twice as strong.

### Checking performance

The frame rate in the corner of the HUD is tied to the display: 60 fps only
says that the renderer keeps up, not by how much. To see the room there is:

* Press `G`. It draws the view you are looking at a number of times back to
  back, without waiting for the screen, and shows the time per frame and how
  many times the displayed rate that would allow, at the current resolution.
  The browser console gets the same numbers in more detail, including the
  page's own share of the time. Try it at a steep tilt and in the busiest
  spots, since it measures just that one view. Times below a millisecond or so
  are rough.
* To watch an uncapped frame rate all the time, start Chrome with
  `--disable-frame-rate-limit --disable-gpu-vsync`; the HUD's counter then
  shows what the machine can do. (In Firefox, set `layout.frame_rate` to 0 in
  `about:config`.)
* `?scale=2` in the address renders at twice the resolution in each direction,
  which shows how much of the cost is per pixel. It also switches off the
  automatic lowering of the resolution that otherwise sets in when frames are
  slow.

### On a phone or tablet

Touching the screen brings up on-screen controls instead: a stick under the
left thumb (it appears wherever the thumb lands on the left side), dragging
with the right thumb to look, and a few buttons. In every mode `−` and `+` at
the lower right tilt the view while held.

| mode | left stick | further buttons |
|---|---|---|
| **Walk** | walk; pushed all the way, run | `jump` |
| **Drive** | up and down change speed, left and right steer | `brake` |
| **Fly** | thrust | `▲` `▼` thrust up and down, `brake`; twist two fingers to roll |
| **Swim** | swim; pushed all the way, sprint | `▲` `▼` rise and sink |

The row along the top has `level` (level the view and stop), `time` (colour by
time), the control mode (tap to change), full screen and `☰` for the menu. Entering a scene asks the
browser for full screen and landscape where it allows that.

The gauge in the corner is a small spacetime diagram of your line of sight:
up is later, right is further ahead. The coloured line is where you are
looking, amber when it dips into the past and blue when it rises into the
future. The arrow is your own motion: straight up while you stand still and
time simply passes (shorter the slower it passes, and pointing down when it
runs backwards), leaning over as you move.

## What to try

* Stand still with a level view: everything looks ordinary, and the scene's
  clocks run.
* Still standing, tilt the view and watch a row of clocks: each one further
  away shows an earlier time, and all of them run slower. Turn around: behind
  you they are ahead. Sideways they show your own time.
* Tilt further. Things stretch along the direction of the tilt, and the sky
  ahead and behind are hours apart.
* At 90° the view runs straight along time and nothing moves any more: what is
  in front of you is the history of the spot you are standing on, laid out
  like a ruler. Beyond 90° the world is mirrored and runs backwards; at 180°
  it is level again, in reverse.
* Now move forward in a tilted view. You head into the past you are looking
  at, so your own time slows further: at a speed of `C / tan(tilt)` it stands
  still before the tilt gets to 90°. Walk backwards and it speeds up again.
* Do the same flying. There the tilt leaves the pace of time alone, and only
  your motion changes it: time stands still at `C / sin(tilt)`.
* Watch something that moves in a regular rhythm, such as a chain of flashing
  lights, and see the rhythm change with the tilt: things that move towards you
  bunch up or stretch out, and at the right tilt a running light is everywhere
  at once.

## How it works

The player is a point in `(x, y, z, t)` with a velocity and an orthonormal 4D
frame: screen right `R`, screen up `U`, facing `F` and a fourth vector `O`,
all measured with time scaled to length by the scene's constant `C`. What is
drawn is the 3D slice spanned by `R`, `U` and `F`; `O` is its normal and is
only there to rotate against. Turning rotates `F` and `R` in their plane,
looking up rotates `F` and `U`, and tilting rotates `F` and `O` in exactly the
same way. See `src/player.js`.

The velocity is not part of the frame, and has two parts.

Left alone, the player stays put while scene time passes at `cos θ` seconds
per second: the time component of `O`. One way to read that is that the player
is always carried along `O` at speed `C`, as in CONCEPT.md, and that whatever
stands still in the world (the ground, the water) holds back the spatial part
of that motion, so that only its time part gets through. Technically it is
friction: the ground brings the player's time rate to `cos θ` at once, water
does it with the same sluggishness as it stops a swimmer. In flight there is
nothing to hold on to, and there the rate is simply 1. (The full rule of
CONCEPT.md would have a tilted flyer drift off through space at `C·sin θ`.
That tied what you saw to how fast you went and capped the speed at `C`, and
it has been dropped.)

On top of that the controls add an ordinary velocity: a walking speed, a car's
speed along its heading, thrust that accumulates. They do so along the frame's
own vectors, though, and in a tilted frame `F` has a time component: going
forward at speed `v` with tilt θ covers `v·cos θ` metres of ground a second
and `v·sin θ / C` seconds of the past. So on the ground time passes at
`cos θ − v·sin θ / C`, and stands still at `v = C / tan θ`. There is no top
speed and nothing special about moving at `C`; `C` is just the exchange rate
between metres and seconds that the tilt uses.

What the tilt does to the view goes as `tan θ` (things are stretched by
`1 / cos θ`), which runs off to infinity at 90°. So a held tilt key turns at a
rate multiplied by `ease + (1 − ease)·cos² θ`, with `ease` = 0.01: `tan θ`
grows steadily up to about 84°, and the last five degrees go by at 0.7° falling
to 0.4° a second. A notch of the wheel is 0.1 rad times `0.04 + 0.96·cos² θ`.

The slice is drawn like this:

* **Static geometry** is its mesh extruded along the time axis. Each vertex's
  world line meets the slice exactly once, so it is drawn as ordinary triangles
  with a vertex shader that solves for that moment.
* **Moving geometry** is sampled at key times; each triangle sweeps out a prism
  between keys, split into three tetrahedra in `(x, y, z, t)`. A vertex shader
  cuts every tetrahedron with the slice (a 4D version of marching tetrahedra)
  and emits the resulting triangle or quad. Only the chunks of tetrahedra whose
  4D bounding box the slice passes through are sent to the GPU.
* Lighting, sky and materials are evaluated at each pixel's own moment, which
  is why clocks, lamps and the sky all show the tilt.
* Shadows use shadow maps of the slice itself, two or three of them covering
  ever larger areas round the player; terrain can also cast its shadow from a
  baked horizon map, which works at any distance and for any moment. The image
  is rendered in HDR with multisampling, bloom and tone mapping.
* Glossy surfaces mirror the sky or, in scenes that ask for it, a picture of
  the whole scene around the player, redrawn one side per frame.
* A mesh placed many times over (a forest) is stored once and drawn instanced.
  Meshes can have holes cut per pixel (foliage), with matching shadows, or be
  see-through (smoke, glass), and a scene can hand its shader tables of
  numbers as textures.

`src/renderer.js` and `src/wgsl.js` hold the renderer, `src/builder.js` turns
scene descriptions into those two kinds of geometry.

Collisions (`src/collide.js`) use the static triangles themselves, so nothing
is authored twice. The player is an upright cylinder on the ground and a sphere
in free movement, moved in steps shorter than its radius so that no surface can
be stepped across. Running into a surface takes away the part of the velocity
that points into it, and the player slides along with the rest. On the ground
that is done within the slice, with the surface's normal as it appears there,
so that someone walking into a wall in a tilted view stops there instead of
carrying on through time. In free flight the surface's own normal is used,
which has no time component: thrust against a wall in a tilted view and the
part of it that points into time is all that is left.

## Scenes

| scene | mode | C | what shows the tilt |
|---|---|---|---|
| **Old Town** | walk | 10 m/s | a clock tower that follows the sky, street lamps coming on in a wave at dusk, trams, cyclists and walkers on a 200 m avenue |
| **Coastal Circuit** | drive | 30 m/s | timing boards every 50 m down a 1.2 km straight, traffic at 0.5, 1 and 1.5 C, trains, light pulses along the wall |
| **Orbital Station** | fly | 200 m/s | a ring station turning every 30 s, lanes of beacons whose pulses run at C, convoys, clocks on the gateway frames |
| **Coral Reef** | swim | 4 m/s | columns of bubbles all rising at the same pace, vents puffing together, lanes of fish, caustics |
| **Winter Valley** | walk | 12 m/s | the detailed scene, for desktop GPUs: a ridge's shadow and the alpenglow sweeping over the mountains, lanterns that come on in a wave at dusk with a pulse running up the path, a chairlift, an aerial tram, skaters, skiers, walkers, chimney smoke and clocks that follow the sky |
| **Time Lab** | walk | 10 m/s | a bare runway of clocks, plus pendulums, traffic and things that pop in and out of existence |

Scenes live in `src/scenes/` and are listed in `src/scenes/index.js`.
[docs/SCENES.md](docs/SCENES.md) explains how to write one;
`src/scenes/lab.js` is a commented example, and `src/scenes/enginetest.js`
(not in the menu: open it with `?scene=enginetest`) shows the engine's newer
features side by side. The five larger scenes were each written by a separate
Claude Opus agent against that guide. Winter Valley is
the heavy one: about a million static triangles and a costlier shader, where
the others stay within what a phone can draw.

`tools/check-solids.mjs <scene>` builds a scene without a browser and checks
its collisions: that the spawn point is clear and that roaming about never
crosses a solid surface.

`tools/shot.mjs` renders a single frame of a scene headlessly, at any position,
time and tilt, which is handy while authoring:

```
npm install                 # once: fetches playwright-core for the tool
node tools/shot.mjs --scene lab --tilt 30 --t 100 --hud --out shot.png
```

It needs a Chromium that Playwright can find (`npx playwright install chromium`).
`--browser firefox` renders in Firefox instead (run it under `xvfb-run -a`),
and `node tools/check-wgsl.mjs` validates every scene's shader with naga, the
WGSL compiler Firefox uses.
