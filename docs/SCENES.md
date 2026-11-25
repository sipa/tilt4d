# Writing a tilt4d scene

A scene is one ES module in `src/scenes/` whose default export describes a
fixed four-dimensional world: geometry in space, and how it exists and moves
through time. The player cannot change anything; they only travel through it.
`src/scenes/lab.js` is a complete, commented example. Read it first.

## How the world is seen

Coordinates are `x`, `y` (horizontal), `z` (up) in metres and `t` in seconds.
The scene's constant `C` (metres per second) converts time to distance.

The player has a position, a velocity and a frame of four orthonormal 4D
vectors: screen right `R`, screen up `U`, facing `F` and a fourth one, `O`.
What is on screen is always the 3D slice through the player that `R`, `U` and
`F` span, the one perpendicular to `O`. While `O` is the time axis the slice
is level and the screen shows the world at one instant, like any 3D renderer.
The tilting control rotates `R` and `O` in their plane by a tilt angle θ,
however the player happens to be moving. When tilted (with the wheel rolled
forward; rolled back, exchange left and right):

* a point at distance `d` to the player's right, which is the direction of
  the tilt, is seen `d·sin θ / C` seconds **later** than the player's own
  time; to the left it is seen earlier. Ahead, behind and upwards the time is
  unchanged;
* static things are stretched by `1 / cos θ` along that direction;
* at θ = 90° the view runs straight along the time axis from left to right:
  the screen shows the history of the one upright plane the player is looking
  along, earlier on the left and later on the right; beyond 90° the world is
  mirrored.

Turning the view afterwards leaves the slice as it is and only changes where
the player looks within it: after a quarter turn to the right the direction of
the tilt, and with it the future, lies ahead.

A second control tilts the slice up and down in the same way (it rotates `U`
and `O`): what lies above the player is then seen later and what lies below
earlier, or the other way round. So a scene can show time by height as well:
a tower of clocks, things that rise or fall steadily, floors one above
another. The two tilts add up.

Moving follows the slice in every mode. Flying or swimming upwards in a slice
lifted by λ goes `tan λ / C` seconds on for every metre of height. A walker's
jump goes along the slice's own up as well: it has the reach it always has,
1.27 m, of which `cos λ` is height and `sin λ / C` seconds, and at 90° it is a
way forward in time and back. A fall comes down the same way. Where the world
sets the height (a slope, a step, standing on something), being `h` higher
takes the walker `h·tan λ / C` seconds on, and coming down takes them back:
they stay in the slice, and arrive up there at the moment the view shows
there. (The tangent has no end: beyond 84° that share falls away, to nothing
at 90°.) A car that leans with the ground has the ground's normal for its
"up": driving up a slope is along its own frame and takes no time of this
kind.

The player's motion is a separate matter. Standing still, scene time passes at
`cos θ` seconds per second on the ground and in water (so not at all at 90°,
and backwards beyond), and at one second per second in flight. The mode's
ordinary controls (walking, driving, thrust) move the player along `R`, `U`
and `F` as they are, so in a tilted slice a step to the right at speed `v`
covers `v·cos θ` metres of ground a second and takes the player another
`v·sin θ / C` seconds on in time. Going forward does the same for a player
who has turned towards the future (a car has to: it only goes where it
points).

So a scene shows the effect well when **time is visible everywhere**: clocks,
things that move steadily or rhythmically, lights that blink in sequence, a sky
that changes, things that appear, grow and vanish. A player who has just
arrived tilts the view from side to side, so have such things on both sides
of the starting view: clocks to the left and to the right of it differ at
once. Long rows along which many things move are ideal: seen from the side
(or end on, by a player who has turned after tilting), each row of moving
things shows a whole stretch of its history at once. `C` sets how much time a
tilt takes in: at 45° the view is one second on for every `C` metres to the
right. Choose it so that this
shows across the scene's views, and so that the things that move do so at
a fair fraction of `C`, since that is where a tilt changes how fast and how
long they look. Driving, flying and swimming speeds scale with `C` as well.

## The scene definition

```js
export default {
  id: 'lab',                 // same as the file name
  name: 'Time Lab',
  blurb: 'One or two sentences for the menu.',
  C: 10,                     // metres per second
  mode: 'walk',              // starting control mode: walk | drive | fly | swim
  modes: ['walk', 'fly'],    // modes the player may switch between
  spawn: { pos: [0, -30, 0], t: 0, yaw: 0, pitch: 0 },   // yaw in degrees clockwise from +Y

  period: 60,                // seconds after which all *dynamic* geometry repeats; 0 = it does not
  viewDistance: 700,         // metres beyond which dynamic geometry is not drawn (fog should hide it)
  skyDistance: 900,          // distance of the sky shell, see "Sky and fog"
  exposure: 1,               // optional: brightness multiplier
  bloom: 0.35,               // optional: glow strength; bloomThreshold: 1 sets where it starts
  shadows: true,             // optional; shadowRadii: [35, 260] metres covered by the two
                             // shadow cascades, shadowDepth: 800 their reach towards the sun.
                             // A third radius, as in [40, 320, 2400], adds a third cascade
                             // for far shadows (every cascade draws the static geometry once more).
                             // A single radius, as in [5], is one map and one pass less: for a
                             // scene no bigger than a room (see "A small world")
  shadowCentre: [0, 0, 1.4], // optional: lay the shadow maps out about this point instead of
                             // about the player
  reflections: false,        // optional: true makes glossy surfaces mirror the scene around
                             // the player instead of only the sky (see "Shader hooks")
  near: 0.1,                 // optional: near clipping distance

  ground: (x, y, t) => 0,    // optional: height of the ground, for walk and drive
                             // (in fly and swim it is a floor the player cannot pass)
  ceiling: 40,               // optional: maximum height in fly and swim (number or function)
  solid: true,               // optional: false lets the player pass through everything
  alignToGround: true,       // optional: lean a car with the terrain's slope (a walker always stands upright)
  walkSpeed: 3, runSpeed: 8, // optional, metres per second
  eyeHeight: { walk: 1.7, drive: 1.25 },                  // optional
  body: { walk: { r: 0.35, lo: 0.45, hi: 1.8 }, fly: { r: 0.45 } },   // optional: the player's size
                             // for collisions (see "Solid things"); any of the numbers, also for
                             // drive and swim. jumpSpeed: 5 is the speed a jump starts at, m/s
  solidGrid: 4,              // optional: the cell size of the finest grid that solid triangles
                             // are sorted into, metres (see "A small world")
  accel: 1,                  // optional: how quickly drive, fly and swim change speed (times 0.25 C per second per second for a car, whose friction goes by it too, and 0.5 C for thrust)
  music: { seconds, build(m) { ... } },                    // optional: the scene's music, see "Music" below

  env: { dayLength: 600 },   // optional: settings for the built-in day/night sky (see below)
  wgsl: `...`,               // optional: shader hooks (see below)

  build(b) { ... },          // adds all geometry through the SceneBuilder `b`
};
```

