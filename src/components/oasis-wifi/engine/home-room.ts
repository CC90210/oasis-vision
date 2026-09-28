/**
 * The OASIS WIFI room for THIS COMPUTER mode, sized to the operator's room.
 *
 * A schematic, not a scan: walls, floor, a door and a window give the space
 * scale and orientation, the desk marks where this computer and its webcam
 * are, and the router sits in a corner. Nothing here is sensed. The sensed
 * things are drawn on top by the scene: the link's disturbance, and (with
 * the camera on) the tracked body.
 *
 * Walls between the viewer and the room fade out as the view orbits
 * ("cutaway"), so the inside is never hidden behind a wall.
 */
import * as THREE from 'three';
import type { RoomBounds } from '@/lib/wifi-sensing/body';
import { DEFAULT_HOME_ROOM, sanitizeRoom, type HomeRoom } from '@/lib/wifi-sensing/room';

export { DEFAULT_HOME_ROOM, sanitizeRoom, type HomeRoom };

const COL = {
  cyan: 0x00e5ff,
  gold: 0xd4af37,
  goldDim: 0x8b7325,
  wall: 0x0b1620,
  wallEmissive: 0x05101a,
  floor: 0x0d0c0a,
  wood: 0x3a3226,
  metal: 0x9a9aa2,
};

interface Wall {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  edgeMat: THREE.LineBasicMaterial;
  center: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface HomeRoomParts {
  group: THREE.Group;
  room: HomeRoom;
  bounds: RoomBounds;
  walls: Wall[];
  routerPos: THREE.Vector3;
  /** The webcam on the monitor, looking into the room. */
  webcam: { position: THREE.Vector3; forward: [number, number] };
  /** Where the link beam ends: the monitor. */
  computerPoint: THREE.Vector3;
  deskFloor: THREE.Vector3;
  screenMat: THREE.MeshStandardMaterial;
  webcamLedMat: THREE.MeshBasicMaterial;
  frustum: THREE.Group;
  viewFrom: THREE.Vector3;
  viewTarget: THREE.Vector3;
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function lines(points: number[], color: number, opacity: number): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
}

/** Build the room. `hfovDeg`/`aspect` shape the webcam's field-of-view wedge. */
export function buildHomeRoom(input: HomeRoom, hfovDeg = 78, aspect = 16 / 9): HomeRoomParts {
  const room = sanitizeRoom(input);
  const { width: W, depth: D, height: H } = room;
  const hw = W / 2, hd = D / 2;
  const group = new THREE.Group();
  group.name = 'home-room';

  // Floor, and a floor grid: a line every 0.5 m, brighter every metre.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ color: COL.floor, roughness: 0.85, metalness: 0.15 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);
  const minor: number[] = [];
  const major: number[] = [];
  for (let x = -hw; x <= hw + 1e-6; x += 0.5) {
    const onMetre = Math.abs(x - Math.round(x)) < 1e-6;
    (onMetre ? major : minor).push(x, 0.004, -hd, x, 0.004, hd);
  }
  for (let z = -hd; z <= hd + 1e-6; z += 0.5) {
    const onMetre = Math.abs(z - Math.round(z)) < 1e-6;
    (onMetre ? major : minor).push(-hw, 0.004, z, hw, 0.004, z);
  }
  group.add(lines(minor, COL.goldDim, 0.12));
  group.add(lines(major, COL.gold, 0.2));

  // A rug under the middle of the room, for scale.
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.min(2.4, W * 0.45), Math.min(1.7, D * 0.4)),
    new THREE.MeshStandardMaterial({ color: 0x1c1712, roughness: 1 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.006, hd * 0.25);
  rug.receiveShadow = true;
  group.add(rug);

  // Walls: translucent, with edges; each knows its outward normal for the cutaway.
  const walls: Wall[] = [];
  const addWall = (len: number, cx: number, cz: number, rotY: number, normal: THREE.Vector3) => {
    const mat = new THREE.MeshStandardMaterial({
      color: COL.wall, emissive: COL.wallEmissive, emissiveIntensity: 0.6,
      transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, roughness: 0.9,
    });
    const geo = new THREE.PlaneGeometry(len, H);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, H / 2, cz);
    mesh.rotation.y = rotY;
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: COL.goldDim, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    mesh.add(edge);
    group.add(mesh);
    walls.push({ mesh, mat, edgeMat: edge.material as THREE.LineBasicMaterial, center: mesh.position.clone(), normal });
  };
  addWall(W, 0, -hd, 0, new THREE.Vector3(0, 0, -1)); // back
  addWall(W, 0, hd, Math.PI, new THREE.Vector3(0, 0, 1)); // front
  addWall(D, -hw, 0, Math.PI / 2, new THREE.Vector3(-1, 0, 0)); // left
  addWall(D, hw, 0, -Math.PI / 2, new THREE.Vector3(1, 0, 0)); // right

