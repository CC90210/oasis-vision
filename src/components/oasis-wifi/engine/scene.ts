/*! OASIS WIFI scene. Derived from RuView ui/observatory/js/main.js (commit
 * 5ef001b4, MIT, Copyright (c) 2024 rUv — see ./LICENSE-RUVIEW).
 *
 * Changes from the original: no DOM lookups beyond the canvas it is given, no
 * WebSocket auto-detection, no HUD (the React view owns every label), sized to
 * its container rather than the window, a dispose() that releases the WebGL
 * context, OASIS colours, two room layouts, and a per-source rendering policy:
 *
 *   sim   everything the RuView demo draws, in RuView's 12 x 10 m room — the
 *         view labels it SIMULATION.
 *   node  figures and the floor field only when the node's data supports them
 *         (CSI, or a node openly replaying simulation); never for a node that
 *         synthesised them from laptop RSSI. RuView's room, because node
 *         positions are in its coordinates.
 *   host  the operator's room (home-room.ts). This computer's WiFi link is
 *         drawn as a link whose brightness is the measured disturbance: one
 *         RSSI number locates no one, so the link alone never draws a person.
 *         With the webcam on, the figure is the tracked body — real joints,
 *         approximately placed — and it is the camera, not WiFi, that sees it.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DemoDataGenerator } from './demo-data.js';
import { NebulaBackground } from './nebula-background.js';
import { PostProcessing } from './post-processing.js';
import { FigurePool } from './figure-pool.js';
import { PoseSystem } from './pose-system.js';
import { ScenarioProps } from './scenario-props.js';
import { applyCutaway, buildHomeRoom, disposeHomeRoom, DEFAULT_HOME_ROOM, type HomeRoom, type HomeRoomParts } from './home-room';
import { personsMayBeDrawn } from '@/lib/wifi-sensing/frames';
import { placeBody, smoothPlacement, toRoomBody, type CameraRig, type Landmark, type Placement, type PlacementResult, type RoomBody } from '@/lib/wifi-sensing/body';
import type { SensingFrame, SourceKind } from '@/lib/wifi-sensing/types';

const C = {
  cyan: 0x00e5ff,
  gold: 0xd4af37,
  amber: 0xff9500,
  green: 0x00e676,
  blueSignal: 0x2090ff,
  bgDeep: 0x06060c,
  gridMain: 0x5c4d24,
  gridSub: 0x2a2412,
  roomEdge: 0x8b7325,
};

/** RuView's "foundation" look, recoloured to the OASIS palette. */
const SETTINGS = {
  bloom: 0.08, bloomRadius: 0.2, bloomThresh: 0.6,
  exposure: 1.3, vignette: 0.25, grain: 0.01, chromatic: 0.0005,
  boneThick: 0.018, jointSize: 0.035, glow: 0.3, trail: 0.35,
  wireColor: '#00E5FF', jointColor: '#D4AF37', aura: 0.02,
  field: 0.45, waves: 0.28, ambient: 0.7, reflect: 0.2,
  fov: 50, orbitSpeed: 0.15, cycle: 30,
};

/** RuView's room: where the demo scenarios and node positions live. */
const RUVIEW_ROUTER = new THREE.Vector3(-4, 0.92, -3);
/** A body not re-seen for this long is taken as gone (bridges single dropped frames). */
const BODY_HOLD_MS = 600;

type Layout = 'ruview' | 'home';

/** What the HUD is told about each rendered moment (throttled to ~10 Hz). */
export interface SceneTick {
  frame: SensingFrame | null;
  /** Simulation only: the scenario on screen and whether it is auto-cycling. */
  scenario: string | null;
  autoCycle: boolean;
  paused: boolean;
  fps: number;
  /** Webcam body, when one is being drawn: where it stands relative to the camera. */
  body: Placement | null;
  /** Why a person the camera sees is not drawn: shoulders or hips hidden, or out of range. */
  bodyIssue: BodyIssue | null;
}

export type BodyIssue = Extract<PlacementResult, { ok: false }>['reason'];