A walker cannot go up ground steeper than 60° (the slope is measured over
0.8 m), and is slowed well before that. So a rise of more than about 1.4 m
that `ground` makes within a step's length is a wall to them, and one of 1 m
slows them to a sixth of their pace: give stairs and ramps a real slope, of
30° or less where people are meant to walk up briskly. A car's limit is 45°,
which a rise of 0.8 m already makes, and it loses a quarter of its speed on
20°: keep roads gentler than that.

In the modes with a ground, the player's `z` follows `ground` plus the eye
height. There are no collisions. `spawn.pos[2]` is ignored in those modes.

## Geometry: `Geo` (src/geom.js)

A `Geo` is a triangle mesh with per-vertex position, normal, colour, uv,
emissive strength, gloss, material id and flags. +Z is up; triangles are
counter-clockwise seen from outside. Colours are sRGB: `'#rrggbb'`, `0xrrggbb`
or `[r, g, b]` in 0..1.

Primitives (all static methods returning a new `Geo`):

| call | shape |
|---|---|
| `Geo.box(sx, sy, sz)` | box centred on the origin |
| `Geo.plane(sx, sy, nx = 1, ny = 1)` | rectangle in the XY plane facing +Z, `nx × ny` cells, uv 0..1 |
| `Geo.quad(p0, p1, p2, p3)` | flat quad through four points, counter-clockwise from the front |
| `Geo.triangle(p0, p1, p2)` | one triangle |
| `Geo.disc(r, seg)` | disc in the XY plane facing +Z |
| `Geo.sphere(r, seg = 20, rings = 12)` | sphere centred on the origin |
| `Geo.cylinder(r, h, seg = 16, { r2, caps })` | around Z from z = 0 to z = h; `r2` is the top radius |
| `Geo.cone(r, h, seg)` | cone with its base at z = 0 |
| `Geo.torus(R, r, seg, tube)` | ring around the Z axis |
| `Geo.lathe(profile, seg, { smooth })` | revolve `[[radius, z], ...]` (bottom to top) around Z |
| `Geo.extrude(polygon, h)` | simple polygon `[[x, y], ...]` extruded from z = 0 to z = h |
| `Geo.tube(points, r, seg, { caps })` | tube along a polyline; `r` may be a function of 0..1 |
| `Geo.heightfield(x0, y0, x1, y1, nx, ny, height, colorFn)` | terrain `z = height(x, y)`; `colorFn(x, y, z, normal)` |
| `Geo.merge(a, b, ...)` | all of them in one mesh |

Editing methods change the mesh in place and return it, so they chain:

```js
Geo.cylinder(0.2, 3, 8).rotateX(Math.PI / 2).translate(0, 0, 1).color('#888').gloss(0.6)
```

* `translate(x, y, z)`, `scale(x, y, z)`, `rotateX/Y/Z(angle)`, `transform(matrix)`
* `add(other, matrix?)` appends another mesh; `clone()` copies
* `color(c)`, `colorBy((position, normal, index) => colour)`
* `emissive(e)`: glow as a multiple of the colour. 1 looks lit in daylight, 4 and up blooms
* `gloss(v)`: 0 matte .. 1 mirror-like (sharp highlight, reflects the sky)
* `mat(id)`: material id 0..255, handed to the `surface` shader hook
* `additive()`: drawn as pure added light (colour × emissive), no shadow: beams, glows, flames, ghosts
* `unlit()`: colour shown as is, ignoring sun and shade
* `doubleSided()`: marks a thin sheet such as a leaf, a flag or a fin. Both sides of every
  triangle are always drawn; with this, whichever side is seen is lit as a front
* `noShadow()`: casts no shadow (it still receives them)
* `cutout()`: a mesh with holes, such as foliage, a fence or a grille. The
  `cutout` shader hook says for every pixel how much of the surface is there.
  The holes show in the mesh's shadow as well, and their edges are smoothed
* `blend(opacity)`: see-through, such as smoke, tinted glass or haze: drawn
  blended over whatever is behind it. `opacity` is 0..1, or a function
  `(position, normal, index) => opacity` for edges that fade out. Such a mesh
  casts no shadow, and the player passes through it unless it is added with
  `solid: true` (do that for a pane of glass)
* `aux(v)`: a spare number per vertex, -1..1 (or a function like `colorBy`'s),
  for the shader hooks to use as they like: it arrives as `s.aux`, blended
  across each triangle. `blend()` keeps its opacity here
* `tag(n)`: a spare whole number per vertex, 0..255, arriving as `s.tag`. It is
  not blended: a triangle has the tag of its first corner
* `untinted()`: for part of a mesh that is placed with `b.instances`: it keeps
  its own colour whatever tint a copy is given (a trunk, a post, a lamp)
* `flip()`, `computeNormals(smooth = true)`, `uvTransform(su, sv, ou, ov)`, `bounds()`

Rotations follow the right-hand rule: `rotateZ(a)` turns counter-clockwise seen
from above. Direct access is fine too: `g.p` (3 numbers per vertex), `g.n`,
`g.c`, `g.uv` (2), `g.a` (4: emissive, gloss, material, flags), `g.x` (2: aux,
tag), `g.idx`.

Matrices (`m4` in src/math.js) are column-major arrays of 16:
`m4.translation(x, y, z)`, `m4.scaling(x, y, z)`, `m4.rotationX/Y/Z(a)`,
`m4.rotationAxis(axis, a)`, `m4.mul(A, B, C)` (= A·B·C, so C acts first),
`m4.facing(pos, forward, up)` (places a model built with +Y forward and +Z up),
`m4.point(m, p)`, `m4.dir(m, d)`. `v3` has the usual vector helpers.

## Placing things in time: the builder

### `b.static(geo, { from, to, period, transform, solid, within })`

Geometry that does not move. This is the cheap kind: use it for everything
that stands still. Without options it exists forever.

### Detail that is only there from near by: `within`

`b.static`, `b.instances` and `b.dynamic` all take `within: metres`. Geometry
given with it is drawn only while the viewer is no further from it than that,
and costs nothing otherwise: it is the way to give things that can be walked
up to their small parts (door handles, faces, wheel spokes, rivets, the
lettering on a sign) without paying for them all over the scene.

```js
b.static(house, {});                          // the house, always
b.static(doorHandleAndLetterbox, { within: 15 });   // its small parts, from near by
b.instances(lampGlassDetail, lampPlaces, { within: 20 });
b.dynamic(faceAndButtons, { ...sameTimesAndTransformAsTheWalker, within: 12 });
```

* It is an addition, not a replacement: the plain version is always drawn, so
  model the object without its detail first and give the detail separately.
* The detail appears and disappears abruptly, so choose a distance at which it
  is too small to notice: a part 2 cm across is under a pixel beyond about
  25 m, one 10 cm across beyond about 120 m (at 1080 lines and the usual
  field of view).
* The distance is measured in space, to the geometry's bounding box: each
  `b.static` call's box, each cluster of an instanced call (the copies are put
  in clusters about twice the distance across, by themselves), and each
  stretch of a moving object's path. So give detail in pieces that are small
  compared with the distance: one call per house, not one for the whole street.