  // Door, on the right wall near the front.
  const doorZ = Math.min(hd - 0.7, Math.max(-hd + 0.7, hd - 1.1));
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x241b10, roughness: 0.7, transparent: true, opacity: 0.7 });
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.88, 2.03), doorMat);
  door.position.set(hw - 0.012, 1.015, doorZ);
  door.rotation.y = -Math.PI / 2;
  group.add(door);
  group.add(lines([
    hw - 0.02, 0, doorZ - 0.46, hw - 0.02, 2.06, doorZ - 0.46,
    hw - 0.02, 0, doorZ + 0.46, hw - 0.02, 2.06, doorZ + 0.46,
    hw - 0.02, 2.06, doorZ - 0.46, hw - 0.02, 2.06, doorZ + 0.46,
  ], COL.gold, 0.55));
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 10), new THREE.MeshStandardMaterial({ color: COL.gold, metalness: 0.9, roughness: 0.3 }));
  knob.position.set(hw - 0.05, 1.0, doorZ - 0.34);
  group.add(knob);

  // Window, on the left wall.
  const winZ = Math.min(hd - 1, 0.2), wy0 = 0.95, wy1 = 2.05, ww = Math.min(1.4, D * 0.3);
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(ww, wy1 - wy0),
    new THREE.MeshStandardMaterial({ color: 0x0a1830, emissive: 0x0a2040, emissiveIntensity: 0.8, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
  );
  glass.position.set(-hw + 0.012, (wy0 + wy1) / 2, winZ);
  glass.rotation.y = Math.PI / 2;
  group.add(glass);
  const x = -hw + 0.02, z0 = winZ - ww / 2, z1 = winZ + ww / 2, ym = (wy0 + wy1) / 2;
  group.add(lines([
    x, wy0, z0, x, wy0, z1, x, wy1, z0, x, wy1, z1,
    x, wy0, z0, x, wy1, z0, x, wy0, z1, x, wy1, z1,
    x, wy0, winZ, x, wy1, winZ, x, ym, z0, x, ym, z1,
  ], COL.gold, 0.5));

  // Ceiling light.
  const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.22, 32), new THREE.MeshBasicMaterial({ color: 0xfff0d8 }));
  lamp.rotation.x = Math.PI / 2;
  lamp.position.set(0, H - 0.01, 0);
  group.add(lamp);
  const lampLight = new THREE.PointLight(0xffe8c0, 0.8, Math.max(W, D) * 1.4, 1.2);
  lampLight.position.set(0, H - 0.3, 0);
  group.add(lampLight);

  // Desk against the back wall, a monitor, and the webcam on top of it.
  const deskX = Math.min(hw - 1.0, W * 0.12), deskZ = -hd + 0.4;
  const wood = new THREE.MeshStandardMaterial({ color: COL.wood, roughness: 0.6, emissive: 0x0c0a06, emissiveIntensity: 0.3 });
  group.add(box(1.4, 0.05, 0.7, wood, deskX, 0.745, deskZ));
  for (const [dx, dz] of [[-0.64, -0.3], [0.64, -0.3], [-0.64, 0.3], [0.64, 0.3]]) {
    group.add(box(0.05, 0.72, 0.05, wood, deskX + dx, 0.36, deskZ + dz));
  }
  const metal = new THREE.MeshStandardMaterial({ color: COL.metal, roughness: 0.3, metalness: 0.8 });
  group.add(box(0.06, 0.2, 0.06, metal, deskX, 0.87, deskZ - 0.12));
  const monitorY = 1.12, monitorZ = deskZ - 0.1;
  group.add(box(0.64, 0.39, 0.03, metal, deskX, monitorY, monitorZ));
  const screenMat = new THREE.MeshStandardMaterial({ color: 0x06121a, emissive: COL.cyan, emissiveIntensity: 0.25, roughness: 0.2 });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.34), screenMat);
  screen.position.set(deskX, monitorY, monitorZ + 0.016);
  group.add(screen);
  group.add(box(0.46, 0.02, 0.16, metal, deskX, 0.78, deskZ + 0.14));
  const camY = monitorY + 0.215;
  group.add(box(0.09, 0.03, 0.04, new THREE.MeshStandardMaterial({ color: 0x222228, roughness: 0.4 }), deskX, camY, monitorZ + 0.005));
  const webcamLedMat = new THREE.MeshBasicMaterial({ color: 0x1a3a1a });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 8), webcamLedMat);
  led.position.set(deskX + 0.03, camY, monitorZ + 0.027);
  group.add(led);

  // Router on a small table in the back-left corner.
  const routerPos = new THREE.Vector3(-hw + 0.45, 0.62, -hd + 0.35);
  group.add(box(0.5, 0.55, 0.4, wood, routerPos.x, 0.275, routerPos.z));

  // The webcam's field of view: a wedge out to the model's ~4 m range,
  // cut off where it meets the floor. Shown only while the camera is on.
  const webcamPos = new THREE.Vector3(deskX, camY, monitorZ + 0.03);
  const frustum = new THREE.Group();
  const F = new THREE.Vector3(0, 0, 1), R = new THREE.Vector3(-1, 0, 0), UP = new THREE.Vector3(0, 1, 0);
  const th = Math.tan(((hfovDeg * Math.PI) / 180) / 2);
  const tv = th / (aspect || 16 / 9);
  const corners: THREE.Vector3[] = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const dir = F.clone().addScaledVector(R, th * sx).addScaledVector(UP, tv * sy).normalize();
    let len = 4;
    if (dir.y < 0) len = Math.min(len, webcamPos.y / -dir.y);
    corners.push(webcamPos.clone().addScaledVector(dir, len));
  }
  const faces: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    faces.push(webcamPos.x, webcamPos.y, webcamPos.z, a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const faceGeo = new THREE.BufferGeometry();
  faceGeo.setAttribute('position', new THREE.Float32BufferAttribute(faces, 3));
  frustum.add(new THREE.Mesh(faceGeo, new THREE.MeshBasicMaterial({ color: COL.cyan, transparent: true, opacity: 0.035, side: THREE.DoubleSide, depthWrite: false })));
  const edgePts: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    edgePts.push(webcamPos.x, webcamPos.y, webcamPos.z, a.x, a.y, a.z, a.x, a.y, a.z, b.x, b.y, b.z);
  }
  frustum.add(lines(edgePts, COL.cyan, 0.22));
  frustum.visible = false;
  group.add(frustum);

  return {
    group,
    room,
    bounds: { minX: -hw, maxX: hw, minZ: -hd, maxZ: hd },
    walls,
    routerPos,
    webcam: { position: webcamPos, forward: [0, 1] },
    computerPoint: new THREE.Vector3(deskX, monitorY, monitorZ),
    deskFloor: new THREE.Vector3(deskX, 0.012, deskZ + 0.55),
    screenMat,
    webcamLedMat,
    frustum,
    // Behind and above the desk, looking into the room: a tracked person faces the viewer.
    viewFrom: new THREE.Vector3(W * 0.3, H + 1.7, -hd - Math.max(3, D * 0.7)),
    viewTarget: new THREE.Vector3(0, 0.9, hd * 0.15),
  };
}

/** Fade the walls that stand between the viewer and the room. */
export function applyCutaway(parts: HomeRoomParts, cameraPos: THREE.Vector3): void {
  const d = new THREE.Vector3();
  for (const w of parts.walls) {
    const outside = d.subVectors(cameraPos, w.center).dot(w.normal) > 0;
    const target = outside ? 0.025 : 0.16;
    const edge = outside ? 0.1 : 0.4;
    w.mat.opacity += (target - w.mat.opacity) * 0.15;
    w.edgeMat.opacity += (edge - w.edgeMat.opacity) * 0.15;
  }
}

export function disposeHomeRoom(parts: HomeRoomParts): void {
  parts.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose?.();
  });
  parts.group.removeFromParent();
}