/** One webcam frame's pose, as the tracker hands it over. */
export interface PoseInput {
  image: Landmark[];
  world: Landmark[];
  aspect: number;
}

type AnyFrame = Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any

export class WifiObservatoryScene {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();
  private readonly settings = { ...SETTINGS };
  private readonly onTick: (t: SceneTick) => void;
  private readonly resizeObserver: ResizeObserver;

  /* eslint-disable @typescript-eslint/no-explicit-any -- vendored JS classes */
  private readonly demo: any;
  private readonly nebula: any;
  private readonly post: any;
  private readonly figures: any;
  private readonly props: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  private mode: SourceKind = 'host';
  private layout: Layout = 'home';
  private external: SensingFrame | null = null;
  /** `external` with what may not be drawn removed; rebuilt only when it changes. */
  private drawable: AnyFrame = null;

  private raf = 0;
  private disposed = false;
  private autopilot = false;
  private autoAngle = 0;
  private lastTick = -1;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 60;
  private quality = 2;

  private ruviewLayout!: THREE.Group;
  private home!: HomeRoomParts;
  private homeRoom: HomeRoom = DEFAULT_HOME_ROOM;
  private routerGroup!: THREE.Group;
  private routerLed!: THREE.Mesh;
  private routerLight!: THREE.PointLight;
  private waves: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; phase: number }> = [];
  private mist!: THREE.Points;
  private mistCount = 800;
  private trail!: THREE.Points;
  private trailCount = 200;
  private trailHead = 0;
  private trailTimer = 0;
  private fieldPoints!: THREE.Points;
  private fieldColors!: Float32Array;
  private fieldSizes!: Float32Array;
  private hostLink!: THREE.Group;
  private beamMat!: THREE.MeshBasicMaterial;
  private beamGlow!: THREE.Mesh;
  private beamGlowMat!: THREE.MeshBasicMaterial;
  private pulseRing!: THREE.Mesh;
  private pulseMat!: THREE.MeshBasicMaterial;

  private cameraOn = false;
  private hfovDeg = 78;
  private placement: Placement | null = null;
  private body: RoomBody | null = null;
  private bodyIssue: BodyIssue | null = null;
  private bodyAt = 0;
  private bodyShown = false;

  constructor(canvas: HTMLCanvasElement, container: HTMLElement, onTick: (t: SceneTick) => void, room: HomeRoom = DEFAULT_HOME_ROOM) {
    this.container = container;
    this.onTick = onTick;
    this.homeRoom = room;
    const { w, h } = this.size();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.settings.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(C.bgDeep);
    this.scene.fog = new THREE.FogExp2(C.bgDeep, 0.005);

    this.camera = new THREE.PerspectiveCamera(this.settings.fov, w / h, 0.1, 300);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 25;
    this.controls.maxPolarAngle = Math.PI * 0.88;

    this.demo = new DemoDataGenerator();
    this.demo.setCycleDuration(this.settings.cycle);

    this.setupLighting();
    this.nebula = new NebulaBackground(this.scene);
    this.buildRuviewLayout();
    this.home = buildHomeRoom(this.homeRoom, this.hfovDeg);
    this.scene.add(this.home.group);
    this.buildRouter();
    this.figures = new FigurePool(this.scene, this.settings, new PoseSystem());
    this.props = new ScenarioProps(this.scene);
    this.buildMist();
    this.buildTrail();
    this.buildWaves();
    this.buildField();
    this.buildHostLink();
    this.applyLayout();
    this.resetCamera();

    this.post = new PostProcessing(this.renderer, this.scene, this.camera);
    this.post._bloomPass.strength = this.settings.bloom;
    this.post._bloomPass.radius = this.settings.bloomRadius;
    this.post._bloomPass.threshold = this.settings.bloomThresh;
    this.post._vignettePass.uniforms.uVignetteStrength.value = this.settings.vignette;
    this.post._vignettePass.uniforms.uGrainStrength.value = this.settings.grain;
    this.post._vignettePass.uniforms.uChromaticStrength.value = this.settings.chromatic;
    this.post.resize(w, h);

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);

    this.animate = this.animate.bind(this);
    this.raf = requestAnimationFrame(this.animate);
  }

  // ---- Public API --------------------------------------------------------

  setMode(mode: SourceKind): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.setFrame(null);
    const layout: Layout = mode === 'host' ? 'home' : 'ruview';
    if (layout !== this.layout) {
      this.layout = layout;
      this.applyLayout();
      this.resetCamera();
    }
  }

  /** The latest frame from the host or a node. Ignored in simulation mode. */
  setFrame(frame: SensingFrame | null): void {
    this.external = frame;
    if (!frame) {
      this.drawable = null;
      return;
    }
    const people = personsMayBeDrawn(frame);
    const field = frame.provenance === 'csi' || frame.provenance === 'simulated';
    this.drawable = {
      ...frame,
      scenario: null,
      persons: people ? frame.persons ?? [] : [],
      signal_field: field ? frame.signal_field : undefined,
      classification: { ...frame.classification, presence: people ? frame.classification?.presence : false },
    };
  }

  /** Resize the operator's room (THIS COMPUTER mode). */
  setHomeRoom(room: HomeRoom, force = false): void {
    const cur = this.homeRoom;
    if (!force && cur.width === room.width && cur.depth === room.depth && cur.height === room.height) return;
    this.homeRoom = room;
    disposeHomeRoom(this.home);
    this.home = buildHomeRoom(room, this.hfovDeg);
    this.scene.add(this.home.group);
    this.buildHostLink();
    this.placement = null;
    this.applyLayout();
    if (this.layout === 'home') this.resetCamera();
  }

  /** Webcam tracking on/off: shows its field of view and lights its LED. */
  setCameraActive(on: boolean, hfovDeg = this.hfovDeg): void {
    this.cameraOn = on;
    if (hfovDeg !== this.hfovDeg) {
      // The field-of-view wedge is part of the room geometry.
      this.hfovDeg = hfovDeg;
      this.setHomeRoom(this.homeRoom, true);
    }
    this.applyLayout();
    if (!on) this.setPose(null);
  }

  /** A webcam pose (or null for "nobody in view"). Placed with the desk webcam's geometry. */
  setPose(pose: PoseInput | null): void {
    if (!pose) {
      this.placement = null;
      this.bodyIssue = null;
      return;
    }
    const rig = this.webcamRig(pose.aspect);
    const placed = placeBody(pose.image, rig);
    if (!placed.ok) {
      this.bodyIssue = placed.reason;
      return;
    }
    this.bodyIssue = null;
    // A body that has been gone a while starts where it is, not sliding in from where it was.
    const gone = performance.now() - this.bodyAt > BODY_HOLD_MS;
    this.placement = smoothPlacement(gone ? null : this.placement, placed.placement);
    const body = toRoomBody(pose.world, pose.image, this.placement, rig, this.home.bounds);
    if (!body) return;
    this.body = body;
    this.bodyAt = performance.now();
  }

  setScenario(key: string): void {
    this.demo.setScenario(key);
  }

  nextScenario(): void {
    this.demo.cycleScenario();
  }

  setPaused(paused: boolean): void {
    this.demo.paused = paused;
  }

  get paused(): boolean {
    return !!this.demo.paused;
  }

  toggleAutopilot(): boolean {
    this.autopilot = !this.autopilot;
    this.controls.enabled = !this.autopilot;
    return this.autopilot;
  }

  resetCamera(): void {
    if (this.layout === 'home' && this.home) {
      this.camera.position.copy(this.home.viewFrom);
      this.controls.target.copy(this.home.viewTarget);
    } else {
      this.camera.position.set(6, 5, 8);
      this.controls.target.set(0, 1.2, 0);
    }
    this.controls.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.post.dispose();
    this.nebula.dispose();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose?.();
    });
    this.renderer.dispose();
    // Hand the GL context back now: browsers cap live contexts, and the map
    // needs one when the operator switches back to WORLD VIEW.
    this.renderer.forceContextLoss();
  }

  // ---- Construction ------------------------------------------------------

  private size(): { w: number; h: number } {
    return { w: Math.max(1, this.container.clientWidth), h: Math.max(1, this.container.clientHeight) };
  }

  private webcamRig(aspect: number): CameraRig {
    const p = this.home.webcam.position;
    return { position: [p.x, p.y, p.z], forward: this.home.webcam.forward, hfovDeg: this.hfovDeg, aspect };
  }

  private setupLighting(): void {
    this.scene.add(new THREE.AmbientLight(0xccccdd, this.settings.ambient * 5.0));
    this.scene.add(new THREE.HemisphereLight(0x6688bb, 0x203040, 1.2));
    const key = new THREE.DirectionalLight(0xffeedd, 1.2);
    key.position.set(4, 8, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 20;
    key.shadow.camera.left = -8;
    key.shadow.camera.right = 8;
    key.shadow.camera.top = 8;
    key.shadow.camera.bottom = -8;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8899bb, 0.7);
    fill.position.set(-4, 5, -2);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0x6699cc, 0.5);
    rim.position.set(0, 6, -5);
    this.scene.add(rim);
  }

  /** RuView's 12 x 10 m room: grid, outline, reflective floor, router table. */
  private buildRuviewLayout(): void {
    const g = new THREE.Group();
    const grid = new THREE.GridHelper(12, 24, C.gridMain, C.gridSub);
    (grid.material as THREE.Material).opacity = 0.5;
    (grid.material as THREE.Material).transparent = true;
    g.add(grid);
    const roomWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(12, 4, 10)),
      new THREE.LineBasicMaterial({ color: C.roomEdge, opacity: 0.3, transparent: true }),
    );
    roomWire.position.y = 2;
    g.add(roomWire);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 10),
      new THREE.MeshStandardMaterial({
        color: 0x0e0d0a, roughness: 1.0 - this.settings.reflect * 0.7, metalness: this.settings.reflect * 0.5,
        emissive: 0x040302, emissiveIntensity: 0.08,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    g.add(floor);
    const table = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.6, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x6b5840, roughness: 0.55, emissive: 0x1a1408, emissiveIntensity: 0.25 }),
    );
    table.position.set(RUVIEW_ROUTER.x, 0.3, RUVIEW_ROUTER.z);
    table.castShadow = true;
    g.add(table);
    this.ruviewLayout = g;
    this.scene.add(g);
  }

  private buildRouter(): void {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.12, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x505060, roughness: 0.2, metalness: 0.7, emissive: 0x101018, emissiveIntensity: 0.2 }),
    ));
    for (let i = -1; i <= 1; i++) {
      const ant = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015, 0.015, 0.35),
        new THREE.MeshStandardMaterial({ color: 0x606068, roughness: 0.3, metalness: 0.6, emissive: 0x101018, emissiveIntensity: 0.15 }),
      );
      ant.position.set(i * 0.2, 0.24, 0);
      ant.rotation.z = i * 0.15;
      g.add(ant);
    }
    this.routerLed = new THREE.Mesh(new THREE.SphereGeometry(0.025), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true }));
    this.routerLed.position.set(0.22, 0.07, 0.18);
    g.add(this.routerLed);
    this.routerLight = new THREE.PointLight(C.blueSignal, 1.2, 8);
    this.routerLight.position.set(0, 0.3, 0);
    g.add(this.routerLight);
    this.routerGroup = g;
    this.scene.add(g);
  }

  private buildWaves(): void {
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: C.blueSignal, transparent: true, opacity: 0, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false, wireframe: true,
      });
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.8 + i, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.6), mat);
      this.scene.add(shell);
      this.waves.push({ mesh: shell, mat, phase: i * 0.7 });
    }
  }

  /** Show one room, move the router (and its waves) into it. */
  private applyLayout(): void {
    const home = this.layout === 'home';
    this.ruviewLayout.visible = !home;
    this.home.group.visible = home;
    this.home.frustum.visible = home && this.cameraOn;
    this.home.webcamLedMat.color.setHex(this.cameraOn ? C.green : 0x1a3a1a);
    this.routerGroup.position.copy(home ? this.home.routerPos : RUVIEW_ROUTER);
    for (const w of this.waves) {
      w.mesh.position.copy(this.routerGroup.position);
      w.mesh.position.y += 0.5;
    }
    this.hostLink.visible = home && this.mode === 'host';
  }

  private buildMist(): void {
    const positions = new Float32Array(this.mistCount * 3);
    const alphas = new Float32Array(this.mistCount);
    for (let i = 0; i < this.mistCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.5;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = Math.random() * 1.8;
      positions[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = 3.0 * (200.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(uColor, smoothstep(0.5, 0.2, d) * vAlpha);
        }`,
      uniforms: { uColor: { value: new THREE.Color(this.settings.wireColor) } },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.mist = new THREE.Points(geo, mat);
    this.scene.add(this.mist);
  }

  private buildTrail(): void {
    const positions = new Float32Array(this.trailCount * 3);
    const ages = new Float32Array(this.trailCount).fill(1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('age', new THREE.BufferAttribute(ages, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float age;
        varying float vAge;
        void main() {
          vAge = age;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, (1.0 - age) * 5.0 * (150.0 / -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAge;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(uColor, (1.0 - vAge) * 0.6 * smoothstep(0.5, 0.1, d));
        }`,
      uniforms: { uColor: { value: new THREE.Color(C.cyan) } },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.trail = new THREE.Points(geo, mat);
    this.scene.add(this.trail);
  }

  private buildField(): void {
    const n = 20;
    const positions = new Float32Array(n * n * 3);
    this.fieldColors = new Float32Array(n * n * 3);
    this.fieldSizes = new Float32Array(n * n).fill(8);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        positions[i * 3] = (ix - n / 2) * 0.6;
        positions[i * 3 + 1] = 0.02;
        positions[i * 3 + 2] = (iz - n / 2) * 0.5;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.fieldColors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.fieldSizes, 1));
    this.fieldPoints = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.35, vertexColors: true, transparent: true, opacity: this.settings.field,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    this.scene.add(this.fieldPoints);
  }

  /** The WiFi link from the router to this computer, for THIS COMPUTER mode. */
  private buildHostLink(): void {
    if (this.hostLink) {
      this.hostLink.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose?.();
        (mesh.material as THREE.Material | undefined)?.dispose?.();
      });
      this.hostLink.removeFromParent();
    }
    const g = new THREE.Group();
    const from = this.home.routerPos.clone().add(new THREE.Vector3(0, 0.4, 0));
    const to = this.home.computerPoint.clone();
    const len = from.distanceTo(to);
    const mid = from.clone().lerp(to, 0.5);
    const orient = (m: THREE.Mesh) => {
      m.position.copy(mid);
      m.lookAt(to);
      m.rotateX(Math.PI / 2);
    };
    this.beamMat = new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 8, 1, true), this.beamMat);
    orient(beam);
    g.add(beam);
    this.beamGlowMat = new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.beamGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, len, 12, 1, true), this.beamGlowMat);
    orient(this.beamGlow);
    g.add(this.beamGlow);
    this.pulseMat = new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    this.pulseRing = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.4, 48), this.pulseMat);
    this.pulseRing.rotation.x = -Math.PI / 2;
    this.pulseRing.position.copy(this.home.deskFloor);
    g.add(this.pulseRing);
    this.hostLink = g;
    this.scene.add(g);
    this.hostLink.visible = this.layout === 'home' && this.mode === 'host';
  }

  // ---- Frame loop --------------------------------------------------------

  private animate(): void {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const elapsed = this.clock.getElapsedTime();

    let data: AnyFrame;
    if (this.mode === 'sim') data = this.demo.update(dt);
    else data = this.drawable;

    // A webcam body, if one is fresh, is the figure in THIS COMPUTER mode.
    const body = this.mode === 'host' && this.cameraOn && this.body && performance.now() - this.bodyAt < BODY_HOLD_MS ? this.body : null;
    if (body) {
      this.drawBody(body, elapsed);
      // No mist or trail around a tracked body: RuView's particle "body mass"
      // is a stand-in for a pose it does not have, and here it buried the real
      // arms and legs under a glowing capsule.
      data = null;
    } else {
      if (this.bodyShown) this.hideBody();
      this.figures.update(data, elapsed);
    }

    this.nebula.update(dt, elapsed);
    this.props.update(data, this.mode === 'sim' ? this.demo.currentScenario : null);
    this.updateMist(data, elapsed);
    this.updateTrail(data, dt);
    this.updateWaves(elapsed);
    this.updateField(this.mode === 'host' ? null : data);
    this.updateHostLink(elapsed);
    if (this.layout === 'home') applyCutaway(this.home, this.camera.position);

    (this.routerLed.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.5 * Math.sin(elapsed * 8);
    this.routerLight.intensity = 0.3 + 0.2 * Math.sin(elapsed * 3);

    if (this.autopilot) {
      this.autoAngle += dt * this.settings.orbitSpeed;
      const r = this.layout === 'home' ? Math.max(this.homeRoom.width, this.homeRoom.depth) * 1.3 : 10;
      this.camera.position.set(Math.sin(this.autoAngle) * r, (this.layout === 'home' ? 3.2 : 4.5) + Math.sin(this.autoAngle * 0.5), Math.cos(this.autoAngle) * r);
      this.controls.target.set(0, 1.0, 0);
    }
    this.controls.update();
    this.post.update(elapsed);
    this.post.render();
    this.updateFps(dt);

    if (elapsed - this.lastTick >= 0.1) {
      this.lastTick = elapsed;
      this.onTick({
        frame: this.mode === 'sim' ? simFrame(data) : this.external,
        scenario: this.mode === 'sim' ? this.demo.currentScenario : null,
        autoCycle: !!this.demo._autoMode,
        paused: !!this.demo.paused,
        fps: this.fps,
        body: body ? this.placement : null,
        bodyIssue: body ? null : this.bodyIssue,
      });
    }
  }

  /** The tracked body drives figure 0 directly — its joints, not a procedural pose. */
  private drawBody(body: RoomBody, elapsed: number): void {
    const figs = this.figures.figures;
    const fig = figs[0];
    this.figures.applyKeypoints(fig, body.keypoints, 0, body.anchor, elapsed, 'standing');
    // A measured body gets a solid translucent volume, so the limbs read; the
    // engine's defaults are tuned for faint procedural avatars.
    for (const seg of fig.bodySegments) {
      seg.mat.opacity = seg.isHead ? 0.45 : 0.32;
      seg.mat.emissiveIntensity = 0.25;
    }
    for (const b of fig.bones) b.mesh.material.opacity = 0.95;
    fig.auraMat.opacity = 0.015;
    fig.visible = true;
    for (let i = 1; i < figs.length; i++) {
      if (figs[i].visible) {
        this.figures.hide(figs[i]);
        figs[i].visible = false;
      }
    }
    this.bodyShown = true;
  }

  private hideBody(): void {
    const fig = this.figures.figures[0];
    this.figures.hide(fig);
    fig.visible = false;
    this.bodyShown = false;
  }

  private updateMist(data: AnyFrame, elapsed: number): void {
    const persons = data?.persons || [];
    const present = data?.classification?.presence || false;
    const pos = this.mist.geometry.attributes.position as THREE.BufferAttribute;
    const alpha = this.mist.geometry.attributes.alpha as THREE.BufferAttribute;
    const pa = pos.array as Float32Array;
    const aa = alpha.array as Float32Array;

    if (!present || persons.length === 0) {
      for (let i = 0; i < this.mistCount; i++) aa[i] = Math.max(0, aa[i] - 0.02);
      alpha.needsUpdate = true;
      return;
    }
    const pp = persons[0].position || [0, 0, 0];
    const px = pp[0] || 0, pz = pp[2] || 0;
    const ms = persons[0].motion_score || 0;
    const pose = persons[0].pose || 'standing';
    const lying = pose === 'lying' || pose === 'fallen';
    const bodyH = lying ? 0.4 : 1.7;
    const baseY = lying ? (pp[1] || 0) + 0.05 : 0.05;
    const spread = ms > 50 ? 0.6 : 0.4;
    for (let i = 0; i < this.mistCount; i++) {
      const drift = Math.sin(elapsed * 0.5 + i * 0.1) * 0.003;
      const angle = (i / this.mistCount) * Math.PI * 2 + elapsed * 0.1;
      const layerT = (i % 20) / 20;
      const width = lying ? 0.25 : layerT > 0.75 ? 0.15 : layerT > 0.45 ? 0.25 : 0.18;
      const r = width * (0.5 + 0.5 * Math.sin(i * 1.7 + elapsed * 0.3)) * spread;
      pa[i * 3] += (px + Math.cos(angle + i * 0.3) * r + drift - pa[i * 3]) * 0.05;
      pa[i * 3 + 1] += (baseY + layerT * bodyH - pa[i * 3 + 1]) * 0.05;
      pa[i * 3 + 2] += (pz + Math.sin(angle + i * 0.5) * r * 0.6 - pa[i * 3 + 2]) * 0.05;
      aa[i] += (0.15 + Math.sin(elapsed * 2 + i * 0.5) * 0.08 - aa[i]) * 0.08;
    }
    pos.needsUpdate = true;
    alpha.needsUpdate = true;
  }

  private updateTrail(data: AnyFrame, dt: number): void {
    const persons = data?.persons || [];
    const present = data?.classification?.presence || false;
    const pos = this.trail.geometry.attributes.position as THREE.BufferAttribute;
    const ages = this.trail.geometry.attributes.age as THREE.BufferAttribute;
    const pa = pos.array as Float32Array;
    const ga = ages.array as Float32Array;
    for (let i = 0; i < this.trailCount; i++) ga[i] = Math.min(1, ga[i] + dt * 0.8);
    if (present && persons.length > 0) {
      this.trailTimer += dt;
      const rate = (persons[0].motion_score || 0) > 50 ? 0.02 : 0.08;
      if (this.trailTimer >= rate) {
        this.trailTimer = 0;
        for (const p of persons) {
          const pp = p.position || [0, 0, 0];
          const i = this.trailHead;
          pa[i * 3] = (pp[0] || 0) + (Math.random() - 0.5) * 0.15;
          pa[i * 3 + 1] = Math.random() * 1.5 + 0.1;
          pa[i * 3 + 2] = (pp[2] || 0) + (Math.random() - 0.5) * 0.15;
          ga[i] = 0;
          this.trailHead = (this.trailHead + 1) % this.trailCount;
        }
      }
    }
    pos.needsUpdate = true;
    ages.needsUpdate = true;
  }

  private updateWaves(elapsed: number): void {
    // In the operator's room the rings stay inside it; in RuView's room they
    // keep RuView's reach. Either way they are decoration: "the router
    // transmits", not a measurement.
    const home = this.layout === 'home';
    const reach = home ? 0.42 : 1;
    const bright = home ? 0.5 : 1;
    for (const w of this.waves) {
      const life = ((elapsed * 0.8 + w.phase) % 4.5) / 4.5;
      w.mat.opacity = Math.max(0, this.settings.waves * 0.25 * bright * (1 - life));
      const s = (1 + life * 0.6) * reach;
      w.mesh.scale.set(s, s, s);
      w.mesh.rotation.y = elapsed * 0.05;
    }
  }

  private updateField(data: AnyFrame): void {
    const values: number[] | undefined = data?.signal_field?.values;
    const colors = this.fieldColors;
    if (!values) {
      // No field from this source: fade out rather than leave the last one lit.
      let any = false;
      for (let i = 0; i < colors.length; i++) {
        if (colors[i] > 0.001) {
          colors[i] *= 0.9;
          any = true;
        }
      }
      if (any) this.fieldPoints.geometry.attributes.color.needsUpdate = true;
      return;
    }
    const count = Math.min(values.length, 400);
    for (let i = 0; i < count; i++) {
      const v = values[i] || 0;
      let r, g, b;
      if (v < 0.3) { r = 0; g = v * 1.5; b = v * 0.3; }
      else if (v < 0.6) { const t = (v - 0.3) / 0.3; r = t * 0.3; g = 0.45 + t * 0.4; b = 0.09 - t * 0.05; }
      else { const t = (v - 0.6) / 0.4; r = 0.3 + t * 0.7; g = 0.85 - t * 0.2; b = 0.04; }
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
      this.fieldSizes[i] = 5 + v * 15;
    }
    this.fieldPoints.geometry.attributes.color.needsUpdate = true;
    this.fieldPoints.geometry.attributes.size.needsUpdate = true;
  }

  private updateHostLink(elapsed: number): void {
    const show = this.layout === 'home' && this.mode === 'host';
    this.hostLink.visible = show;
    if (!show) return;
    const m = this.external?.motion;
    const live = !!m && m.level !== 'calibrating';
    const idx = live ? m!.index : 0;
    const color = !live || m!.level === 'quiet' ? C.cyan : m!.level === 'motion' ? C.gold : C.amber;
    this.beamMat.color.setHex(color);
    this.beamGlowMat.color.setHex(color);
    this.pulseMat.color.setHex(color);
    // Brightness and flicker follow the measured disturbance; a dead link is dim.
    this.beamMat.opacity = this.external ? 0.3 + 0.55 * idx : 0.06;
    const flicker = 0.6 + 0.4 * Math.sin(elapsed * (6 + idx * 14));
    this.beamGlowMat.opacity = this.external ? (0.04 + 0.22 * idx) * flicker : 0;
    const swell = 1 + idx * 0.8 * (0.5 + 0.5 * Math.sin(elapsed * 9));
    this.beamGlow.scale.set(swell, 1, swell);
    const ringLife = (elapsed * (0.6 + idx * 1.6)) % 1;
    this.pulseRing.scale.setScalar(1 + ringLife * (1.5 + idx * 3));
    this.pulseMat.opacity = live && idx > 0.2 ? (1 - ringLife) * 0.5 * idx : 0;
    this.home.screenMat.emissiveIntensity = this.external ? 0.35 : 0.08;
  }

  private updateFps(dt: number): void {
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime < 1) return;
    this.fps = Math.round(this.fpsFrames / this.fpsTime);
    this.fpsFrames = 0;
    this.fpsTime = 0;
    let q = this.quality;
    if (this.fps < 25 && q > 0) q--;
    else if (this.fps > 55 && q < 2) q++;
    if (q !== this.quality) {
      this.quality = q;
      this.nebula.setQuality(q);
      this.post.setQuality(q);
    }
  }

  private onResize(): void {
    if (this.disposed) return;
    const { w, h } = this.size();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.post.resize(w, h);
  }
}

/** The demo generator's frame, restated as a SensingFrame the HUD can read. */
function simFrame(d: AnyFrame): SensingFrame | null {
  if (!d) return null;
  const vs = d.vital_signs || {};
  return {
    provenance: 'simulated',
    source: 'simulation',
    timestamp: d.timestamp,
    scenario: d.scenario,
    features: d.features,
    classification: d.classification,
    vital_signs: {
      breathing_rate_bpm: vs.breathing_rate_bpm > 0 ? vs.breathing_rate_bpm : null,
      heart_rate_bpm: vs.heart_rate_bpm > 0 ? vs.heart_rate_bpm : null,
      breathing_confidence: vs.breathing_confidence,
      // The demo generator spells it heart_rate_confidence; RuView's server, heartbeat_confidence.
      heartbeat_confidence: vs.heartbeat_confidence ?? vs.heart_rate_confidence,
    },
    persons: (d.persons || []).map((p: { id?: number; position?: [number, number, number]; pose?: string }, i: number) => ({
      id: p.id ?? i,
      position: p.position || [0, 0, 0],
      confidence: 1,
      pose: p.pose,
    })),
    estimated_persons: d.estimated_persons,
  };
}