* Detail is solid like anything else that is static and lasting; pass
  `solid: false` for parts too small to matter.
* For something that moves, the distance is to where the thing is seen, so
  detail riding on a tram is drawn when the tram is near, however long the
  tram's run. Give the detail the same `times` and `transform` as what it
  belongs to.

**It is also solid**: the player cannot pass through it (see "Solid things"
below). Pass `solid: false` for what should be walked or flown through, such
as tall grass, curtains or a haze of small particles.

With `from`/`to` it exists only for `from <= t < to`. With `period > 0` that
window repeats: it is visible while `(t - from) mod period < to - from`. Use
this for blinking lights, signals changing colour (one mesh per state), things
that are there for part of each cycle. Seen through a tilted slice, such an
object is cut by a plane: one part of it already exists and the rest does not
yet. The cut shows the inside of the mesh in a flat dark shade.

Keep static triangles moderately small: **no edge longer than about 150 m**
(subdivide ground planes: `Geo.plane(2000, 2000, 20, 20)`). Near a tilt of 90°
everything is stretched hugely along the direction of the tilt, and enormous
triangles break down numerically.

### `b.instances(geo, placements, { from, to, period, solid })`

Many copies of one mesh that does not move: trees, posts, rocks, seats. The
mesh is stored once and drawn at every placement, so a forest of 5,000 trees
costs the memory and loading time of one tree plus 64 bytes a copy. (Each copy
is still drawn, so the budgets below count them all.)

```js
const places = spots.map(([x, y, turn, size]) => ({
  transform: m4.mul(m4.translation(x, y, ground(x, y)), m4.rotationZ(turn), m4.scaling(size)),
  tint: [0.9, 1.0, 0.8],   // optional: multiplies the mesh's colours for this copy
  data: 0.3,               // optional: a number of your own for this copy
  from: 2, to: 2.4, period: 6,   // optional: a time window of its own for this copy
}));
b.instances(treeGeo, places);
```

A placement may also be just a matrix. The tint and the number reach the
`surface` hook as `s.inst` (rgb the tint, which has already been applied to
`s.color`; w the number). Copies that are always there are solid like any
static mesh; give trunks and foliage as two calls if only the trunks should
stop the player.

Things to know:

* A tint multiplies the mesh's own colours, and a new mesh is light grey
  (0.8), not white. Give a mesh that is to take its colour from the tint
  `.color('#ffffff')`, and mark the parts that should keep their own colour
  with `.untinted()`.
* Every call is a draw call of its own in each layer it has triangles in, and
  again in every shadow cascade and every side of the reflection picture,
  whereas all plain `b.static` geometry without a time window is one draw call
  per layer. So instancing saves memory and loading time, not drawing time:
  use it for a few large groups, not for many small ones.
* Time windows (`from`, `to`, `period`) work as for `b.static`. Given in the
  options they hold for every copy; given in a placement, for that copy. So a
  row of lamps that blink one after another is one call, each copy with its
  own window. A call whose copies all share one window is skipped while the
  slice cannot reach that window; one whose copies have different windows is
  always drawn, and the pixels outside each copy's window are thrown away.
* A copy's normals are turned on the graphics card, exactly; those of
  `b.static` are turned first and then rounded to 8 bits. A pattern that the
  shader lays out from the normal and a large world coordinate can therefore
  shift by a little when a mesh is moved from one to the other: lay such
  patterns out from uv instead.

### `b.texture(name, { width, height, data, repeat, nearest })`

A table of numbers for the scene's shader to look up: baked lighting, a map of
where things are, a pattern too irregular for a formula. In the WGSL it
becomes a function with the name you gave:

```js
b.texture('wear', { width: 64, height: 64, data: bytes });   // in build()
```
```wgsl
let w = wear(s.pos.xy / 500.0 + 0.5);                          // in a hook: vec4f
```

`data` holds `width * height * channels` numbers, row by row, with row 0 at
v = 0; `channels` is 1, 2 or 4 and is worked out from the length. A
`Uint8Array` gives values from 0 to 1 (byte / 255); a `Float32Array` keeps its
values (stored as 16-bit floats, so about three significant digits). Lookups
blend between neighbouring entries unless `nearest: true`, and stop at the
edges unless `repeat: true`. There are no mipmaps: seen from far away, a
detailed pattern will shimmer, so keep tables smooth or fade them out with
distance. A scene can have up to four, and they can be used in any hook.

### `b.horizon(name, height, { x0, y0, x1, y1, nx, ny, reach, soft })`

Lets terrain cast its shadow at any distance and for any moment, which the
shadow maps cannot do: they only reach `shadowRadii` from the player, and they
are made for the sun as it stands at the player's own time. It works out, over
a grid of `nx` by `ny` points (default 128 by 128) across the area `x0..x1` by
`y0..y1`, how high the land given by `height(x, y)` stands against the sky in
16 compass directions, looking up to `reach` metres away (default 3000), and
gives the shader

```wgsl
fn <name>Sun(pos: vec3f, toLight: vec3f) -> f32                  // 0 in the land's shadow .. 1 in the open
fn <name>SunAt(pos: vec3f, toLight: vec3f, above: f32) -> f32    // the same for a point `above` metres over the land
```

Use it in `surface` with the light as it stands at the surface's own time:

```wgsl
s.sun *= landSun(s.pos, envSun(s.t).dir);
```

`<name>Sun` is for the ground itself. For anything standing on it (a tower, a
train in a cutting, a balloon) use `<name>SunAt` with the point's height over
the land: the table also holds how far away the land is that makes the
horizon, so the shader can work out how much lower that horizon lies from
higher up. Without it a tall thing gets the answer for the ground at its
foot, and something in a cutting is shaded by the cutting's own banks. The
shader does not know the land's height: pass the height in `.aux`, or work it
out from `s.pos.z` where the land is level.

The shadow's edge is soft (`soft`, in radians, default 0.03), and `steps`
(default 40) is how many distances are looked at in each direction. It takes
one of the scene's four textures.

### Solid things

Every static triangle that is always there is an obstacle, from both sides.
There is nothing else to set up: an arch is open because its triangles leave
it open. What is *not* solid:

* geometry with a time window (`from`, `to`), and everything `b.dynamic` adds;
* additive geometry (light);
* anything added with `solid: false`;
* triangles lying on the ground: all three corners within 0.35 m of `ground`
  (or of height 0 if the scene starts in walk or drive and has no `ground`).
  That covers terrain meshes, paving, road markings and low kerbs. The ground
  is followed, not run into, so **a terrain mesh must match the `ground`
  function** to within that distance or it turns into an obstacle.

The player is an upright cylinder on the ground (walking: 0.35 m radius, from
0.45 m to 1.8 m above the feet; driving: 0.9 m radius, 0.35 m to 1.3 m) and a
sphere of 0.45 m radius when flying or swimming. So:

* a walker steps over anything lower than 0.45 m and passes under anything
  higher than 1.8 m; make a doorway or a gap at least 1 m wide (2.2 m for cars);
* a walker can jump: the feet rise 1.27 m (in a level slice: tilted up or
  down, less), enough to clear a fence of that height at a run or to get on
  top of a wall. They come down on the ground or
  on whatever solid surface is under them, slopes included, and can walk on
  from there (up or down steps of about 0.25 m) until they step off the edge.
  Only what stands at least 0.45 m above the ground can be stood on; a jump
  stops under a ceiling;
* surfaces are sheets, not volumes: a player who starts inside a closed shape
  cannot get out, so keep the spawn point in the open;
* a lot of small static clutter at body height in a path (chair legs, twigs)
  makes it awkward to get through: mark it `solid: false`.

`solid: false` in the scene definition switches collisions off altogether.

### A small world

The defaults suit streets and landscapes. A scene the size of a room, with
things on tables that are centimetres across, sets a few of them itself
(`src/scenes/workshop.js` is one):

* `near: 0.01`, so that the player can look at something from a few
  centimetres away.
* `body`: the player's size. The default flyer is a sphere of 0.45 m radius
  that is kept 0.6 m above the ground and 0.4 m under a `ceiling`;
  `body: { fly: { r: 0.05 } }` makes all three a ninth of that. A walker's
  cylinder (`r`, and `lo` to `hi` above the feet) can be made slimmer the same
  way; the steps a walker takes up and down (0.25 m and 0.3 m) and the search
  for a place to stand after landing go by it too.
* `solidGrid: 0.25` or so. Solid triangles are sorted into grids over x and y
  whose cells are 4 m at the finest; in a room that is one cell for
  everything, and every solid triangle is then tested each time the player
  moves. Take a cell a few times the size of the player's body. Even so,
  keep small detail `solid: false`: a player cannot get into a clockwork.
* Shadows. `shadowRadii: [r]` with `shadowCentre` at the middle of the room is
  one map that covers all of it, whichever corner the player stands in: 2048
  pixels across `2 r`, so 5 mm a pixel for `r = 5`. A single map fades out
  between 0.8 r and r from its centre, so take `r` a quarter more than the
  distance from the centre to the furthest corner. (Two cascades, the first
  a metre or two about the player, give sharper shadows close by for one pass
  more.) `shadowDepth` is how far the maps reach along the light either side
  of the centre: a little more than the room is long. Sunlight comes in
  through whatever the walls leave open, and only through that if walls,
  floor and ceiling have thickness and overlap where they meet: sheets that
  merely touch let a line of light through along the join.
* `adaptiveTimes` has tolerances in metres for traffic (0.08 m): pass
  `tolerance`, `minStep` and `size` of your own.
* Triangles within 0.35 m of the ground count as ground (see above), so low
  things on the floor are not obstacles; that is a fixed figure.
* A scene whose `C` is under 1 m/s has its readouts in cm/s and cm (in/s and
  inches for a player who chose mph). In texts for the player, write a speed
  as `{0.08 m/s}` all the same: one under 0.5 m/s is shown as "8 cm/s".
* With a small `C` a tilted slice reaches far in time (5 m at 0.1 m/s is 50 s
  at 90°), and every repeat of the scene's `period` within that reach is
  drawn again: take a long period. Cycles cost nothing for how long they run,
  so an hour is as cheap as a minute.

### `b.dynamic(geo, options)`

Geometry that moves or changes. The mesh is sampled at a list of key times;
between two keys every vertex moves in a straight line at constant speed.

```js
b.dynamic(car, {
  times: timeRange(0, 60, 0.25),       // or: from, to, step
  transform: (t) => matrix,            // where the mesh is at time t
  paint: (t) => ({ color, emissive }), // optional: recolour the whole mesh over time
  holdBefore: false,                   // keep the first pose for all earlier times
  holdAfter: false,                    // keep the last pose for all later times
  caps: 'auto',                        // see below
});
```

`geo` may also be a function `t => Geo` for meshes that change shape (a waving
flag, a growing plant). Every result must have the same vertex count and
triangle list.

Each triangle becomes three tetrahedra per key interval, and a tilted view
draws those of every interval its slice passes through, so **key times are the
budget** for drawing:

* straight motion at constant speed needs only two keys, however long it lasts.
  Give straight legs their end points as keys: `times: [0, 28, 30, 58, 60]`;
* anything that turns or accelerates needs keys close enough that straight
  segments look right: a quarter of a second for a car on a bend, a twelfth of
  a bounce for a ball. A sudden change of direction must land exactly on a key;
* keep moving meshes simple (tens of triangles, not thousands).

What it takes to store depends on the kind of motion:

* A mesh that is only moved (a fixed `Geo`, a `transform`, no `paint`) is
  stored once, however many keys it has, with a matrix per key: 64 bytes a
  key. Cars, trams, fish, walking figures built from stiff parts: nearly
  everything is of this kind, and it is cheap. Two calls with the same mesh
  share it, so a hundred fish of one kind store one fish. The motion may be
  any matrix (turned, scaled, mirrored), and between keys each vertex still
  goes in a straight line.
* A mesh that changes shape (`geo` given as a function) or colour (`paint`)
  is stored vertex by vertex at every key, 32 bytes a vertex. Keep those for
  what needs them and does not repeat (a growing plant, a melting snowman),
  and build things that could be stiff parts out of stiff parts.
