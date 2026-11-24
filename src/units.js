// The units in which the page shows speeds and lengths.  The scenes
// themselves are in metres and seconds throughout.
//   label   how the speed unit is written
//   perMs   that many of it make one metre per second
//   length, perM   the unit of length that goes with it, likewise
//   span    the stretch (in that unit of length) over which the HUD says how
//           much earlier or later you are looking

//   small   the same for a scene in which things move at centimetres a
//           second, and for a speed of that size in a text

const CM = { label: 'cm/s', perMs: 100, length: 'cm', perM: 100, span: 10 };
const INCH = { label: 'in/s', perMs: 39.370079, length: 'in', perM: 39.370079, span: 4 };
export const UNITS = {
  ms: { label: 'm/s', perMs: 1, length: 'm', perM: 1, span: 10, small: CM },
  kmh: { label: 'km/h', perMs: 3.6, length: 'm', perM: 1, span: 10, small: CM },
  mph: { label: 'mph', perMs: 2.2369363, length: 'ft', perM: 3.2808399, span: 30, small: INCH },
};

// The units to show a scene in whose speeds go by C metres per second (its
// definition's C), given the player's choice of them, a key of UNITS.
export const unitsFor = (id, C) => (C < 1 ? UNITS[id].small : UNITS[id]);

// A speed of v metres per second for a readout: "12.4 m/s", "108 km/h" (one
// decimal below a hundred, none from there, unless `digits` says otherwise).
export function speedText(u, v, digits) {
  const x = v * u.perMs;
  return `${x.toFixed(digits ?? (Math.abs(x) < 99.95 ? 1 : 0))} ${u.label}`;
}

// The same as a round figure for running text: "30 m/s", "67 mph"; a speed
// under half a metre a second in the smaller units: "8 cm/s", "3 in/s".
export const roundSpeed = (u, v) => {
  const w = Math.abs(v) < 0.5 && u.small ? u.small : u;
  return `${Math.round(v * w.perMs)} ${w.label}`;
};

// A length of d metres as a round figure: "10 m", "33 ft".
export const roundLength = (u, d) => `${Math.round(d * u.perM)} ${u.length}`;

// A text in which speeds are written as "{15 m/s}", with those put in the
// units u.
export const withUnits = (u, text) => text.replace(/\{([\d.]+) m\/s\}/g, (_, v) => roundSpeed(u, Number(v)));
