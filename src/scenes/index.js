// The scenes on offer, from the lightest to draw to the heaviest (by the score
// of tools/cost.mjs): the first one is what the page opens with, behind the
// menu.  Each module's default export is a scene definition (see
// docs/SCENES.md); they are loaded on demand.  `hint` is shown for a few
// seconds the first time the scene is entered (`touchHint` on a touch screen).
// A speed in these texts is written as "{15 m/s}" and shown in the units the
// player has chosen.
// `weight` is the mark on the scene's card for how much there is to draw, from
// 1 to 6: each step is about twice the score.  `work` is roughly how much
// geometry the scene's build makes, in bytes (the `work` of its statistics),
// which the loading bar goes by the first time a scene is loaded on a device.

export const SCENES = [
  {
    id: 'lab',
    name: 'Time Lab',
    mode: 'walk',
    blurb: 'A bare test range of clocks, traffic and pendulums. Every clock shows the moment you are seeing it at.',
    hint: 'Roll the mouse wheel forward (or hold X): the view tilts into time. Every clock down the runway shows an earlier time than the one before it, and they all run slower: at 90° they stop. Walk on (W) and your own clock slows further.',
    touchHint: 'Hold + at the lower right: the view tilts into time. Every clock down the runway shows an earlier time than the one before it, and they all run slower: at 90° they stop. Walk on and your own clock slows further.',
    weight: 1,
    work: 0.4e6,
    load: () => import('./lab.js'),
  },
  {
    id: 'orbit',
    name: 'Orbital Station',
    mode: 'fly',
    blurb: 'Free flight round a spinning ring station above a blue planet, with shuttles, convoys and lanes of chasing beacons.',
    hint: 'Face along a lane of beacons and roll the mouse wheel (or hold Z or X): tilting the view one way makes their running pulses speed up, light all at once at 45° and then run backwards. W thrusts, B brakes.',
    touchHint: 'Face along a lane of beacons and hold − or + at the lower right: tilting the view one way makes their running pulses speed up, light all at once at 45° and then run backwards. The left stick thrusts.',
    weight: 2,
    work: 4.9e6,
    load: () => import('./orbit.js'),
  },
  {
    id: 'circuit',
    name: 'Coastal Circuit',
    mode: 'drive',
    blurb: 'Drive a 3.6 km seaside circuit among traffic, past a train and a ladder of timing boards down the main straight.',
    hint: 'Roll the mouse wheel forward (or hold X) to tilt the view into time: every timing board down the straight shows an earlier time than the one before it. Then drive (W): tilted, the car heads into the past as well as down the road.',
    touchHint: 'Hold + at the lower right to tilt the view into time: every timing board down the straight shows an earlier time than the one before it. Then push the left stick up to drive: tilted, the car heads into the past as well as down the road.',
    weight: 2,
    work: 8.6e6,
    load: () => import('./circuit.js'),
  },
  {
    id: 'plaza',
    name: 'Old Town',
    mode: 'walk',
    blurb: 'A walled town on a festival day: trams, cyclists and walkers on a long avenue, and a clock tower that keeps time with the sky.',
    hint: 'Roll the mouse wheel forward (or hold X): the view tilts into time. The clock tower up the avenue shows an earlier and earlier hour, and the town slows down until, at 90°, it stands still. R makes everything level again.',
    touchHint: 'Hold + at the lower right: the view tilts into time. The clock tower up the avenue shows an earlier and earlier hour, and the town slows down until, at 90°, it stands still. The level button undoes it.',
    weight: 3,
    work: 12.3e6,
    load: () => import('./plaza.js'),
  },
  {
    id: 'reef',
    name: 'Coral Reef',
    mode: 'swim',
    blurb: 'Swim a sunlit reef channel past bubbling vents, lanes of fish, mantas, whale sharks and a wreck.',
    hint: 'Roll the mouse wheel (or hold Z or X) to tilt the view into time: the vents, which all puff together, now go off one after another down the channel, and the fish swimming along it stretch out or bunch up. At 90° the reef stands still. W swims.',
    touchHint: 'Hold − or + at the lower right to tilt the view into time: the vents, which all puff together, now go off one after another down the channel, and the fish swimming along it stretch out or bunch up. At 90° the reef stands still.',
    weight: 4,
    work: 11.5e6,
    load: () => import('./reef.js'),
  },
  {
    id: 'valley',
    name: 'Winter Valley',
    mode: 'walk',
    blurb: 'An alpine valley from late afternoon into night: a lantern path through a hamlet, a frozen lake with skaters, a chairlift, an aerial tram, and the ridge\'s shadow sweeping over it all. The detailed one, meant for desktop graphics cards.',
    hint: 'Roll the mouse wheel forward (or hold X) to tilt the view into time: the mountains at the head of the valley are lit by an earlier sun than the hamlet. Roll it back past level, and night comes from ahead. R makes it level again.',
    touchHint: 'Hold + at the lower right to tilt the view into time: the mountains at the head of the valley are lit by an earlier sun than the hamlet. Hold − past level, and night comes from ahead. The level button undoes it.',
    weight: 5,
    work: 20e6,
    load: () => import('./valley.js'),
  },
  {
    id: 'pier',
    name: 'Pleasure Pier',
    mode: 'walk',
    blurb: 'A Victorian pier at dusk on a day that runs fast: a pier railway, a fairground with a big wheel, fireworks over the sea, a lighthouse, and the tide coming in and going out. The most intricate one, for desktop graphics cards.',
    hint: 'Roll the mouse wheel forward (or hold X): ahead, the sun climbs back over the sea, and when a train comes in from the pier head it stretches out along the whole track. Roll it back past level (Z) and night falls ahead, with fireworks. R makes the view level again.',
    touchHint: 'Hold + at the lower right: ahead, the sun climbs back over the sea, and when a train comes in from the pier head it stretches out along the whole track. Hold − and night falls ahead, with fireworks. The level button undoes it.',
    weight: 5,
    work: 16e6,
    load: () => import('./pier.js'),
  },
];