* A mesh with a movement of its own that repeats, while it is taken somewhere
  (a walker's stride, a wing beat, a waving flag, a turning wheel), is stored
  as the few poses of one round of that movement, once: see `cycle` below.

An object that neither starts from nor ends in nothing has open ends in time.
`caps` seals them so that a tilted slice through its first or last moment looks
solid: `'auto'` seals every end that is not held, `'none'` seals nothing (right
for anything that loops, see below), or `'start'`, `'end'`, `'both'`. An object
that scales up from zero and back down to zero is closed already.

### A movement that repeats: `cycle`

Much of what moves does two things at once: it goes somewhere, and all the
while it does the same small thing over and over. A walker strides, a bird
beats its wings, a fish wags its tail, a wheel turns, a flag waves. Keyed the
plain way, the small thing sets the pace: a key at every swing for as long as
the journey lasts, each of them stored. With `cycle`, one round of the small
movement is given as a few poses, which are stored once, and `times` only has
to follow the journey:

```js
// a walker's legs and arms as one mesh, swung by an angle that goes there and back once a round
const limbs = (u) => {
  const a = 0.5 * Math.cos(2 * Math.PI * u);
  return Geo.merge(leg(-0.1, a), leg(0.1, -a), arm(-0.24, -a), arm(0.24, a));
};
b.dynamic(limbs, {
  times, transform: tf,                         // the journey: the very keys of the walker's body
  cycle: { period: 1.04, keys: 4, start: t0 },  // two steps to a round, four poses of it
});
```

* `period` is the seconds a round takes, `keys` the number of poses stored
  for it, evenly spaced over the round (default 4), and `start` a time at
  which a round begins (default 0). Things that should not move in step get
  different `start`s.
* Pose `i` is the mesh at `u = i / keys`. Give `geo` as a function
  `u => Geo` to change its shape over the round (the same vertex count and
  triangle list every time), or give `cycle.transform: u => matrix` to move a
  fixed mesh within its own frame before `transform` places it, or both. A
  wheel: `cycle: { period, keys: 16, transform: (u) => m4.rotationX(-2 * Math.PI * u) }`.
  `cycle.paint: u => ({ color, emissive })` repaints the mesh over the round.
* Between two poses every vertex goes in a straight line within the mesh's
  own frame, and its normal, its colour (as stored, that is in sRGB, with the
  emissive) and its `aux` go evenly from the one to the other; texture
  coordinates, material, gloss, flags and tag are the earlier pose's, so keep
  those the same in all poses. After the last pose comes the first again. A small swing of a short part can be given
  as its two ends (`keys: 2`); a stride wants four poses, a wave a pose every
  eighth of it, and something that turns all the way round one every 20° or
  so (but see below on what happens to triangles between poses).
* A round has to bring every vertex back to where it started, since the first
  pose follows the last. A wheel's round is therefore a whole turn, however
  many identical spokes it has. Identical blades or spokes that are meshes of
  their own can share one blade's whole turn: the same mesh and cycle with a
  different `start` each (`start: -i * period / n`).
* A triangle whose corners move differently from one pose to the next (any
  triangle of something that turns) is not flat in between: the three
  tetrahedra that stand for its sweep fold it, by up to a quarter of the
  difference between its corners' movements. That is about `L × a / 4` for a
  triangle that reaches `L` along the radius and turns by the angle `a`
  (in radians) between poses: 3 cm for a walker's leg in one piece swinging
  through 30°, but 2 m for a 30 m turbine blade at a pose every 15°. A level
  view shows it as a crease that comes and goes, a tilted one as a wide
  ribbon or saw teeth. So split long turning parts along their length (a rod
  in three pieces folds a third as much, in three places) and give big ones
  more poses. The same holds for any moving mesh between its keys.
* Walkers, as worked out in `src/scenes/plaza.js` (`walkingLimbs`): two
  straight legs swung between two poses cross like an X at mid-stride (the
  fold again). Four poses to a stride do, with each leg in two pieces split
  at the knee, the swinging foot lifted a little and its knee forward at the
  two poses where the feet pass, and the leg's vertices listed from the foot
  up, so that what fold is left bends the leg forward like a knee. Build a
  limb once and transform it for each pose: a mesh built afresh at every pose
  must come out with its vertices in the same places round the limb, or the
  limb collapses in between. Step length about `0.5 + 0.18 × speed` metres,
  period `2 × step / speed`, and a `start` of its own for every walker.
* Where only part of a thing moves by itself (a fish's tail, a walker's
  limbs), make that part a mesh of its own with the cycle and leave the rest
  on the plain keys: the stiff part is then drawn once where the slice finds
  it, however quick the beat.
* What turns faster than the screen can show (a wheel's spokes passing more
  than about 20 times a second) appears to stand still or turn backwards
  from frame to frame, whatever its poses: draw that as a blur, in the
  `surface` hook (see the wheels in `src/scenes/circuit.js`), not as a cycle.
* `transform` and `times` are as for a mesh that is only moved: a straight run
  needs two keys, a bend needs them close. (Between two keys the placing
  matrix goes evenly from the one to the other, which is the same thing as
  every vertex going in a straight line.) Put the parts of one thing on the
  same `times` and `transform`: they then share the stored keys.
* `paint`, and a `geo` that is a function of the time, do not go with `cycle`.
  `caps`, `holdBefore`, `holdAfter` and `within` work as usual.

What it costs to keep: the poses, 32 bytes a vertex and pose, once (meshes
with the same poses share them), and 64 bytes for each of the journey's keys.
The length of the journey does not come into it. A stiff mesh that its round
only moves (a fixed `Geo` with `cycle.transform` and no `cycle.paint`: a
gear, a clock hand, a pendulum, a wheel) costs less still: the mesh once, and
64 bytes a pose for the matrix, however many vertices it has. So build what
is stiff out of stiff parts, give them as many poses as the movement wants,
and keep meshes that change shape for what does change shape. (Identical
meshes are stored once here too, and so are identical rounds.)

What it costs to draw is what the mesh costs at any one moment: its
triangles, three tetrahedra each, where the slice finds it, in the picture and
in every shadow map it stands in. That is the same as for a mesh on plain
keys. (The statistics count a step for every stretch from pose to pose along
the way, so `tetrahedra` goes up a great deal. Nothing is stored for a step
and nothing is looked through for it: the renderer works out which steps a
slice can touch from where the thing is at the two keys either side, and
draws those.) So giving a movement to something that is drawn already costs
nothing, and adding limbs costs their triangles. One thing does cost: poses
that follow each other more quickly than the slice crosses the thing (its
size across the slice, over `C`: a hundredth of a second for a walker when
level, more when tilted far) are drawn several at a time. So a movement of a
few rounds a second is free, and one of fifty a second on something big is
not. `tools/cost.mjs` shows it; measure before and after.

Where it pays:

* in place of a mesh that was stored vertex by vertex at many keys for a
  movement that in fact repeats (a flag, a wing beat, a jet of water): the
  picture stays the same and the storage shrinks to one round;
* for movement that was left out because of what it would have cost to
  store: strides, tail beats, turning wheels, rocking boats, nodding heads.
  Put everything that moves with one period in one mesh (all four limbs), so
  that it is one thing more to draw and not four.

`src/scenes/enginetest.js` has one of each kind in its back row, and builds
the same things the long way round with `?cyclebrute=1`, for comparing.

### Scenes that repeat

With `period: P`, the dynamic geometry is drawn again every `P` seconds, forever
in both directions. Author it for `0 <= t <= P` and make it join up: every
object's pose at `t = P` must equal its pose at `t = 0` (loops whose duration
divides `P`, rotations with a whole number of turns, and so on), and pass
`caps: 'none'`. Static time windows are separate: give them their own `period`.
Shader effects that depend on `t` (sky, clocks, materials) are not affected by
the scene period at all.

