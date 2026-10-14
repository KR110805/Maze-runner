/**
 * Maze Generator & Manager (v2 Cell-Based Architecture)
 * Generates an open labyrinth with thin low-poly walls and wide corridors.
 * Calibrated for optimal mobile visibility and smooth player navigation.
 */

function createPRNG(seed) {
    let s = typeof seed === 'number' ? seed : 0;
    if (typeof seed === 'string') {
        for (let i = 0; i < seed.length; i++) {
            s = (s ^ seed.charCodeAt(i)) + ((s << 5) - s) | 0;
        }
    }
    s = (s >>> 0) || 1337;
    return function() {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class Maze {
    constructor(cols = 16, rows = 16, seed = null) {
        this.cols = Math.max(10, cols);
        this.rows = Math.max(10, rows);
        this.seed = seed !== null && seed !== undefined ? seed : Math.floor(Math.random() * 2147483647);
        this.rng = createPRNG(this.seed);
        this.cells = [];     // 2D array of cell objects: { x, y, top, right, bottom, left, visited }
        this.letters = [];   // [ { id: 'A', x, y, collected: false, revealed: false } ]
        this.traveled = [];  // Boolean 2D array for visited cells
        this.startPos = { x: 0, y: 0 };
        this.init();
    }

    random() {
        return this.rng();
    }

    init() {
        // Initialize cells grid with all 4 walls closed
        this.cells = Array.from({ length: this.rows }, (_, r) =>
            Array.from({ length: this.cols }, (_, c) => ({
                x: c,
                y: r,
                top: true,
                right: true,
                bottom: true,
                left: true,
                visited: false
            }))
        );

        this.traveled = Array.from({ length: this.rows }, () => Array(this.cols).fill(false));
        this.traveled[this.startPos.y][this.startPos.x] = true;

        // Generate perfect maze using Recursive Backtracker
        this.generateMaze();

        // Braid maze slightly to create loops and alternate routes (medium difficulty)
        this.braidMaze(0.18);

        // Spawn letters A, C, N spaced far apart
        this.spawnLetters();
    }

    generateMaze() {
        const stack = [];
        let current = this.cells[this.startPos.y][this.startPos.x];
        current.visited = true;
        stack.push(current);

        const directions = [
            { dx: 0, dy: -1, wall: 'top', opp: 'bottom' },
            { dx: 1, dy: 0, wall: 'right', opp: 'left' },
            { dx: 0, dy: 1, wall: 'bottom', opp: 'top' },
            { dx: -1, dy: 0, wall: 'left', opp: 'right' }
        ];

        while (stack.length > 0) {
            current = stack[stack.length - 1];
            const unvisitedNeighbors = [];

            for (const dir of directions) {
                const nx = current.x + dir.dx;
                const ny = current.y + dir.dy;

                if (nx >= 0 && nx < this.cols && ny >= 0 && ny < this.rows) {
                    const neighbor = this.cells[ny][nx];
                    if (!neighbor.visited) {
                        unvisitedNeighbors.push({ cell: neighbor, dir });
                    }
                }
            }

            if (unvisitedNeighbors.length > 0) {
                const { cell: nextCell, dir } = unvisitedNeighbors[Math.floor(this.random() * unvisitedNeighbors.length)];

                // Knock down walls between current and neighbor
                current[dir.wall] = false;
                nextCell[dir.opp] = false;

                nextCell.visited = true;
                stack.push(nextCell);
            } else {
                stack.pop();
            }
        }
    }

    braidMaze(braidRatio = 0.18) {
        // Find dead ends (cells with 3 walls closed) and open one wall to introduce loops
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const cell = this.cells[r][c];
                let wallCount = 0;
                if (cell.top) wallCount++;
                if (cell.right) wallCount++;
                if (cell.bottom) wallCount++;
                if (cell.left) wallCount++;

                if (wallCount >= 3 && this.random() < braidRatio) {
                    const candidates = [];
                    if (cell.top && r > 0) candidates.push({ dir: 'top', opp: 'bottom', nx: c, ny: r - 1 });
                    if (cell.right && c < this.cols - 1) candidates.push({ dir: 'right', opp: 'left', nx: c + 1, ny: r });
                    if (cell.bottom && r < this.rows - 1) candidates.push({ dir: 'bottom', opp: 'top', nx: c, ny: r + 1 });
                    if (cell.left && c > 0) candidates.push({ dir: 'left', opp: 'right', nx: c - 1, ny: r });

                    if (candidates.length > 0) {
                        const pick = candidates[Math.floor(this.random() * candidates.length)];
                        cell[pick.dir] = false;
                        this.cells[pick.ny][pick.nx][pick.opp] = false;
                    }
                }
            }
        }
    }

    spawnLetters() {
        const candidateCells = [];
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const distFromStart = Math.abs(c - this.startPos.x) + Math.abs(r - this.startPos.y);
                if (distFromStart >= 5) {
                    candidateCells.push({ x: c, y: r });
                }
            }
        }

        // Deterministic Fisher-Yates shuffle with seeded RNG
        for (let i = candidateCells.length - 1; i > 0; i--) {
            const j = Math.floor(this.random() * (i + 1));
            const tmp = candidateCells[i];
            candidateCells[i] = candidateCells[j];
            candidateCells[j] = tmp;
        }

        const targetChars = ['A', 'C', 'M'];
        this.letters = [];

        for (const char of targetChars) {
            let selectedIdx = -1;

            for (let i = 0; i < candidateCells.length; i++) {
                const cell = candidateCells[i];
                const farEnough = this.letters.every(l => {
                    const d = Math.abs(l.x - cell.x) + Math.abs(l.y - cell.y);
                    return d >= 6;
                });

                if (farEnough) {
                    selectedIdx = i;
                    break;
                }
            }

            if (selectedIdx === -1 && candidateCells.length > 0) {
                selectedIdx = 0;
            }

            if (selectedIdx !== -1) {
                const [picked] = candidateCells.splice(selectedIdx, 1);
                this.letters.push({
                    id: char,
                    x: picked.x,
                    y: picked.y,
                    collected: false,
                    revealed: false
                });
            }
        }
    }

    /**
     * Generate AABB Bounding Box colliders for all thin walls and outer perimeter.
     * @param {number} cellSize - Width/Depth of a corridor cell (e.g. 2.6)
     * @param {number} wallThickness - Thin wall thickness (e.g. 0.32)
     * @returns {Array<{ minX: number, maxX: number, minZ: number, maxZ: number, type: string }>}
     */
    getWallColliders(cellSize, wallThickness) {
        const colliders = [];
        const halfThick = wallThickness * 0.5;

        // 1. Outer perimeter boundaries
        const mazeWidth = this.cols * cellSize;
        const mazeHeight = this.rows * cellSize;

        // North perimeter (top edge)
        colliders.push({
            minX: -halfThick,
            maxX: mazeWidth + halfThick,
            minZ: -halfThick,
            maxZ: halfThick,
            type: 'outer'
        });
        // South perimeter (bottom edge)
        colliders.push({
            minX: -halfThick,
            maxX: mazeWidth + halfThick,
            minZ: mazeHeight - halfThick,
            maxZ: mazeHeight + halfThick,
            type: 'outer'
        });
        // West perimeter (left edge)
        colliders.push({
            minX: -halfThick,
            maxX: halfThick,
            minZ: -halfThick,
            maxZ: mazeHeight + halfThick,
            type: 'outer'
        });
        // East perimeter (right edge)
        colliders.push({
            minX: mazeWidth - halfThick,
            maxX: mazeWidth + halfThick,
            minZ: -halfThick,
            maxZ: mazeHeight + halfThick,
            type: 'outer'
        });

        // 2. Internal thin walls
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const cell = this.cells[r][c];
                const x0 = c * cellSize;
                const x1 = (c + 1) * cellSize;
                const z0 = r * cellSize;
                const z1 = (r + 1) * cellSize;

                // Vertical wall between cell (c, r) and (c + 1, r)
                if (cell.right && c < this.cols - 1) {
                    colliders.push({
                        minX: x1 - halfThick,
                        maxX: x1 + halfThick,
                        minZ: z0 - halfThick,
                        maxZ: z1 + halfThick,
                        type: 'v-wall'
                    });
                }

                // Horizontal wall between cell (c, r) and (c, r + 1)
                if (cell.bottom && r < this.rows - 1) {
                    colliders.push({
                        minX: x0 - halfThick,
                        maxX: x1 + halfThick,
                        minZ: z1 - halfThick,
                        maxZ: z1 + halfThick,
                        type: 'h-wall'
                    });
                }

                // Corner junction posts (at grid intersections)
                colliders.push({
                    minX: x0 - halfThick,
                    maxX: x0 + halfThick,
                    minZ: z0 - halfThick,
                    maxZ: z0 + halfThick,
                    type: 'corner'
                });
            }
        }

        return colliders;
    }

    markTraveled(cellX, cellY) {
        if (cellX >= 0 && cellX < this.cols && cellY >= 0 && cellY < this.rows) {
            this.traveled[cellY][cellX] = true;
        }
    }

    checkLetterAt(cellX, cellY) {
        for (const letter of this.letters) {
            if (!letter.collected && letter.x === cellX && letter.y === cellY) {
                letter.revealed = true;
                letter.collected = true;
                return letter;
            }
        }
        return null;
    }

    getRemainingLettersCount() {
        return this.letters.filter(l => !l.collected).length;
    }

    isComplete() {
        return this.letters.every(l => l.collected);
    }

    exportState() {
        return {
            cols: this.cols,
            rows: this.rows,
            seed: this.seed,
            cells: this.cells,
            letters: this.letters,
            startPos: this.startPos,
            traveled: this.traveled
        };
    }

    importState(saved) {
        if (!saved) return;
        if (saved.cols) this.cols = saved.cols;
        if (saved.rows) this.rows = saved.rows;
        if (saved.seed !== undefined) {
            this.seed = saved.seed;
            this.rng = createPRNG(this.seed);
        }
        if (saved.cells) this.cells = saved.cells;
        if (saved.letters) this.letters = saved.letters;
        if (saved.startPos) this.startPos = saved.startPos;
        if (saved.traveled) this.traveled = saved.traveled;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Maze;
}
