# The tilt4d concept

This is a demonstration of how graphics rendering is a projection from 3d to 2d, and can be extended to be one from 4d to 2d instead.

Our world is a "static" 4D scene, consisting of planar dimensions X and Y, up/down dimension Z, and "scene time" dimension T. It is a single description of a 4d world, with objects moving around and appearing and disappearing. The player/camera cannot interact with them, just move around, travelling through time and space to observe it.

The player has 4 vectors that define their view and behavior: the screen right direction R (initially X), the screen up direction U (initially Z), the camera direction F (initially Y), and the movement direction V (initially T). All 4 are always orthogonal to each other, and have fixed magnitude (with some fixed conversion factor between distance and time called C, though this is not a relativistic world and light travels instantaneously).

Consider how normal sideways rotation (typical mouse sideways movement) is a rotation of the F and R vectors in their respective plane. And how upwards rotation (nouse up) is rotation of the F and U vectors in their respective plane. In tilt4d, acceleration becomes a rotation of the F and V vectors in their plane. This means when starting from a normal stationary position, accelerating means you start moving forward in space, but also slowing down in time (despite the similarity, still not relativity), and more surprisingly, in front of you you start seeing the past, and if were to rotate backward, behind you you would start seeing the future. At maximum speed (C) time would stand still and you only move through space. Accelerate even further and you slow back down in space, but time starts running backward.

As another analogy, which perhaps could be explained in an introduction, imagine you are in an elevator in a big building. You can only look sideways, i.e., see one floor at a time. Every floor represents one timestamp in scene time, and the elevator moving upward makes the scene you see change over time. Moving forward, if you chose to do so, would now correspond to the elevator shaft tiltint forward, still going mostly up but also leaning a bit forward, causing you to move through the scene. But because of the tilt, you also bend forward slightly, and thus looking straight ahead will show you lower floors, and looking behind you will show you higher floors. The tilt4d concept is a higher-dimensional generalization of this, where there is still a real up dimension, separate from scene time.

All of this can be implemented using 4x4 matrix whose columns are R,U,F,V. Each of the abstract controls (turning left/right, turning up/down, and the time tilting effect) are matrix multiplications applied to it.

# Controls

So far we have only described how acceleration/deceleration are replaced with a rotation in a plane that includes times, but not how to actually explore the world.

There are multiple possibilities for this, and all of them may be interesting:
• An first-person view, walking around, with walking and running speeds that show the tilting effect mildly only. If instead there were additional faster/slower controls in running mode, the full effect could be explored.
• Car race game style controls that allow finer control over speed.
• Space travel with acceleration.
• Under water travel.

In settings where there is a "ground", I think the U vector should always point straint in the Z direction, and mouse up/down is mapped to a separate after the fact up/down rotation of view that doesn't affect the 4x4 control matrix. If the land has different heights, the U vector may need to remain orthogonal to the ground, however, to maintain V such that the camera/player stay on the ground.

Third person view would be very interesting, but possibly hard and confusing, as it would require the player to see themselves, including their past (doable, strange) and their future (using some prediction for it?).

Similarly, interactivity may be hard but would be cool. I can imagine buttons/locks in a game that change the future of the scene, but leave the past untouched.

# Implementation

I want a browser-playable demo of the concept, using webgpu or something similar to get decent graphics quality. It doesn't need to be photorealistic, but should look nice. Use Opus sub-agents to create the scenes.