An object may also be authored over a whole multiple of the period, say
`0 <= t <= 3 * P`, as long as it joins up at the ends. Because everything is
repeated every `P` seconds, it then appears as three copies following one
another a period apart: a cheap way to fill a long loop with evenly spaced
traffic.

With `period: 0` the scene has a beginning and an end; use `holdBefore` and
`holdAfter` so things do not vanish outside the timed part.

### Budgets

The shot tool prints the totals and how many tetrahedra a view draws, and
`node tools/cost.mjs <scene>` counts what a running frame hands to the GPU
over all its passes, from the starting point at several tilts and from any
views you add, as triangles, tetrahedra, draw calls and one combined score;
with `--save` and `--against` it compares a scene with what it was before a
change (see the head of that file).

* static geometry: up to about 300,000 triangles;
* tetrahedra: the total matters little by itself (meshes that only move are
  stored once, see `b.dynamic`); what counts is how many a view draws. The
  renderer only processes the chunks of each object that the player's slice
  actually passes through, so that is normally a small fraction of the total,
  at any tilt. If the printed "drawing N tetrahedra" goes beyond a few hundred
  thousand, something has far more keys or triangles than it needs.

How many tetrahedra a tilted view draws depends on how far into the past and
the future its slice reaches within the scene: `viewDistance × sin(tilt) / C`
seconds each way. Every moving thing in sight is drawn at each of its key
steps that the slice passes through, and once more for each period that fits
into that reach, in the picture and again in every shadow map it stands in.
With a small `C`, a long view and a short period that multiplies quickly (a
scene with C = 5 m/s and 2.6 km of view reaches six minutes each way at 45°).
Then give the small moving things `within`, at a distance where they are a
pixel or two, so that only what is near is drawn; keep straight runs to two
keys; and keep `shadowRadii` and `viewDistance` no larger than the place
needs. `tools/cost.mjs` prints the tetrahedra per frame for each view.

Those figures suit phones as well. A scene meant for desktop graphics cards
can go to roughly 1,000,000 static triangles, with no more than about
400,000 tetrahedra and 1,500 draw calls in any one view (two or three times
that over all the passes of a frame, which is what `tools/cost.mjs` counts).
`ground` is called for every static triangle when the scene loads (to tell
terrain from obstacles), so keep it cheap. These limits are estimates: nothing
here has been timed on a real graphics card. `src/scenes/valley.js` and
`src/scenes/pier.js` are the scenes built to this tier, and
`src/scenes/workshop.js` is at the same cost with far less that stands still
and far more that moves (see "A small world").

A frame is drawn in several passes: the picture, two or three shadow maps, and
one side of the reflection picture if the scene has `reflections`. Static
geometry is drawn in each pass that can see it. The builder sorts it into
cells of neighbouring triangles (about two thousand each) and large instanced
groups into clusters of neighbouring copies, and the renderer leaves a cell or
cluster out of a pass whose view volume it lies wholly outside: the pyramid of
the picture, the box of space a shadow map covers, the quarter of the
surroundings a side of the reflection picture shows. So what a view costs
depends on what is in front of the camera and round it, not on the whole
scene: a town seen from inside costs less than the same town seen from a hill.
The widest shadow map takes in the most; keep `shadowRadii` no larger than the
scene needs. Moving geometry is tested the same way, chunk by chunk, and what
a pass draws of it goes to the GPU in one draw call for each repeat of the
scene in sight (a few a pass), however scattered: it costs by its tetrahedra,
not by how many things it is.

A slice tilted close to 90° touches a thing for a long time: one of height
`h`, in a slice tilted up by `λ`, for `h tan λ / C` seconds, and at 90°, where
the slice stands along time, something that stays in its place for as long as
there is. Two things keep that from being drawn in full. Of a mesh with a
`cycle`, the picture draws only the steps during which the thing can be
inside its pyramid: the few seconds of a clock's wheel that fit on the screen,
not the hour of it that the slice touches. And at 90° itself moving geometry
is left out of the shadow maps, because nothing in such a slice can shade
anything else in it: what casts a shadow and what it falls on would have to be
at the same place. Just short of 90° that does not hold, and the shadow maps
then take everything the slice touches within their reach: the views between
about 85° and 90° are the dearest a scene has, several times a level one.
In a scene with `reflections` so is the view at 90° itself, because every
side of the reflection picture takes all the moving geometry the slice
touches, whichever way the side looks.
`node tools/cost.mjs <scene> --view "lift=89" --view "lift=90"` counts them.

On a device that cannot keep up, the page lowers the resolution it draws at,
and with it the distance from which detail given with `within` is drawn.

## Helpers (src/util.js)

* `rng(seed)` returns a deterministic random function with `.range(a, b)`,
  `.int(a, b)`, `.pick(list)`. Use it instead of `Math.random()`.
* `timeRange(from, to, step)` gives evenly spaced key times including both ends.
* `adaptiveTimes(transform, from, to, { tolerance, minStep, maxStep, size })`
  gives key times placed only where the motion needs them: it splits the span
  until the motion between keys is within `tolerance` metres (default 0.08) of
  a straight line. Straight stretches get two keys, bends get many. This is
  the easy way to stay inside the budget:
  `const tf = follow(path, {...}); b.dynamic(car, { times: adaptiveTimes(tf, 0, P), transform: tf, caps: 'none' })`.
  `size` is roughly the object's radius, `maxStep` (default 2 s) the coarsest spacing tried.
* `new Path(points, { closed, smooth })` is a polyline (optionally a smoothed
  loop) with `.length`, `.at(distance)` and `.smoothAt(distance, span)`, each
  returning `{ p, dir }`.
* `follow(path, { speed, offset, span, lift })` returns a `transform` that
  carries a model (+Y forward, +Z up) along a path. For a loop of length `L`
  in a scene of period `P`, use `speed: k * L / P` for a whole number `k`.
* `lerp`, `clamp`, `smoothstep`.

## Shader hooks (WGSL)

`wgsl` is a string of WGSL that may define any of these functions. Either
define all four `env…` functions or none of them (then the built-in day/night
sky is used, configured by `env`).

```wgsl
fn envSun(t: f32) -> Light                                // Light(dir towards the light, colour)
fn envSky(dir: vec3f, t: f32) -> vec3f                    // sky colour in a direction at a time
fn envAmbient(n: vec3f, t: f32) -> vec3f                  // light from all around onto a normal
fn envFog(dir: vec3f, t: f32, dist: f32) -> vec4f         // rgb = fog colour, a = amount 0..1
fn surface(s: Surface) -> Surface                         // per-pixel material
```

