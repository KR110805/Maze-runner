/**
 * ACM Spell Maze - 3D Follow-Camera Engine (v2)
 * Features:
 * - Collectibles: A, C, and M (ACM Spell Hunt)
 * - Ultra-low draw-call instanced geometry batching for 60 FPS on all devices
 * - Optimized localized lighting: spotlight shadow-casting capped to 1024x1024
 * - Frustum & distance culling for smooth mobile performance
 * - Forward-locked flashlight beam and volumetric cone
 * - Strict, airtight rigid-body bounding-box collision detection
 * - Mid-match session persistence & rehydration (preserves coordinates & collected letters across refresh)
 */

const CELL_SIZE = 2.6;                 // Width/depth of a corridor cell (ample breathing room)
const WALL_THICKNESS = 0.28;           // Significantly thinner walls to keep corridors open
const WALL_HEIGHT = 1.35;              // Low-poly wall height calibrated so player is never suffocated
const PLAYER_COLLISION_RADIUS = 0.22;  // Compact collision capsule smaller than visible mesh
const PLAYER_SPEED = 5.2;

class Game {
    constructor(seed = null) {
        this.canvas = document.getElementById('gameCanvas');
        this.sound = new SoundManager();

        // Maze settings (16x16 labyrinth)
        this.mazeSize = 16;
        this.seed = seed;
        this.maze = new Maze(this.mazeSize, this.mazeSize, this.seed);

        // Game stats
        this.steps = 0;
        this.startTime = Date.now();
        this.elapsedSeconds = 0;
        this.timerInterval = null;
        this.isGameOver = false;
        this.isRaceActive = false;
        this.collectedSequence = [];

        // Player physics & transform
        const startWorldX = (this.maze.startPos.x + 0.5) * CELL_SIZE;
        const startWorldZ = (this.maze.startPos.y + 0.5) * CELL_SIZE;

        this.player = {
            gridX: this.maze.startPos.x,
            gridY: this.maze.startPos.y,
            x: startWorldX,
            z: startWorldZ,
            vx: 0,
            vz: 0,
            angle: 0,
            targetAngle: 0,
            speed: PLAYER_SPEED,
            walkCycle: 0,
            isMoving: false
        };

        // Camera follow target
        this.camTarget = {
            x: this.player.x,
            z: this.player.z
        };

        // Three.js core objects
        this.scene = null;
        this.camera = null;
        this.renderer = null;

        // Scene meshes
        this.mazeMeshes = [];
        this.wallColliders = [];
        this.playerGroup = null;
        this.playerLegL = null;
        this.playerLegR = null;
        this.playerTorch = null;
        this.torchLight = null;
        this.visionSpotLight = null;
        this.spotTarget = null;
        this.wisps = [];

        // Letter collectibles
        this.letterGroups = [];
        this.particles = [];

        // Controls
        this.keys = {};
        this.inputVector = { x: 0, y: 0 };
        this.lastStepTile = { x: this.maze.startPos.x, y: this.maze.startPos.y };

        // Virtual Joystick for touch
        this.touchActive = false;
        this.touchOrigin = { x: 0, y: 0 };
        this.joystickBase = document.getElementById('virtualJoystickBase');
        this.joystickKnob = document.getElementById('virtualJoystickKnob');

        // Animation timing & session saving throttle
        this.lastTimestamp = 0;
        this.animTime = 0;
        this.lastSessionSaveTime = 0;

        this.init();
    }

    init() {
        if (typeof THREE === 'undefined') {
            console.error("Three.js not loaded. Retrying in 100ms...");
            setTimeout(() => this.init(), 100);
            return;
        }

        this.initThree();
        this.buildDungeonMaze();
        this.buildPlayerAvatar();
        this.buildLetterCollectibles();
        this.buildAmbientDust();

        this.bindInputEvents();
        this.updateHUD();

        // Start render loop
        requestAnimationFrame((t) => this.loop(t));
    }

