// The units in which the page shows speeds and lengths.  The scenes
// themselves are in metres and seconds throughout.
//   label   how the speed unit is written
//   perMs   that many of it make one metre per second
//   length, perM   the unit of length that goes with it, likewise
//   span    the stretch (in that unit of length) over which the HUD says how
//           much earlier or later you are looking

export const UNITS = {
  ms: { label: 'm/s', perMs: 1, length: 'm', perM: 1, span: 10 },
  kmh: { label: 'km/h', perMs: 3.6, length: 'm', perM: 1, span: 10 },
  mph: { label: 'mph', perMs: 2.2369363, length: 'ft', perM: 3.2808399, span: 30 },
};

// A speed of v metres per second for a readout: "12.4 m/s", "108 km/h" (one
// decimal below a hundred, none from there, unless `digits` says otherwise).
export function speedText(u, v, digits) {
  const x = v * u.perMs;
  return `${x.toFixed(digits ?? (Math.abs(x) < 99.95 ? 1 : 0))} ${u.label}`;
}

// The same as a round figure for running text: "30 m/s", "67 mph".
export const roundSpeed = (u, v) => `${Math.round(v * u.perMs)} ${u.label}`;

// A length of d metres as a round figure: "10 m", "33 ft".
export const roundLength = (u, d) => `${Math.round(d * u.perM)} ${u.length}`;

// A text in which speeds are written as "{15 m/s}", with those put in the
// units u.
export const withUnits = (u, text) => text.replace(/\{([\d.]+) m\/s\}/g, (_, v) => roundSpeed(u, Number(v)));