Two more are optional:

```wgsl
fn cutout(s: Surface) -> f32                              // how much of a mesh with holes is there
fn envReflect(dir: vec3f, t: f32, lit: f32) -> vec3f      // what glossy surfaces mirror (with your own sky)
```

`cutout` is for meshes marked with `.cutout()`: return 1 where the surface is
solid and 0 where there is a hole, with a soft step in between (the engine
sharpens it to the width of a pixel). It is asked before `surface`, and again
when the shadow maps are drawn, where only `pos`, `t`, `uv`, `color`, `mat`,
`aux`, `tag` and `inst` are filled in. There `dist` is 0, which is how the
hook can tell (a shadow map's pixels are far coarser than the picture's, so a
pattern that fades with `fwidth` may want to behave differently). It runs for
every pixel of every opaque mesh, so return 1 at once for materials without
holes.

By default glossy surfaces mirror the sky in the reflected direction, and
nothing tells them what stands in between: a shop window in a narrow alley
mirrors the sky as if the houses opposite were not there. So leave out of `envReflect` whatever
would give that away. Stars and other small bright things show as points of
light in a dark wall, and sparkle as the view moves. A sun or moon should be
scaled by `lit`, which is 1 where the light of `envSun` reaches the surface
and 0 where the surface is in shadow. Without an `envReflect` of your own,
surfaces mirror `envSky` as it is. The built-in day/night sky comes with one
that does both of these things.

With `reflections: true` in the scene definition, glossy surfaces mirror the
scene instead: the renderer keeps a picture of everything around the player
(sky from `envReflect`, opaque and additive geometry), bringing one of its six
sides up to date each frame, and surfaces look their reflection up in it.
Distant things come out right: mountains in a lake, a skyline in a window.
Things close to the mirror do not, because the picture is taken from where the
player stands, not from the mirror: a post standing in a puddle is not
mirrored at its foot. See-through geometry is not in the picture. It costs
about as much as one more shadow cascade. A still from the shot tool draws all
six sides at once, where a running frame draws one, so the tool prints both
counts of draw calls.

Everything is linear HDR: 1.0 is white on screen after tone mapping, larger
values glow. A daylight sun is about `vec3f(1.3)`, daytime ambient about 0.3.

`surface` receives and returns:

```wgsl
struct Surface {
  pos: vec3f,      // world position
  t: f32,          // the time at which this point is being seen
  n: vec3f,        // world normal (you may bend it)
  uv: vec2f,
  view: vec3f,     // direction in space from the eye to the point
  dist: f32,       // distance along the line of sight
  color: vec3f,    // albedo, linear
  emissive: f32,   // glow, as a multiple of the albedo
  gloss: f32,
  light: vec3f,    // extra incoming light to add (lamps you compute yourself)
  sun: f32,        // multiplier on direct sunlight: cloud shadows, caustics, depth
  ambient: f32,    // multiplier on ambient light: fake occlusion
  mat: u32,        // the material id set with .mat(id)
  alpha: f32,      // opacity of see-through geometry (.blend): 0 clear .. 1 solid
  aux: f32,        // the mesh's spare value set with .aux(v), -1..1
  tag: u32,        // the mesh's spare whole number set with .tag(n), 0..255
  inst: vec4f,     // for b.instances: rgb the copy's tint, w its own number (1, 1, 1, 0 otherwise)
};
```

`s.t` is what makes materials show time: `clock7(uv, s.t)` draws a running
digital clock, a lamp can light up when `envDaylight(s.t)` is low, water can
ripple with `s.t`. Everything keyed to `s.t` shows the tilt automatically.

Available to hooks: `G.P` (player position `x, y, z, t`), `PI`, `TAU`,
`saturate`, `srgbToLinear`, `hash11/21/22/31/33`, `noise2`, `noise3`, `fbm2`,
`fbm3` (all 0..1), `sdSegment`, `digit7(uv, d)`, `number7(uv, value, digits)`,
`clock7(uv, seconds)` (uv 0..1 with v upwards; they return coverage 0..1).

The built-in sky, for scenes that keep it:

```js
import { dayNightEnv } from '../env.js';
wgsl: dayNightEnv({ dayLength: 300, startHour: 10, sunTilt: 0.6, fog: 0.0035, clouds: 0.5,
                    zenith: '#3d7fd6', horizon: '#b9d7ee' }) + `fn surface(...) ...`
```

It also defines `envSunVec(t)`, `envDayPhase(t)` (0 midnight, 0.5 noon),
`envDaylight(t)` (0 night .. 1 day) and `envSkyBase(dir, t)`. Passing the same
options as `env: {...}` instead works when you write no `env…` hooks yourself.

Rules that will otherwise cost you time:

* WGSL has no implicit conversions: write `1.0` for floats, `3u` for unsigned.
  `mod`, `ref`, `filter`, `from`, `target`, `type`, `set`, `static`, `shared`,
  `common`, `pass`, `get`, `new`, `self`, `this`, `use`, `with`, `where`,
  `final`, `active`, `smooth`, `move`, `of` are reserved words and cannot be
  names.
* The `env…` functions also run in vertex shaders: no derivatives
  (`dpdx`, `fwidth`) in them. `surface` and `cutout` may use derivatives, but
  only at their very top, before any `if`: `let fw = fwidth(s.pos.xy);`.
* `envSky` is evaluated for every sky pixel, and it or `envReflect` again for
  every glossy surface pixel, so keep them reasonably cheap. `envFog` runs for every surface pixel: keep it very cheap.
* A shader error is reported with its line number within your `wgsl` string.
* uv coordinates on dynamic geometry are stored as 16-bit floats: keep them
  small (0 to about 8).

## Sky and fog

A pixel of sky is a ray inside the tilted slice, so it too looks into the past
or the future. It is taken to end on a shell `skyDistance` away, which gives
`envSky` its `t`. Fog blends surfaces towards `envFog`, which is given that
same sky time, so distant things dissolve into the sky behind them.

Set `skyDistance` to about the distance at which your fog has swallowed
everything (roughly `3 / fog density`). Then the horizon and the sky agree
whatever the tilt. With a day/night cycle the result is striking: tilted far,
the sky on one side is hours earlier than the sky on the other. For that to show, a day
should last a few minutes: the sky spans `±skyDistance·sin θ / C` seconds.

`viewDistance` is a hard limit for dynamic geometry: anything moving that is
further from the player than this is not drawn, level or tilted. Set it to
the distance at which fog hides things or, without fog, to the size of the
scene.

Shadows come from one sun direction, taken at the player's own time; where a
surface's time has the sun somewhere quite different they fade out.