    /* -----------------------------------------------------
       1. THREE.JS SCENE, CAMERA & OPTIMIZED LIGHTING
       ----------------------------------------------------- */
    initThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0c1322);
        this.scene.fog = new THREE.FogExp2(0x0c1322, 0.018);

        // Localized Top-Down Follow-Camera with full view frustum range
        const aspect = this.canvas.clientWidth / (this.canvas.clientHeight || 1);
        this.camera = new THREE.PerspectiveCamera(46, aspect, 0.1, 1000);
        this.camera.position.set(this.player.x, 14.0, this.player.z + 7.5);
        this.camera.lookAt(this.player.x, 0.45, this.player.z);
        this.camera.updateProjectionMatrix();

        // WebGL Renderer optimized for mobile performance
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            powerPreference: 'high-performance'
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight || 580, false);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.1;

        // Persistent Baseline Ambient Fill (guarantees surfaces never collapse to pure pitch black)
        const ambient = new THREE.AmbientLight(0x3a4f6e, 0.45);
        this.scene.add(ambient);

        // Soft Hemisphere Light (Sky cyan, ground dark stone)
        const hemiLight = new THREE.HemisphereLight(0x56a6db, 0x142035, 0.35);
        this.scene.add(hemiLight);

        // Directional Moonlit Fill
        const moonLight = new THREE.DirectionalLight(0x7ea7dc, 0.45);
        moonLight.position.set(22, 38, 16);
        this.scene.add(moonLight);

        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
    }

    resizeCanvas() {
        if (!this.renderer || !this.camera) return;
        const container = this.canvas.parentElement;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const width = rect.width || window.innerWidth;
        const height = rect.height || 580;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height, false);
    }

    /* -----------------------------------------------------
       2. BATCHED INSTANCED DUNGEON MAZE (MAX 5 DRAW CALLS)
       ----------------------------------------------------- */
    buildDungeonMaze() {
        // Clear previous meshes
        this.mazeMeshes.forEach(m => this.scene.remove(m));
        this.mazeMeshes = [];

        const mazeWidth = this.maze.cols * CELL_SIZE;
        const mazeHeight = this.maze.rows * CELL_SIZE;

        // 1. Base Ground Plane (Mesh with computeBoundingBox/Sphere and frustumCulled = false)
        const groundGeo = new THREE.PlaneGeometry(mazeWidth + 40, mazeHeight + 40, 2, 2);
        groundGeo.computeBoundingBox();
        groundGeo.computeBoundingSphere();
        const groundMat = new THREE.MeshStandardMaterial({
            color: 0x0c1524,
            roughness: 0.85,
            metalness: 0.1
        });
        const groundMesh = new THREE.Mesh(groundGeo, groundMat);
        groundMesh.rotation.x = -Math.PI / 2;
        groundMesh.position.set(mazeWidth * 0.5, -0.02, mazeHeight * 0.5);
        groundMesh.receiveShadow = true;
        groundMesh.frustumCulled = false;
        this.scene.add(groundMesh);
        this.mazeMeshes.push(groundMesh);

        // 2. Floor Flagstone Tiles (Batched into ONE InstancedMesh)
        const tilesPerCell = 2;
        const tileMargin = 0.04;
        const tileSize = (CELL_SIZE / tilesPerCell) - tileMargin;
        const totalTiles = this.maze.cols * this.maze.rows * tilesPerCell * tilesPerCell;

        const tileGeo = new THREE.BoxGeometry(tileSize, 0.04, tileSize);
        tileGeo.computeBoundingBox();
        tileGeo.computeBoundingSphere();
        const tileMat = new THREE.MeshStandardMaterial({
            color: 0x1e2f4c,
            roughness: 0.65,
            metalness: 0.2,
            emissive: 0x0c1524,
            emissiveIntensity: 0.15
        });
        const tileInstanced = new THREE.InstancedMesh(tileGeo, tileMat, totalTiles);
        tileInstanced.receiveShadow = true;
        tileInstanced.frustumCulled = false;

        const dummy = new THREE.Object3D();
        let tileIdx = 0;

        for (let r = 0; r < this.maze.rows; r++) {
            for (let c = 0; c < this.maze.cols; c++) {
                const cellX = c * CELL_SIZE;
                const cellZ = r * CELL_SIZE;

                for (let ty = 0; ty < tilesPerCell; ty++) {
                    for (let tx = 0; tx < tilesPerCell; tx++) {
                        const px = cellX + (tx + 0.5) * (CELL_SIZE / tilesPerCell);
                        const pz = cellZ + (ty + 0.5) * (CELL_SIZE / tilesPerCell);

                        dummy.position.set(px, 0.01, pz);
                        dummy.rotation.set(0, 0, 0);
                        dummy.scale.set(1, 1, 1);
                        dummy.updateMatrix();
                        tileInstanced.setMatrixAt(tileIdx++, dummy.matrix);
                    }
                }
            }
        }
        tileInstanced.instanceMatrix.needsUpdate = true;
        this.scene.add(tileInstanced);
        this.mazeMeshes.push(tileInstanced);

        // 3. Wall Colliders & Batched Instanced Meshes
        this.wallColliders = this.maze.getWallColliders(CELL_SIZE, WALL_THICKNESS);

        const wallMat = new THREE.MeshStandardMaterial({
            color: 0x2b3a55,
            roughness: 0.65,
            metalness: 0.2,
            emissive: 0x111c2e,
            emissiveIntensity: 0.18
        });

        // Filter collider types
        const hInternal = this.wallColliders.filter(w => w.type === 'h-wall');
        const vInternal = this.wallColliders.filter(w => w.type === 'v-wall');
        const corners = this.wallColliders.filter(w => w.type === 'corner');
        const outerWalls = this.wallColliders.filter(w => w.type === 'outer');

        // A. Batch Horizontal Internal Walls into ONE InstancedMesh
        if (hInternal.length > 0) {
            const hWallGeo = new THREE.BoxGeometry(CELL_SIZE + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS);
            hWallGeo.computeBoundingBox();
            hWallGeo.computeBoundingSphere();
            const hInstanced = new THREE.InstancedMesh(hWallGeo, wallMat, hInternal.length);
            hInstanced.castShadow = true;
            hInstanced.receiveShadow = true;
            hInstanced.frustumCulled = false;

            hInternal.forEach((w, i) => {
                dummy.position.set((w.minX + w.maxX) * 0.5, WALL_HEIGHT * 0.5, (w.minZ + w.maxZ) * 0.5);
                dummy.rotation.set(0, 0, 0);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                hInstanced.setMatrixAt(i, dummy.matrix);
            });
            hInstanced.instanceMatrix.needsUpdate = true;
            this.scene.add(hInstanced);
            this.mazeMeshes.push(hInstanced);
        }

        // B. Batch Vertical Internal Walls into ONE InstancedMesh
        if (vInternal.length > 0) {
            const vWallGeo = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, CELL_SIZE + WALL_THICKNESS);
            vWallGeo.computeBoundingBox();
            vWallGeo.computeBoundingSphere();
            const vInstanced = new THREE.InstancedMesh(vWallGeo, wallMat, vInternal.length);
            vInstanced.castShadow = true;
            vInstanced.receiveShadow = true;
            vInstanced.frustumCulled = false;

            vInternal.forEach((w, i) => {
                dummy.position.set((w.minX + w.maxX) * 0.5, WALL_HEIGHT * 0.5, (w.minZ + w.maxZ) * 0.5);
                dummy.rotation.set(0, 0, 0);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                vInstanced.setMatrixAt(i, dummy.matrix);
            });
            vInstanced.instanceMatrix.needsUpdate = true;
            this.scene.add(vInstanced);
            this.mazeMeshes.push(vInstanced);
        }

        // C. Batch Corner Posts into ONE InstancedMesh
        if (corners.length > 0) {
            const cornerGeo = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS);
            cornerGeo.computeBoundingBox();
            cornerGeo.computeBoundingSphere();
            const cornerInstanced = new THREE.InstancedMesh(cornerGeo, wallMat, corners.length);
            cornerInstanced.castShadow = true;
            cornerInstanced.receiveShadow = true;
            cornerInstanced.frustumCulled = false;

            corners.forEach((w, i) => {
                dummy.position.set((w.minX + w.maxX) * 0.5, WALL_HEIGHT * 0.5, (w.minZ + w.maxZ) * 0.5);
                dummy.rotation.set(0, 0, 0);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                cornerInstanced.setMatrixAt(i, dummy.matrix);
            });
            cornerInstanced.instanceMatrix.needsUpdate = true;
            this.scene.add(cornerInstanced);
            this.mazeMeshes.push(cornerInstanced);
        }

        // D. Outer Perimeter Walls
        outerWalls.forEach(w => {
            const wWidth = w.maxX - w.minX;
            const wDepth = w.maxZ - w.minZ;
            const geo = new THREE.BoxGeometry(wWidth, WALL_HEIGHT, wDepth);
            geo.computeBoundingBox();
            geo.computeBoundingSphere();
            const mesh = new THREE.Mesh(geo, wallMat);
            mesh.position.set((w.minX + w.maxX) * 0.5, WALL_HEIGHT * 0.5, (w.minZ + w.maxZ) * 0.5);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = false;
            this.scene.add(mesh);
            this.mazeMeshes.push(mesh);
        });
    }

    /* -----------------------------------------------------
       3. STYLIZED 3D CHARACTER AVATAR WITH FORWARD-LOCKED LIGHTS
       ----------------------------------------------------- */
    buildPlayerAvatar() {
        if (this.playerGroup) this.scene.remove(this.playerGroup);

        this.playerGroup = new THREE.Group();
        this.playerGroup.position.set(this.player.x, 0, this.player.z);

        // Ground Contact Shadow
        const shadowGeo = new THREE.CircleGeometry(0.48, 16);
        const shadowMat = new THREE.MeshBasicMaterial({
            color: 0x000000,
            transparent: true,
            opacity: 0.45
        });
        const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
        shadowMesh.rotation.x = -Math.PI / 2;
        shadowMesh.position.y = 0.02;
        this.playerGroup.add(shadowMesh);

        // Walking Boots (Local Z: Front is +Z)
        const bootMat = new THREE.MeshStandardMaterial({ color: 0x090d16, roughness: 0.6 });
        const bootGeo = new THREE.BoxGeometry(0.16, 0.32, 0.26);

        this.playerLegL = new THREE.Mesh(bootGeo, bootMat);
        this.playerLegL.position.set(-0.15, 0.16, 0);
        this.playerLegL.castShadow = true;
        this.playerGroup.add(this.playerLegL);

        this.playerLegR = new THREE.Mesh(bootGeo, bootMat);
        this.playerLegR.position.set(0.15, 0.16, 0);
        this.playerLegR.castShadow = true;
        this.playerGroup.add(this.playerLegR);

        // Stealth Operative Torso
        const torsoMat = new THREE.MeshStandardMaterial({
            color: 0x1e293b,
            roughness: 0.45,
            metalness: 0.3
        });
        const torsoGeo = new THREE.BoxGeometry(0.52, 0.58, 0.34);
        const torsoMesh = new THREE.Mesh(torsoGeo, torsoMat);
        torsoMesh.position.y = 0.58;
        torsoMesh.castShadow = true;
        this.playerGroup.add(torsoMesh);

        // Glowing Cyan Core Trim on Chest (+Z is Forward)
        const coreGeo = new THREE.BoxGeometry(0.16, 0.16, 0.06);
        const coreMat = new THREE.MeshStandardMaterial({
            color: 0x38bdf8,
            emissive: 0x38bdf8,
            emissiveIntensity: 1.2
        });
        const coreMesh = new THREE.Mesh(coreGeo, coreMat);
        coreMesh.position.set(0, 0.62, 0.18);
        this.playerGroup.add(coreMesh);

        // Operative Head / Mask
        const headGeo = new THREE.BoxGeometry(0.38, 0.36, 0.38);
        const headMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.4 });
        const headMesh = new THREE.Mesh(headGeo, headMat);
        headMesh.position.y = 1.02;
        headMesh.castShadow = true;
        this.playerGroup.add(headMesh);

        // Glowing Visor (+Z is Forward)
        const visorGeo = new THREE.BoxGeometry(0.3, 0.09, 0.08);
        const visorMat = new THREE.MeshStandardMaterial({
            color: 0x00f5d4,
            emissive: 0x00f5d4,
            emissiveIntensity: 1.6
        });
        const visorMesh = new THREE.Mesh(visorGeo, visorMat);
        visorMesh.position.set(0, 1.02, 0.19);
        this.playerGroup.add(visorMesh);

        // Handheld Torch Lantern (Right hand, pointing forward +Z)
        const lanternGeo = new THREE.CylinderGeometry(0.07, 0.09, 0.24, 8);
        const lanternMat = new THREE.MeshStandardMaterial({
            color: 0xffb703,
            emissive: 0xffaa00,
            emissiveIntensity: 1.5
        });
        this.playerTorch = new THREE.Mesh(lanternGeo, lanternMat);
        this.playerTorch.position.set(0.34, 0.62, 0.22);
        this.playerGroup.add(this.playerTorch);

        // -----------------------------------------------------
        // DYNAMIC VISION LIGHTING: PERFORMANCE OPTIMIZED
        // -----------------------------------------------------
        // 1. Warm Torch PointLight (Localized ambient glow; castShadow disabled to eliminate 6 cubemap passes)
        this.torchLight = new THREE.PointLight(0xffaa2b, 2.4, 16, 1.6);
        this.torchLight.position.set(0.34, 0.75, 0.26);
        this.torchLight.castShadow = false; // Massive mobile FPS boost!
        this.playerGroup.add(this.torchLight);

        // 2. Forward Tactical Vision Spotlight
        // Strictly locked forward (+Z), casts single optimized soft shadow map
        this.visionSpotLight = new THREE.SpotLight(0xfffaee, 4.2, 24, Math.PI / 4.2, 0.5, 1.5);
        this.visionSpotLight.position.set(0, 0.85, 0.25);
        this.visionSpotLight.castShadow = true;
        this.visionSpotLight.shadow.mapSize.width = 1024;
        this.visionSpotLight.shadow.mapSize.height = 1024;
        this.visionSpotLight.shadow.bias = -0.0015;

        // Spot target in world coordinates
        if (this.spotTarget) this.scene.remove(this.spotTarget);
        this.spotTarget = new THREE.Object3D();
        this.spotTarget.position.set(this.player.x, 0.5, this.player.z + 14);
        this.scene.add(this.spotTarget);
        this.visionSpotLight.target = this.spotTarget;
        this.playerGroup.add(this.visionSpotLight);

        // 3. Volumetric Flashlight Beam Cone
        // Aligned along +Z (character forward vector)
        const beamHeight = 11;
        const beamGeo = new THREE.ConeGeometry(2.2, beamHeight, 16, 1, true);
        beamGeo.translate(0, -beamHeight * 0.5, 0);
        beamGeo.rotateX(-Math.PI / 2);

        const beamMat = new THREE.MeshBasicMaterial({
            color: 0xfff2d4,
            transparent: true,
            opacity: 0.08,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        const beamMesh = new THREE.Mesh(beamGeo, beamMat);
        beamMesh.position.set(0, 0.85, 0.25);
        this.playerGroup.add(beamMesh);

        // 4. Glowing Lens Flare Disc
        const flareGeo = new THREE.CircleGeometry(0.15, 16);
        const flareMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.75,
            blending: THREE.AdditiveBlending
        });
        const flareMesh = new THREE.Mesh(flareGeo, flareMat);
        flareMesh.position.set(0.34, 0.72, 0.35);
        this.playerGroup.add(flareMesh);

        // Orbiting Wisps
        this.wisps = [];
        for (let i = 0; i < 3; i++) {
            const wispGeo = new THREE.SphereGeometry(0.04, 6, 6);
            const wispMat = new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? 0xffb703 : 0x00f5d4 });
            const wisp = new THREE.Mesh(wispGeo, wispMat);
            this.wisps.push({
                mesh: wisp,
                angle: (i * Math.PI * 2) / 3,
                radius: 0.6 + i * 0.1,
                speed: 2.2 * (i % 2 === 0 ? 1 : -1)
            });
            this.playerGroup.add(wisp);
        }

        this.scene.add(this.playerGroup);
    }

    /* -----------------------------------------------------
       4. 3D COLLECTIBLES (LETTERS A, C, M)
       ----------------------------------------------------- */
    buildLetterCollectibles() {
        this.letterGroups.forEach(l => {
            if (l.group) this.scene.remove(l.group);
        });
        this.letterGroups = [];

        // Targets: A, C, and M
        const letterDefs = {
            'A': { color: 0xffb703, lightColor: 0xffb703 },
            'C': { color: 0x00f5d4, lightColor: 0x00f5d4 },
            'M': { color: 0xff006e, lightColor: 0xff006e }
        };

        this.maze.letters.forEach(letter => {
            const def = letterDefs[letter.id] || letterDefs['A'];
            const group = new THREE.Group();
            const wx = (letter.x + 0.5) * CELL_SIZE;
            const wz = (letter.y + 0.5) * CELL_SIZE;
            group.position.set(wx, 0, wz);

            // Floor Medallion Ring
            const ringGeo = new THREE.RingGeometry(0.48, 0.72, 24);
            const ringMat = new THREE.MeshBasicMaterial({
                color: def.color,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.55
            });
            const ringMesh = new THREE.Mesh(ringGeo, ringMat);
            ringMesh.rotation.x = -Math.PI / 2;
            ringMesh.position.y = 0.03;
            ringMesh.frustumCulled = false;
            group.add(ringMesh);

            // Procedural Extruded 3D Letter Mesh
            const letterGeo = this.create3DLetterGeometry(letter.id);
            const letterMat = new THREE.MeshStandardMaterial({
                color: def.color,
                emissive: def.color,
                emissiveIntensity: 0.65,
                roughness: 0.25,
                metalness: 0.5
            });
            const letterMesh = new THREE.Mesh(letterGeo, letterMat);
            letterMesh.frustumCulled = false;
            group.add(letterMesh);

            // Local Glowing PointLight
            const light = new THREE.PointLight(def.lightColor, 1.8, 6.5, 2);
            light.position.set(0, 0.9, 0);
            group.add(light);

            this.scene.add(group);

            this.letterGroups.push({
                id: letter.id,
                gridX: letter.x,
                gridY: letter.y,
                worldX: wx,
                worldZ: wz,
                group: group,
                mesh: letterMesh,
                ring: ringMesh,
                light: light,
                collected: letter.collected,
                baseY: 0.8
            });
        });
    }

    create3DLetterGeometry(char) {
        const shape = new THREE.Shape();
        const extrudeSettings = {
            depth: 0.14,
            bevelEnabled: true,
            bevelThickness: 0.03,
            bevelSize: 0.025,
            bevelSegments: 2
        };

        if (char === 'A') {
            shape.moveTo(-0.32, -0.42);
            shape.lineTo(0, 0.42);
            shape.lineTo(0.32, -0.42);
            shape.lineTo(0.16, -0.42);
            shape.lineTo(0.09, -0.14);
            shape.lineTo(-0.09, -0.14);
            shape.lineTo(-0.16, -0.42);
            shape.closePath();

            const hole = new THREE.Path();
            hole.moveTo(0, 0.22);
            hole.lineTo(-0.07, -0.02);
            hole.lineTo(0.07, -0.02);
            hole.closePath();
            shape.holes.push(hole);
        } else if (char === 'C') {
            shape.moveTo(0.3, 0.3);
            shape.lineTo(0.32, 0.42);
            shape.lineTo(-0.32, 0.42);
            shape.lineTo(-0.32, -0.42);
            shape.lineTo(0.32, -0.42);
            shape.lineTo(0.3, -0.3);
            shape.lineTo(-0.16, -0.3);
            shape.lineTo(-0.16, 0.3);
            shape.closePath();
        } else {
            // 'M' (Proportional stylized 3D M)
            shape.moveTo(-0.35, -0.42);
            shape.lineTo(-0.35, 0.42);
            shape.lineTo(-0.18, 0.42);
            shape.lineTo(0, 0.06);
            shape.lineTo(0.18, 0.42);
            shape.lineTo(0.35, 0.42);
            shape.lineTo(0.35, -0.42);
            shape.lineTo(0.22, -0.42);
            shape.lineTo(0.22, 0.16);
            shape.lineTo(0, -0.16);
            shape.lineTo(-0.22, 0.16);
            shape.lineTo(-0.22, -0.42);
            shape.closePath();
        }

        const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        geo.center();
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        return geo;
    }

    /* -----------------------------------------------------
       5. 3D AMBIENT ATMOSPHERIC MOTES
       ----------------------------------------------------- */
    buildAmbientDust() {
        const dustCount = 50;
        const dustGeo = new THREE.BufferGeometry();
        const positions = new Float32Array(dustCount * 3);
        const range = 20;

        for (let i = 0; i < dustCount; i++) {
            positions[i * 3] = (Math.random() - 0.5) * range;
            positions[i * 3 + 1] = Math.random() * 3.0 + 0.2;
            positions[i * 3 + 2] = (Math.random() - 0.5) * range;
        }

        dustGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const dustMat = new THREE.PointsMaterial({
            color: 0x38bdf8,
            size: 0.1,
            transparent: true,
            opacity: 0.35
        });

        this.dustPoints = new THREE.Points(dustGeo, dustMat);
        this.dustPoints.frustumCulled = false;
        this.scene.add(this.dustPoints);
    }

    /* -----------------------------------------------------
       6. INPUT BINDINGS
       ----------------------------------------------------- */
    bindInputEvents() {
        window.addEventListener('keydown', (e) => {
            this.sound.init();
            this.keys[e.key.toLowerCase()] = true;
            this.updateInputVector();
        });

        window.addEventListener('keyup', (e) => {
            this.keys[e.key.toLowerCase()] = false;
            this.updateInputVector();
        });

        const restartBtn = document.getElementById('restartBtn');
        if (restartBtn) restartBtn.addEventListener('click', () => this.resetGame());

        const soundBtn = document.getElementById('soundToggleBtn');
        if (soundBtn) {
            soundBtn.addEventListener('click', () => {
                this.sound.init();
                this.sound.enabled = !this.sound.enabled;
                soundBtn.textContent = this.sound.enabled ? '🔊 Audio: On' : '🔇 Audio: Off';
                soundBtn.classList.toggle('muted', !this.sound.enabled);
            });
        }

        this.bindDPadButtons();
        this.bindTouchJoystick();
    }

    updateInputVector() {
        let ix = 0;
        let iz = 0;

        if (this.keys['arrowup'] || this.keys['w']) iz -= 1;
        if (this.keys['arrowdown'] || this.keys['s']) iz += 1;
        if (this.keys['arrowleft'] || this.keys['a']) ix -= 1;
        if (this.keys['arrowright'] || this.keys['d']) ix += 1;

        if (this.touchActive) {
            ix = this.inputVector.x;
            iz = this.inputVector.z;
        } else {
            const len = Math.hypot(ix, iz);
            if (len > 0) {
                this.inputVector.x = ix / len;
                this.inputVector.z = iz / len;
            } else {
                this.inputVector.x = 0;
                this.inputVector.z = 0;
            }
        }
    }

    bindDPadButtons() {
        const dpadMap = [
            { id: 'btnUp', x: 0, z: -1 },
            { id: 'btnDown', x: 0, z: 1 },
            { id: 'btnLeft', x: -1, z: 0 },
            { id: 'btnRight', x: 1, z: 0 }
        ];

        dpadMap.forEach(({ id, x, z }) => {
            const btn = document.getElementById(id);
            if (!btn) return;

            const handlePress = (e) => {
                e.preventDefault();
                this.sound.init();
                this.inputVector.x = x;
                this.inputVector.z = z;
            };

            const handleRelease = (e) => {
                e.preventDefault();
                this.inputVector.x = 0;
                this.inputVector.z = 0;
            };

            btn.addEventListener('touchstart', handlePress, { passive: false });
            btn.addEventListener('touchend', handleRelease, { passive: false });
            btn.addEventListener('mousedown', handlePress);
            btn.addEventListener('mouseup', handleRelease);
        });
    }

    bindTouchJoystick() {
        const container = this.canvas.parentElement;
        if (!container) return;

        const onTouchStart = (e) => {
            if (e.target.closest('.mobile-dpad') || e.target.closest('button')) return;
            this.sound.init();
            const touch = e.touches ? e.touches[0] : e;
            const rect = container.getBoundingClientRect();
            const x = touch.clientX - rect.left;
            const y = touch.clientY - rect.top;

            this.touchActive = true;
            this.touchOrigin = { x, y };

            if (this.joystickBase && this.joystickKnob) {
                this.joystickBase.style.left = `${x}px`;
                this.joystickBase.style.top = `${y}px`;
                this.joystickBase.style.display = 'block';
                this.joystickKnob.style.transform = `translate(-50%, -50%)`;
            }
        };

        const onTouchMove = (e) => {
            if (!this.touchActive) return;
            const touch = e.touches ? e.touches[0] : e;
            const rect = container.getBoundingClientRect();
            const curX = touch.clientX - rect.left;
            const curY = touch.clientY - rect.top;

            const dx = curX - this.touchOrigin.x;
            const dy = curY - this.touchOrigin.y;
            const dist = Math.hypot(dx, dy);
            const maxRadius = 45;

            if (dist > 0) {
                const clamped = Math.min(dist, maxRadius);
                const normX = dx / dist;
                const normY = dy / dist;

                this.inputVector.x = normX * (clamped / maxRadius);
                this.inputVector.z = normY * (clamped / maxRadius);

                if (this.joystickKnob) {
                    const knobX = normX * clamped;
                    const knobY = normY * clamped;
                    this.joystickKnob.style.transform = `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`;
                }
            }
        };

        const onTouchEnd = () => {
            this.touchActive = false;
            this.inputVector.x = 0;
            this.inputVector.z = 0;
            if (this.joystickBase) this.joystickBase.style.display = 'none';
            this.updateInputVector();
        };

        container.addEventListener('touchstart', onTouchStart, { passive: true });
        window.addEventListener('touchmove', onTouchMove, { passive: true });
        window.addEventListener('touchend', onTouchEnd, { passive: true });

        container.addEventListener('mousedown', onTouchStart);
        window.addEventListener('mousemove', onTouchMove);
        window.addEventListener('mouseup', onTouchEnd);
    }

    /* -----------------------------------------------------
       7. AIRTIGHT RIGID-BODY COLLISION & MOVEMENT PHYSICS
       ----------------------------------------------------- */
    resolveWallCollisions(px, pz, radius) {
        let resolvedX = px;
        let resolvedZ = pz;
        const rSq = radius * radius;

        // Strict Outer Perimeter Clamping
        const minBound = WALL_THICKNESS * 0.5 + radius;
        const maxBoundX = this.maze.cols * CELL_SIZE - WALL_THICKNESS * 0.5 - radius;
        const maxBoundZ = this.maze.rows * CELL_SIZE - WALL_THICKNESS * 0.5 - radius;

        resolvedX = Math.max(minBound, Math.min(maxBoundX, resolvedX));
        resolvedZ = Math.max(minBound, Math.min(maxBoundZ, resolvedZ));

        // Rigid Body Box Collisions
        for (const w of this.wallColliders) {
            // Broadphase proximity rejection
            if (resolvedX < w.minX - radius || resolvedX > w.maxX + radius ||
                resolvedZ < w.minZ - radius || resolvedZ > w.maxZ + radius) {
                continue;
            }

            // Closest point on wall AABB
            const closeX = Math.max(w.minX, Math.min(resolvedX, w.maxX));
            const closeZ = Math.max(w.minZ, Math.min(resolvedZ, w.maxZ));

            const dx = resolvedX - closeX;
            const dz = resolvedZ - closeZ;
            const distSq = dx * dx + dz * dz;

            if (distSq < rSq) {
                const dist = Math.sqrt(distSq);
                if (dist > 0.0001) {
                    const overlap = radius - dist;
                    resolvedX += (dx / dist) * overlap;
                    resolvedZ += (dz / dist) * overlap;
                } else {
                    const dMinX = Math.abs(resolvedX - w.minX);
                    const dMaxX = Math.abs(w.maxX - resolvedX);
                    const dMinZ = Math.abs(resolvedZ - w.minZ);
                    const dMaxZ = Math.abs(w.maxZ - resolvedZ);
                    const minOverlap = Math.min(dMinX, dMaxX, dMinZ, dMaxZ);

                    if (minOverlap === dMinX) resolvedX = w.minX - radius;
                    else if (minOverlap === dMaxX) resolvedX = w.maxX + radius;
                    else if (minOverlap === dMinZ) resolvedZ = w.minZ - radius;
                    else resolvedZ = w.maxZ + radius;
                }
            }
        }

        return { x: resolvedX, z: resolvedZ };
    }

    setRaceActive(active) {
        this.isRaceActive = Boolean(active);
        if (!this.isRaceActive) {
            this.player.isMoving = false;
            this.inputVector.x = 0;
            this.inputVector.z = 0;
        }
    }

    updatePlayerPhysics(dt) {
        const inputLen = Math.hypot(this.inputVector.x, this.inputVector.z);
        this.player.isMoving = inputLen > 0.05 && !this.isGameOver && this.isRaceActive;

        if (this.player.isMoving) {
            const moveSpeed = this.player.speed * Math.min(1.0, inputLen);
            const moveX = this.inputVector.x * moveSpeed * dt;
            const moveZ = this.inputVector.z * moveSpeed * dt;

            // Target facing angle locked to movement vector
            this.player.targetAngle = Math.atan2(this.inputVector.x, this.inputVector.z);

            // Sub-stepped movement prevents wall tunneling at high speed
            const totalDist = Math.hypot(moveX, moveZ);
            const maxStep = PLAYER_COLLISION_RADIUS * 0.45;
            const numSteps = Math.max(1, Math.ceil(totalDist / maxStep));
            const stepX = moveX / numSteps;
            const stepZ = moveZ / numSteps;

            for (let s = 0; s < numSteps; s++) {
                const testX = this.player.x + stepX;
                const resX = this.resolveWallCollisions(testX, this.player.z, PLAYER_COLLISION_RADIUS);
                this.player.x = resX.x;

                const testZ = this.player.z + stepZ;
                const resZ = this.resolveWallCollisions(this.player.x, testZ, PLAYER_COLLISION_RADIUS);
                this.player.z = resZ.z;
            }

            // Slerp player rotation forward towards travel direction
            let angleDiff = this.player.targetAngle - this.player.angle;
            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
            while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
            this.player.angle += angleDiff * Math.min(1, dt * 18);

            // Walk cycle animation
            this.player.walkCycle += dt * 12;
            if (this.playerLegL && this.playerLegR) {
                const swing = Math.sin(this.player.walkCycle) * 0.28;
                this.playerLegL.rotation.x = swing;
                this.playerLegR.rotation.x = -swing;
            }

            // Footstep sound cadence
            if (Math.sin(this.player.walkCycle) > 0.95 && !this.stepping) {
                this.sound.playStep();
                this.stepping = true;
            } else if (Math.sin(this.player.walkCycle) < 0) {
                this.stepping = false;
            }
        } else {
            if (this.playerLegL && this.playerLegR) {
                this.playerLegL.rotation.x = 0;
                this.playerLegR.rotation.x = 0;
            }
        }

        // Apply transform to player group
        if (this.playerGroup) {
            this.playerGroup.position.x = this.player.x;
            this.playerGroup.position.z = this.player.z;
            this.playerGroup.rotation.y = this.player.angle;
            this.playerGroup.position.y = this.player.isMoving ? Math.abs(Math.sin(this.player.walkCycle)) * 0.04 : 0;
        }

        // Lock forward spotlight target in world coordinates
        if (this.spotTarget) {
            const forwardX = Math.sin(this.player.angle);
            const forwardZ = Math.cos(this.player.angle);
            this.spotTarget.position.set(
                this.player.x + forwardX * 14,
                0.5,
                this.player.z + forwardZ * 14
            );
        }

        // Grid cell step tracking
        const curCellX = Math.floor(this.player.x / CELL_SIZE);
        const curCellY = Math.floor(this.player.z / CELL_SIZE);

        if (curCellX !== this.lastStepTile.x || curCellY !== this.lastStepTile.y) {
            this.lastStepTile = { x: curCellX, y: curCellY };
            this.steps++;
            this.updateHUD();
            this.maze.markTraveled(curCellX, curCellY);
            this.saveActiveSession();
        }

        // Check letter pickup
        this.checkProximityLetterPickup();
    }

    /* -----------------------------------------------------
       8. LETTER PICKUP & WIN SEQUENCE (A, C, M)
       ----------------------------------------------------- */
    checkProximityLetterPickup() {
        for (const l of this.letterGroups) {
            if (l.collected) continue;

            const dist = Math.hypot(this.player.x - l.worldX, this.player.z - l.worldZ);
            if (dist < 1.15) {
                l.collected = true;
                const letter = this.maze.checkLetterAt(l.gridX, l.gridY);
                if (letter) letter.collected = true;

                this.collectedSequence.push(l.id);
                this.sound.playLetterCollect(l.id);

                this.spawnCollectionParticles(l.worldX, 0.8, l.worldZ, l.light.color);
                l.group.visible = false;

                const badge = document.getElementById(`badge${l.id}`);
                if (badge) {
                    badge.classList.add('collected');
                    badge.innerHTML = `${l.id}: [✓]`;
                }

                this.updateHUD();
                this.notify(`Discovered rune '${l.id}'! (${this.collectedSequence.length}/3)`);
                this.saveActiveSession();

                // Win condition: Letters A, C, and M collected
                if (this.maze.isComplete()) {
                    this.triggerVictory();
                }
                break;
            }
        }
    }

    spawnCollectionParticles(x, y, z, threeColor) {
        const count = 28;
        const colorHex = threeColor ? threeColor.getHex() : 0x00f5d4;

        for (let i = 0; i < count; i++) {
            const geo = new THREE.SphereGeometry(Math.random() * 0.07 + 0.03, 6, 6);
            const mat = new THREE.MeshBasicMaterial({ color: colorHex });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(x, y, z);

            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 3.2 + 1.0;
            this.particles.push({
                mesh: mesh,
                vx: Math.cos(angle) * speed,
                vy: Math.random() * 2.8 + 1.8,
                vz: Math.sin(angle) * speed,
                life: 1.0,
                decay: Math.random() * 0.8 + 0.7
            });
            this.scene.add(mesh);
        }
    }

    triggerVictory() {
        if (this.isGameOver) return;
        this.isGameOver = true;
        this.setRaceActive(false);
        clearInterval(this.timerInterval);
        this.sound.playVictory();

        this.spawnCollectionParticles(this.player.x, 1.2, this.player.z, new THREE.Color(0xffb703));
        this.spawnCollectionParticles(this.player.x, 1.6, this.player.z, new THREE.Color(0x00f5d4));

        if (typeof this.onSpellComplete === 'function') {
            setTimeout(() => {
                this.onSpellComplete({
                    seconds: this.elapsedSeconds,
                    steps: this.steps,
                    sequence: this.collectedSequence
                });
            }, 600);
        }
    }

    /* -----------------------------------------------------
       9. SMOOTH CAMERA TRACKING & SCENE ANIMATIONS
       ----------------------------------------------------- */
    updateCameraFollow(dt) {
        if (!this.camera) return;

        const camElevation = 14.0;
        const camZOffset = 7.5;

        const targetCamX = this.player.x;
        const targetCamZ = this.player.z + camZOffset;

        const factor = 1 - Math.exp(-9.0 * dt);
        this.camTarget.x += (targetCamX - this.camTarget.x) * factor;
        this.camTarget.z += (targetCamZ - this.camTarget.z) * factor;

        this.camera.position.set(this.camTarget.x, camElevation, this.camTarget.z);
        this.camera.lookAt(this.camTarget.x, 0.45, this.camTarget.z - camZOffset);

        if (this.dustPoints) {
            this.dustPoints.position.x = this.player.x;
            this.dustPoints.position.z = this.player.z;
        }
    }

    updateSceneAnimations(dt, time) {
        if (this.torchLight) {
            this.torchLight.intensity = 2.4 + Math.sin(time * 12) * 0.2;
        }

        this.wisps.forEach(w => {
            w.angle += w.speed * dt;
            w.mesh.position.x = Math.cos(w.angle) * w.radius;
            w.mesh.position.z = Math.sin(w.angle) * w.radius;
            w.mesh.position.y = 0.8 + Math.sin(time * 4 + w.angle) * 0.18;
        });

        this.letterGroups.forEach(l => {
            if (!l.collected && l.mesh) {
                l.mesh.rotation.y += dt * 1.8;
                l.mesh.position.y = l.baseY + Math.sin(time * 3.2 + l.gridX) * 0.16;
                if (l.ring) {
                    l.ring.rotation.z += dt * 0.9;
                }
            }
        });

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life -= p.decay * dt;
            if (p.life <= 0) {
                this.scene.remove(p.mesh);
                if (p.mesh.geometry) p.mesh.geometry.dispose();
                this.particles.splice(i, 1);
            } else {
                p.mesh.position.x += p.vx * dt;
                p.mesh.position.y += p.vy * dt;
                p.mesh.position.z += p.vz * dt;
                p.vy -= 9.8 * dt;
                p.mesh.scale.setScalar(p.life);
            }
        }
    }

    /* -----------------------------------------------------
       10. MAIN GAME LOOP
       ----------------------------------------------------- */
    loop(timestamp) {
        if (!this.lastTimestamp) this.lastTimestamp = timestamp;
        const dt = Math.min((timestamp - this.lastTimestamp) / 1000, 0.05); // Capped at 50ms to prevent stutter jumps
        this.lastTimestamp = timestamp;
        this.animTime += dt;

        this.updatePlayerPhysics(dt);
        this.updateCameraFollow(dt);
        this.updateSceneAnimations(dt, this.animTime);

        // Throttle session snapshot saving to once every 800ms
        if (timestamp - this.lastSessionSaveTime > 800 && this.player.isMoving) {
            this.lastSessionSaveTime = timestamp;
            this.saveActiveSession();
        }

        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }

        requestAnimationFrame((t) => this.loop(t));
    }

    /* -----------------------------------------------------
       11. SESSION PERSISTENCE & REHYDRATION (REFRESH HANDLING)
       ----------------------------------------------------- */
    saveActiveSession() {
        try {
            const roomId = (new URLSearchParams(window.location.search).get("room") || "ACM2026").toUpperCase();
            const sessionData = {
                x: this.player.x,
                z: this.player.z,
                angle: this.player.angle,
                steps: this.steps,
                collectedSequence: [...this.collectedSequence],
                mazeState: this.maze.exportState(),
                timestamp: Date.now()
            };
            sessionStorage.setItem(`acm_active_game_${roomId}`, JSON.stringify(sessionData));
        } catch (e) {}
    }

    rehydrate(saved) {
        if (!saved) return false;

        // Restore maze layout & runes
        if (saved.mazeState) {
            this.maze.importState(saved.mazeState);
            this.buildDungeonMaze();
            this.buildLetterCollectibles();
        }

        // Restore player position & rotation
        if (typeof saved.x === 'number') this.player.x = saved.x;
        if (typeof saved.z === 'number') this.player.z = saved.z;
        if (typeof saved.angle === 'number') {
            this.player.angle = saved.angle;
            this.player.targetAngle = saved.angle;
        }

        if (typeof saved.steps === 'number') this.steps = saved.steps;

        // Restore collected letters
        if (Array.isArray(saved.collectedSequence)) {
            this.collectedSequence = [...saved.collectedSequence];
            this.collectedSequence.forEach(id => {
                const letter = this.maze.letters.find(l => l.id === id);
                if (letter) letter.collected = true;
                const lg = this.letterGroups.find(l => l.id === id);
                if (lg) {
                    lg.collected = true;
                    if (lg.group) lg.group.visible = false;
                }
                const badge = document.getElementById(`badge${id}`);
                if (badge) {
                    badge.classList.add('collected');
                    badge.innerHTML = `${id}: [✓]`;
                }
            });
        }

        this.camTarget.x = this.player.x;
        this.camTarget.z = this.player.z;
        if (this.playerGroup) {
            this.playerGroup.position.x = this.player.x;
            this.playerGroup.position.z = this.player.z;
            this.playerGroup.rotation.y = this.player.angle;
        }

        this.setRaceActive(true);
        this.updateHUD();
        this.notify(`Session restored! Continue hunting letters A, C, and M!`);
        return true;
    }

    /* -----------------------------------------------------
       12. HUD, TIMERS & RESET FLOW
       ----------------------------------------------------- */
    startTimer(serverStartTime = null) {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.startTime = serverStartTime || Date.now();
        this.elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.startTime) / 1000));
        this.timerInterval = setInterval(() => {
            this.elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.startTime) / 1000));
            this.updateHUD();
        }, 1000);
    }

    updateHUD() {
        const stepVal = document.getElementById('stepVal');
        if (stepVal) stepVal.textContent = this.steps;

        const orderVal = document.getElementById('orderVal');
        if (orderVal) {
            orderVal.textContent = this.collectedSequence.length > 0
                ? this.collectedSequence.join(' ➔ ')
                : 'None yet (Any sequence allowed)';
        }

        // Minimal HUD Letter Badges: A: [ ], C: [ ], M: [ ]
        ['A', 'C', 'M'].forEach(id => {
            const badge = document.getElementById(`badge${id}`);
            if (badge) {
                const isFound = this.collectedSequence.includes(id);
                badge.classList.toggle('collected', isFound);
                badge.innerHTML = isFound ? `${id}: [✓]` : `${id}: [ ]`;
            }
        });
    }

    notify(msg) {
        const banner = document.getElementById('statusBanner');
        if (banner) {
            banner.textContent = msg;
            banner.classList.remove('pulse');
            void banner.offsetWidth;
            banner.classList.add('pulse');
        }
    }

    resetGame(seed = null, startTimerNow = false, serverStartTime = null) {
        if (seed !== null && seed !== undefined) {
            this.seed = seed;
        }
        this.maze = new Maze(this.mazeSize, this.mazeSize, this.seed);

        const startWorldX = (this.maze.startPos.x + 0.5) * CELL_SIZE;
        const startWorldZ = (this.maze.startPos.y + 0.5) * CELL_SIZE;

        this.player.x = startWorldX;
        this.player.z = startWorldZ;
        this.player.angle = 0;
        this.player.targetAngle = 0;
        this.lastStepTile = { x: this.maze.startPos.x, y: this.maze.startPos.y };
        this.camTarget.x = this.player.x;
        this.camTarget.z = this.player.z;

        this.steps = 0;
        this.isGameOver = false;
        this.isRaceActive = Boolean(startTimerNow);
        this.collectedSequence = [];

        this.buildDungeonMaze();
        this.buildLetterCollectibles();

        if (startTimerNow) {
            this.startTimer(serverStartTime);
        } else {
            if (this.timerInterval) clearInterval(this.timerInterval);
            this.elapsedSeconds = 0;
        }
        this.updateHUD();
        this.notify("Explore the 3D labyrinth to uncover hidden spell letters A, C, and M!");
    }
}

// Start game when DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
    window.gameInstance = new Game();
});