`dayNightEnv` (src/env.js) is the ready-made sky. A scene that wants the day
to run unevenly, or the sun on another path, need not write a sky of its own:
`dayNightEnv({ ..., own: ['envDayPhase', 'envSunVec'] })` leaves those two
functions (either or both) for the scene's WGSL to define, with the built-in
ones at hand as `envDayPhase0` and `envSunVec0`. `src/scenes/pier.js` slows
its dusk and turns its sunset that way. Do not edit the text that
`dayNightEnv` returns: the single-file build shortens it.

## Music

A scene gets its music from the `music` of its definition; without one it is
silent. That is a score: the length of its loop, how the whole sounds, and a
`build(m)` that puts the notes down.

```js
music: {
  seconds: 32,               // the length of the loop
  bpm: 120,                  // optional: beats a minute, which sets m.beat
  reverb: 2,                 // how long the hall rings, seconds
  echo: [0.375, 0.3],        // seconds between repeats, and how much of each comes back
  seed: 7,                   // for m.rand(), which is the same every time
  // tail: 4,                // how long sounds may ring on past the loop's end (they are carried over to its start)
  // lowpass: 4000,          // a filter over the whole piece, Hz
  build(m) {
    const { notes } = m;
    const keys = m.track({ pan: -0.3, hall: 0.3, echo: 0.2 });   // a place in the mix
    const soft = m.track({ hall: 0.5 });
    m.pad(soft, 0, 16, notes('A2 E3 A3 C4'), { cutoff: 900 });   // a chord: time, length, pitches
    for (let i = 0; i < 64; i++) m.bell(keys, i * 0.25, 69 + [0, 3, 7, 12][i % 4], { partials: 'bars', decay: 0.5 });
  },
},
```

`m` has `track`, the pitched sounds `tone`, `bell`, `pluck`, `pad` and `drone`,
`noise`, and the drums `kick`, `snare`, `hat`, `tick`, `thud`, `jingle` and
`bubble`; `m.beat` is the length of a beat and `m.rand()` a random number that
is the same every time. Pitches are MIDI numbers, and `m.n('F#4')`,
`m.notes('C3 E3 G3')` and `m.tune(start, unit, 'E5 G5:2 -:.5', play)` write
them by name. All of these are described where they are defined, in
`src/music.js`. Times are seconds from the start of the loop; what still rings
at its end is carried over to the start. Every scene in `src/scenes/` has a
score to look at.

The piece is tied to the scene's time: second 0 of the loop sounds at scene
time 0, and it is played at the pace of the player's own time, backwards when
that runs backwards. So choose a loop that divides one of the scene's own
cycles if it has any, put beats on whole seconds if there are clocks to keep
step with, and expect the piece to be heard slowed down and in reverse: long
notes and plain rhythms survive that best. Keep the bass modest (a piece is
brought to a set loudness as a whole, so a heavy bass makes the rest quiet).
Write your own notes: nothing in a score may be someone else's tune.

Nobody can listen on a machine without sound, so check a score by what can be
measured: render it in a browser with `renderPiece(def.music)` from
`src/music.js` and look at its level second by second, at how much of it lies
below 200 Hz, and at which pitches it holds.

## Testing

```
node tools/shot.mjs --scene myscene --out /tmp/a.png
     [--pos x,y,z] [--t seconds] [--yaw deg] [--pitch deg]
     [--tilt deg] [--tiltdir deg] [--lift deg] [--mode walk|drive|fly|swim] [--size 960x540] [--hud] [--tint 0|1|2]
```

renders one frame in headless Chromium (software WebGPU, a few seconds per
frame) and prints the build statistics, the tetrahedra drawn and any errors.
`--scene` takes the file name, so a scene can be tested before it is listed in
`src/scenes/index.js`. Add `--browser firefox` (under `xvfb-run -a`) to render
in Firefox instead, an independent WebGPU implementation, and run
`node tools/check-wgsl.mjs myscene` to validate the shader with naga, the
WGSL compiler Firefox uses; the two compilers do not accept exactly the same
programs. `--tilt 30` tilts the slice by 30° as the tilting control does from
a level view, so that the future lies to the right and the past to the left.
`--tiltdir` says where the future lies instead, in degrees clockwise from the
heading: `270` is the control's other direction, `0` shows the future ahead
and `180` the past ahead, as a player sees it who has turned after tilting.
`--lift 30` tilts the slice upwards as well, or instead: the future above.
The player in a shot stands still.
Use `--mode fly` with `--pitch -30` and a high `--pos` for overviews.
A shot has the slight colouring by time that the page starts out with (a warm
cast on the player's past, a cool one on their future), so a tilted view comes
out a little warmer or cooler than the scene's own colours. `--tint 0` leaves
it out, and `--tint 2` gives the full colouring (amber and blue, a line per
second), which shows where the slice lies. `--fov 15` zooms
in on something distant.

A still frame at a time that falls exactly on the edge of a `b.static` time
window, or on a whole second of a shader clock, can show speckle or the
neighbouring value, because rounding decides each pixel separately. It is an
artefact of the exact instant, not of the scene: use times such as `--t 60.3`.

```
node tools/check-solids.mjs myscene
```

builds the scene in node, without a browser, and checks what the player can
run into: that the spawn point is clear, how far the player gets travelling
straight ahead from it with and without collisions, and that roaming at random
in each control mode, with the view tilted this way and that, never crosses a
solid surface. It also prints the build
time and how many static triangles are solid. If "touching something" is a
large share of the frames on the route the scene's hint suggests, there is
clutter in the way that wants `solid: false`.

```
node tools/cost.mjs myscene [--view "pos=x,y,z yaw=deg tilt=deg t=seconds"]...
     [--save before.json] [--against before.json --budget 1.2]
```

counts what a frame hands to the graphics card (triangles, tetrahedra, draw
calls, and a score made of them) from the starting point at several tilts and
from any views you add: see "Budgets". Add views in the busiest places, tilted
by 60° and more. To hold a change to a budget, save the numbers before it and
compare after it.

These counts are the measure to go by. Frame times here come from software
renderers, each with a bias of its own: Chromium's (SwiftShader) runs every
branch of the `surface` and `cutout` hooks for every pixel, so a longer hook
slows everything there whether or not it is used, and Firefox's (lavapipe)
charges far more for a draw call than a graphics card does. A graphics card
runs only the branch a pixel takes; so keep each material's own branch short,
and put what only part of a surface needs behind a test of where the pixel
is.

Look at the picture every time. Check several places and times, level and
tilted (`--tilt 30`, `60`, `85`, `120`, and some with `--tiltdir 180`), and check a periodic scene on both
sides of the seam (`--t` just below and just above a multiple of the period).
Firefox's renderer is about ten times quicker than Chromium's for a heavy
scene, which makes it the one to look around with; check the final pictures
in both.
