// --- Efficient literal+run compression with 2-bit packing ---
function compressBuffer(input: Buffer): Buffer {
    // Pack 4 tiles (2 bits each) into one byte
    let packed: number[] = []
    for (let i = 0; i < input.length; i += 4) {
        let b = 0
        for (let k = 0; k < 4 && i + k < input.length; k++) {
            let tile = input.getUint8(i + k) & 0x3
            b |= tile << (k * 2)
        }
        packed.push(b)
    }

    let output: number[] = []
    let i = 0
    while (i < packed.length) {
        // Detect run
        let runLength = 1
        while (i + runLength < packed.length && packed[i + runLength] === packed[i] && runLength < 127) {
            runLength++
        }

        if (runLength >= 3) {
            // Encode as run block
            output.push(0x80 | runLength) // high bit=1, length=runLength
            output.push(packed[i])        // repeated value
            i += runLength
        } else {
            // Encode as literal block
            let start = i
            let litCount = 0
            while (i < packed.length && litCount < 127) {
                // stop if a run of >=3 is coming
                let lookahead = 1
                while (i + lookahead < packed.length && packed[i + lookahead] === packed[i] && lookahead < 127) {
                    lookahead++
                }
                if (lookahead >= 3) break
                i++
                litCount++
            }
            output.push(litCount) // high bit=0, length=litCount
            for (let j = 0; j < litCount; j++) {
                output.push(packed[start + j])
            }
        }
    }

    return Buffer.fromArray(output)
}

function decompressBuffer(input: Buffer): Buffer {
    let packed: number[] = []
    let i = 0
    while (i < input.length) {
        let ctrl = input.getUint8(i); i++
        if ((ctrl & 0x80) != 0) {
            // Run block
            let runLength = ctrl & 0x7F
            let value = input.getUint8(i); i++
            for (let j = 0; j < runLength; j++) packed.push(value)
        } else {
            // Literal block
            let litCount = ctrl & 0x7F
            for (let j = 0; j < litCount; j++) {
                packed.push(input.getUint8(i)); i++
            }
        }
    }

    // Unpack 2-bit tiles back into 64 values
    let output: number[] = []
    for (let b of packed) {
        for (let k = 0; k < 4; k++) {
            let tile = (b >> (k * 2)) & 0x3
            output.push(tile)
        }
    }
    return Buffer.fromArray(output)
}

// --- Chunk serialization ---
function chunkToBuffer(chunk: number[][]): Buffer {
    let flat: number[] = []
    for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
            flat.push(chunk[i][j])
        }
    }
    return Buffer.fromArray(flat)
}

function bufferToChunk(buf: Buffer): number[][] {
    let chunk: number[][] = []
    let idx = 0
    for (let i = 0; i < 8; i++) {
        let row: number[] = []
        for (let j = 0; j < 8; j++) {
            row.push(buf.getUint8(idx))
            idx++
        }
        chunk.push(row)
    }
    return chunk
}




function genChunksInRadius() {
    let statusbar = statusbars.create(30, 84, 0)
    statusbar.setLabel("Chunk 0/100")
    statusbar.setColor(3, 2, 2)
    statusbar.max = 100
    statusbar.value = 0
    statusbar.x -= 32
    let cur = 0
    for (let i = -5; i < 5; i++) {
        for (let j = -5; j < 5; j++) {
            getOrGenerateChunk(i, j)
            cur++
            statusbar.value = cur
            statusbar.setLabel(`Chunk ${cur}/100`)
            pause(0)
        }
    }
    saveWorld()
    pause(100)
    statusbar.destroy()
}

function entertransmitMode() {
    NetWorking.init()
    let myDisplay = miniMenu.createMenu(miniMenu.createMenuItem("Finding Peers..."))
    let waitableips = NetWorking.GetPeers()
    waitableips.then(function (ips) {
        let myMenu = miniMenu.createMenuFromArray(ips.map((a) => miniMenu.createMenuItem(a)))
        myMenu.onButtonPressed(controller.A, function (selection, index) {
            game.splash("Attempting Tranfer")
            try {
                worldtransfer.sendWorld(selection, settings.readBuffer("world"))
                game.splash("Transfer Complete!")
            } catch (e) {
                game.splash("Tranfer Failed With Error:", e)
            }
        })
    })
}

function enterreciveMode() {
    NetWorking.init()
    let myDisplay = miniMenu.createMenu(miniMenu.createMenuItem("Finding Peers..."))
    let waitableips = NetWorking.GetPeers()
    myDisplay.setFlag(SpriteFlag.Invisible, true)
    waitableips.then(function (ips) {
        let myMenu = miniMenu.createMenuFromArray(ips.map((a) => miniMenu.createMenuItem(a)))
        myMenu.onButtonPressed(controller.A, function (selection, index) {
            myMenu.close()
            myDisplay.setFlag(SpriteFlag.Invisible, false)
            myDisplay.items[0].text = "Waiting For Transmit"
            pause(0)
            worldtransfer.initReceiver(selection, function (ip, data) {
                myDisplay.items[0].text = "Writing World to Storage..."
                pause(0)
                settings.writeBuffer("world", data)
                loadWorld()
                chunkX = 0; chunkY = 0;
                reloadMap()
                myDisplay.items[0].text = "Process Complete."
                pause(0)
                myDisplay.close()
            })
        })
    })
}

controller.menu.onEvent(ControllerButtonEvent.Pressed, function () {
    let myMenu = miniMenu.createMenuFromArray([miniMenu.createMenuItem("Gen Chunks in 10x10 radius"), miniMenu.createMenuItem("Delete World"), miniMenu.createMenuItem("Tranfer World (From Here)"), miniMenu.createMenuItem("Recive World (From Tranferer)")])
    controller.moveSprite(myPlayer, 0, 0)
    myMenu.onButtonPressed(controller.A, function (selection, index) {
        if (index == 0) {
            myMenu.close()
            genChunksInRadius()
        }
        if (index == 1) {
            myMenu.close()
            settings.remove("world")
            reloadMap()
        }
        if (index == 2) {
            myMenu.close()
            entertransmitMode()
        }
        if (index == 3) {
            myMenu.close()
            enterreciveMode()
        }
        controller.moveSprite(myPlayer, 100, 100)
    })
})

// --- World storage with index table ---
let chunks: { [key: string]: { data: number[][], biome: number } } = {}
let chunksLoaded: number = 0
let indexTable: { [key: string]: { offset: number, length: number } } = {}
let biomeTable: { [key: string]: { biome: number } } = {}

function saveBiomes() {
    let keys = Object.keys(biomeTable)
    let out: number[] = []

    // count
    out.push(keys.length & 0xFF)
    out.push((keys.length >> 8) & 0xFF)
    out.push((keys.length >> 16) & 0xFF)

    // entries: x, y, biome
    for (let k of keys) {
        let [x, y] = k.split(":").map(n => parseInt(n))
        let biome = biomeTable[k].biome

        out.push(x & 0xFF)
        out.push((x >> 8) & 0xFF)
        out.push(y & 0xFF)
        out.push((y >> 8) & 0xFF)
        out.push(biome & 0xFF)
    }

    settings.writeBuffer("biomes", Buffer.fromArray(out))
}

function saveWorld() {
    // Step 1: Load existing world file if present
    let existing = settings.readBuffer("world")
    let oldChunks: { [key: string]: Buffer } = {}

    if (existing) {
        let chunkCount = existing.getUint8(0)
            | (existing.getUint8(1) << 8)
            | (existing.getUint8(2) << 16)

        let dataStart = 3 + chunkCount * 5
        let offset = 0
        for (let i = 0; i < chunkCount; i++) {
            let base = 3 + i * 5
            let x = existing.getUint8(base) | (existing.getUint8(base + 1) << 8)
            let y = existing.getUint8(base + 2) | (existing.getUint8(base + 3) << 8)
            let length = existing.getUint8(base + 4)
            let comp = existing.slice(dataStart + offset, length)
            oldChunks[`${x}:${y}`] = comp
            offset += length
        }
    }

    // Step 2: Merge old chunks with current chunks
    for (let k of Object.keys(chunks)) {
        let buf = chunkToBuffer(chunks[k].data)
        oldChunks[k] = compressBuffer(buf)
    }

    // Step 3: Build new buffer
    let keys = Object.keys(oldChunks)
    let all: number[] = []
    all.push(keys.length & 0xFF)
    all.push((keys.length >> 8) & 0xFF)
    all.push((keys.length >> 16) & 0xFF)

    // Reserve index space (5 bytes per entry)
    let indexSize2 = keys.length * 5
    for (let i = 0; i < indexSize2; i++) all.push(0)

    // Write data and fill index
    for (let idx = 0; idx < keys.length; idx++) {
        let k = keys[idx]
        let parts = k.split(":")
        let x = parseInt(parts[0])
        let y = parseInt(parts[1])
        let compressed = oldChunks[k]

        // Write compressed data
        for (let i = 0; i < compressed.length; i++) {
            all.push(compressed.getUint8(i))
        }

        // Fill index entry (no offset, only x,y,length)
        let base = 3 + idx * 5
        all[base] = x & 0xFF
        all[base + 1] = (x >> 8) & 0xFF
        all[base + 2] = y & 0xFF
        all[base + 3] = (y >> 8) & 0xFF
        all[base + 4] = compressed.length & 0xFF
    }

    // Step 4: Save merged buffer
    settings.writeBuffer("world", Buffer.fromArray(all))
    updatePlayerDataSaved()


    saveBiomes()

}

function updatePlayerDataSaved() {
    settings.writeNumber("pcx", chunkX)
    settings.writeNumber("pcy", chunkY)
    settings.writeNumber("px", myPlayer.x)
    settings.writeNumber("py", myPlayer.y)
}

let chunkcount = 0

function loadWorld() {
    let buf = settings.readBuffer("world")
    if (!buf) {
        console.log("NO WORLD SAVED SKIPPING LOADING")
        return
    }

    let chunkCount = buf.getUint8(0)
        | (buf.getUint8(1) << 8)
        | (buf.getUint8(2) << 16)

    chunkcount = chunkCount
    indexTable = {}

    let dataStart = 3 + chunkCount * 5
    let offset = 0
    for (let i = 0; i < chunkCount; i++) {
        let base = 3 + i * 5
        let x = buf.getUint8(base) | (buf.getUint8(base + 1) << 8)
        let y = buf.getUint8(base + 2) | (buf.getUint8(base + 3) << 8)
        let length = buf.getUint8(base + 4)

        indexTable[`${x}:${y}`] = { offset: dataStart + offset, length: length }
        offset += length
    }

    if (settings.exists("pcx")) {
        chunkX = settings.readNumber("pcx")
        chunkY = settings.readNumber("pcy")
        myPlayer.x = settings.readNumber("px")
        myPlayer.y = settings.readNumber("py")
    }


    loadBiomeTable()
}

function loadBiomeTable() {
    let buf = settings.readBuffer("biomes")
    if (!buf) {
        biomeTable = {}
        return
    }

    let count = buf.getUint8(0)
        | (buf.getUint8(1) << 8)
        | (buf.getUint8(2) << 16)

    biomeTable = {}

    let offset = 3
    for (let i = 0; i < count; i++) {
        let x = buf.getUint8(offset) | (buf.getUint8(offset + 1) << 8)
        let y = buf.getUint8(offset + 2) | (buf.getUint8(offset + 3) << 8)
        let biome = buf.getUint8(offset + 4)
        offset += 5

        biomeTable[`${x}:${y}`] = { biome }
    }
}

function loadChunkFromWorld(x: number, y: number): { data: number[][], biome: number } {
    let key = `${x}:${y}`
    let entry = indexTable[key]
    if (!entry) return null

    let buf = settings.readBuffer("world")
    if (!buf) return null

    // IMPORTANT: make slice unambiguous
    let comp = buf.slice(entry.offset, entry.offset + entry.length)
    if (!comp || comp.length === 0) {
        console.log("empty/invalid comp for " + key)


        return null
    }

    let decompressed = decompressBuffer(comp)
    if (!decompressed || decompressed.length < 64) {
        console.log(`bad decompressed length ${decompressed.length} for ${key}`)
        return null
    }

    let biomeEntry = biomeTable[key]
    let biome = biomeEntry ? biomeEntry.biome : 0

    return {
        data: bufferToChunk(decompressed),
        biome: biome
    }
}

function indexTableSize(buf: Buffer): number {
    let chunkCount = buf.getUint8(0)
        | (buf.getUint8(1) << 8)
        | (buf.getUint8(2) << 16)
    return chunkCount * 5 // 5 bytes per entry in new format
}

// --- Chunk system ---
let chunkX = 0
let chunkY = 0

enum Biome {
    Grassland = 1,
    Forest = 2,
    DenseGrass = 3,
    Rocky = 4,
    Swamp = 5,
    Desert = 6,
    Snow = 7,
    Tundra = 8
}

const biomeSlotWeights: { [key: number]: { slot0: number, slot1: number, slot2: number, slot3: number } } = {
    [Biome.Grassland]: { slot0: 60, slot1: 20, slot2: 10, slot3: 10 },
    [Biome.Forest]: { slot0: 30, slot1: 30, slot2: 10, slot3: 30 },
    [Biome.DenseGrass]: { slot0: 50, slot1: 25, slot2: 5, slot3: 20 },
    [Biome.Rocky]: { slot0: 10, slot1: 10, slot2: 70, slot3: 10 },
    [Biome.Swamp]: { slot0: 20, slot1: 40, slot2: 5, slot3: 35 },
    [Biome.Desert]: { slot0: 60, slot1: 25, slot2: 10, slot3: 5 },
    [Biome.Snow]: {
        slot0: 60,  // snow
        slot1: 25,  // snow
        slot2: 10,  // ice
        slot3: 5    // rocks
    },
    [Biome.Tundra]: {
        slot0: 50,  // snow
        slot1: 30,  // dark grass
        slot2: 15,  // rocks
        slot3: 5    // ice
    },
}
/*
const sharedTiles = {
    grass: assets.tile`Grass`,
    darkGrass: assets.tile`dark-grass`,
    rocks: assets.tile`rocks`,
    tree: assets.tile`tree`
}

const biomeUniqueTiles = {
    sand: assets.tile`sand`,
    cactus: assets.tile`cactus`,
    mud: assets.tile`mud`,
    swampTree: assets.tile`dead-tree`,
    snow: assets.tile`snow`,
    ice: assets.tile`ice`
}
*/

const biomeTilePalette: { [index: number]: Image[] } = {
    [Biome.Grassland]: [
        assets.tile`Grass`,
        assets.tile`dark-grass`,
        assets.tile`rocks`,
        assets.tile`tree`
    ],

    [Biome.Forest]: [
        assets.tile`Grass`,
        assets.tile`dark-grass`,
        assets.tile`tree`,
        assets.tile`tree`
    ],

    [Biome.DenseGrass]: [
        assets.tile`Grass`,
        assets.tile`dark-grass`,
        assets.tile`Grass`,
        assets.tile`tree`
    ],

    [Biome.Rocky]: [
        assets.tile`rocks`,
        assets.tile`rocks`,
        assets.tile`dark-grass`,
        assets.tile`tree`
    ],

    [Biome.Swamp]: [
        assets.tile`mud`,
        assets.tile`mud-grass`,
        assets.tile`mud-rocks`,
        assets.tile`mud-tree`
    ],

    [Biome.Desert]: [
        assets.tile`sand`,
        assets.tile`sand`,
        assets.tile`cactus`,
        assets.tile`desert-rocks`
    ],

    [Biome.Snow]: [
        assets.tile`snow`,   // slot0
        assets.tile`snow`,   // slot1
        assets.tile`ice`,    // slot2
        assets.tile`snow-rocks`   // slot3
    ],
    [Biome.Tundra]: [
        assets.tile`snow`,       // slot0
        assets.tile`snow-grass`, // slot1
        assets.tile`snow-rocks`,      // slot2
        assets.tile`ice`         // slot3
    ]
}

const BIOME_COUNT = 8

function chooseBiome(x: number, y: number): number {

    let neighbors = []
    let keys = [
        `${x - 1}:${y}`,
        `${x + 1}:${y}`,
        `${x}:${y - 1}`,
        `${x}:${y + 1}`
    ]

    for (let k of keys) {
        if (biomeTable[k]) neighbors.push(biomeTable[k].biome)
    }

    // No neighbors → random biome
    if (neighbors.length == 0) {
        return randint(1, BIOME_COUNT) // number of biomes
    }

    // Count frequencies
    let counts: { [key: number]: number } = {}
    for (let b of neighbors) {
        counts[b] = (counts[b] || 0) + 1
    }

    // Find most common biome
    let bestBiome = neighbors[0]
    let bestCount = 0
    for (let b of Object.keys(counts)) {
        let biome = parseInt(b)
        if (counts[biome] > bestCount) {
            bestCount = counts[biome]
            bestBiome = biome
        }
    }

    // 60% chance to match neighbors
    if (Math.percentChance(60)) {
        return bestBiome
    }

    // 30% chance to pick a neighbor biome randomly
    if (Math.percentChance(30)) {
        return neighbors[randint(0, neighbors.length - 1)]
    }

    // 10% chance to pick a random biome
    return randint(1,BIOME_COUNT)
}

// --- Final generateChunk() ---
function generateChunk(): { data: number[][], biome: number } {
    // Pick biome using your neighbor-aware logic
    let biome = chooseBiome(chunkX, chunkY)

    // Get the slot weights for this biome
    let weights = biomeSlotWeights[biome]

    let map: number[][] = []

    for (let i = 0; i < 8; i++) {
        let row: number[] = []
        for (let j = 0; j < 8; j++) {

            let r = randint(1, 100)
            let tileSlot = 0

            // Slot selection based on weights
            if (r <= weights.slot0) {
                tileSlot = 0
            } else if (r <= weights.slot0 + weights.slot1) {
                tileSlot = 1
            } else if (r <= weights.slot0 + weights.slot1 + weights.slot2) {
                tileSlot = 2
            } else {
                tileSlot = 3
            }

            row.push(tileSlot)
        }
        map.push(row)
    }

    return { data: map, biome }
}




function getOrGenerateChunk(x: number, y: number): { data: number[][], biome: number } {
    let key = `${x}:${y}`

    // If chunk already exists, return it properly
    if (chunks[key]) {
        return chunks[key]
    }

    // Try loading from world
    let loaded = loadChunkFromWorld(x, y)
    if (loaded) {
        chunks[key] = loaded
        chunksLoaded++
        return loaded
    }

    // Otherwise generate new
    let generated = generateChunk()
    chunks[key] = generated
    biomeTable[key] = { biome: generated.biome }
    saveWorld()
    return generated
}

// --- Player + map reload ---
const chunkWidthPixels = 16 * 8
const chunkHeightPixels = 16 * 8

let myPlayer = sprites.create(assets.image`myPlayer`)
myPlayer.setFlag(SpriteFlag.StayInScreen, true)
controller.moveSprite(myPlayer, 100, 100)

characterAnimations.loopFrames(myPlayer, [img`
    . . . . . . . . . . . . . . . .
    . . . . f f f f f f . . . . . .
    . . . f 2 f e e e e f f . . . .
    . . f 2 2 2 f e e e e f f . . .
    . . f e e e e f f e e e f . . .
    . f e 2 2 2 2 e e f f f f . . .
    . f 2 e f f f f 2 2 2 e f . . .
    . f f f e e e f f f f f f f . .
    . f e e 4 4 f b e 4 4 e f f . .
    . . f e d d f 1 4 d 4 e e f . .
    . . . f d d d d 4 e e e f . . .
    . . . f e 4 4 4 e d d 4 . . . .
    . . . f 2 2 2 2 e d d e . . . .
    . . f f 5 5 4 4 f e e f . . . .
    . . f f f f f f f f f f . . . .
    . . . f f f . . . f f . . . . .
`,img`
    . . . . f f f f f f . . . . . .
    . . . f 2 f e e e e f f . . . .
    . . f 2 2 2 f e e e e f f . . .
    . . f e e e e f f e e e f . . .
    . f e 2 2 2 2 e e f f f f . . .
    . f 2 e f f f f 2 2 2 e f . . .
    . f f f e e e f f f f f f f . .
    . f e e 4 4 f b e 4 4 e f f . .
    . . f e d d f 1 4 d 4 e e f . .
    . . . f d d d d 4 e e e f . . .
    . . . f e 4 4 4 e e f f . . . .
    . . . f 2 2 2 e d d 4 . . . . .
    . . . f 2 2 2 e d d e . . . . .
    . . . f 5 5 4 f e e f . . . . .
    . . . . f f f f f f . . . . . .
    . . . . . . f f f . . . . . . .
`,img`
    . . . . . . . . . . . . . . . .
    . . . . f f f f f f . . . . . .
    . . . f 2 f e e e e f f . . . .
    . . f 2 2 2 f e e e e f f . . .
    . . f e e e e f f e e e f . . .
    . f e 2 2 2 2 e e f f f f . . .
    . f 2 e f f f f 2 2 2 e f . . .
    . f f f e e e f f f f f f f . .
    . f e e 4 4 f b e 4 4 e f f . .
    . . f e d d f 1 4 d 4 e e f . .
    . . . f d d d e e e e e f . . .
    . . . f e 4 e d d 4 f . . . . .
    . . . f 2 2 e d d e f . . . . .
    . . f f 5 5 f e e f f f . . . .
    . . f f f f f f f f f f . . . .
    . . . f f f . . . f f . . . . .
`,img`
    . . . . f f f f f f . . . . . .
    . . . f 2 f e e e e f f . . . .
    . . f 2 2 2 f e e e e f f . . .
    . . f e e e e f f e e e f . . .
    . f e 2 2 2 2 e e f f f f . . .
    . f 2 e f f f f 2 2 2 e f . . .
    . f f f e e e f f f f f f f . .
    . f e e 4 4 f b e 4 4 e f f . .
    . . f e d d f 1 4 d 4 e e f . .
    . . . f d d d d 4 e e e f . . .
    . . . f e 4 4 4 e e f f . . . .
    . . . f 2 2 2 e d d 4 . . . . .
    . . . f 2 2 2 e d d e . . . . .
    . . . f 5 5 4 f e e f . . . . .
    . . . . f f f f f f . . . . . .
    . . . . . . f f f . . . . . . .
`], 100, characterAnimations.rule(Predicate.MovingLeft))

characterAnimations.loopFrames(myPlayer, [img`
    . . . . . . . . . . . . . . . .
    . . . . . . f f f f f f . . . .
    . . . . f f e e e e f 2 f . . .
    . . . f f e e e e f 2 2 2 f . .
    . . . f e e e f f e e e e f . .
    . . . f f f f e e 2 2 2 2 e f .
    . . . f e 2 2 2 f f f f e 2 f .
    . . f f f f f f f e e e f f f .
    . . f f e 4 4 e b f 4 4 e e f .
    . . f e e 4 d 4 1 f d d e f . .
    . . . f e e e 4 d d d d f . . .
    . . . . 4 d d e 4 4 4 e f . . .
    . . . . e d d e 2 2 2 2 f . . .
    . . . . f e e f 4 4 5 5 f f . .
    . . . . f f f f f f f f f f . .
    . . . . . f f . . . f f f . . .
`, img`
    . . . . . . f f f f f f . . . .
    . . . . f f e e e e f 2 f . . .
    . . . f f e e e e f 2 2 2 f . .
    . . . f e e e f f e e e e f . .
    . . . f f f f e e 2 2 2 2 e f .
    . . . f e 2 2 2 f f f f e 2 f .
    . . f f f f f f f e e e f f f .
    . . f f e 4 4 e b f 4 4 e e f .
    . . f e e 4 d 4 1 f d d e f . .
    . . . f e e e 4 d d d d f . . .
    . . . . f f e e 4 4 4 e f . . .
    . . . . . 4 d d e 2 2 2 f . . .
    . . . . . e d d e 2 2 2 f . . .
    . . . . . f e e f 4 5 5 f . . .
    . . . . . . f f f f f f . . . .
    . . . . . . . f f f . . . . . .
`, img`
    . . . . . . . . . . . . . . . .
    . . . . . . f f f f f f . . . .
    . . . . f f e e e e f 2 f . . .
    . . . f f e e e e f 2 2 2 f . .
    . . . f e e e f f e e e e f . .
    . . . f f f f e e 2 2 2 2 e f .
    . . . f e 2 2 2 f f f f e 2 f .
    . . f f f f f f f e e e f f f .
    . . f f e 4 4 e b f 4 4 e e f .
    . . f e e 4 d 4 1 f d d e f . .
    . . . f e e e e e d d d f . . .
    . . . . . f 4 d d e 4 e f . . .
    . . . . . f e d d e 2 2 f . . .
    . . . . f f f e e f 5 5 f f . .
    . . . . f f f f f f f f f f . .
    . . . . . f f . . . f f f . . .
`, img`
    . . . . . . f f f f f f . . . .
    . . . . f f e e e e f 2 f . . .
    . . . f f e e e e f 2 2 2 f . .
    . . . f e e e f f e e e e f . .
    . . . f f f f e e 2 2 2 2 e f .
    . . . f e 2 2 2 f f f f e 2 f .
    . . f f f f f f f e e e f f f .
    . . f f e 4 4 e b f 4 4 e e f .
    . . f e e 4 d 4 1 f d d e f . .
    . . . f e e e 4 d d d d f . . .
    . . . . f f e e 4 4 4 e f . . .
    . . . . . 4 d d e 2 2 2 f . . .
    . . . . . e d d e 2 2 2 f . . .
    . . . . . f e e f 4 5 5 f . . .
    . . . . . . f f f f f f . . . .
    . . . . . . . f f f . . . . . .
`], 100, characterAnimations.rule(Predicate.MovingRight))

characterAnimations.loopFrames(myPlayer, [img`
    . . . . . . f f f f . . . . . .
    . . . . f f e e e e f f . . . .
    . . . f e e e f f e e e f . . .
    . . f f f f f 2 2 f f f f f . .
    . . f f e 2 e 2 2 e 2 e f f . .
    . . f e 2 f 2 f f 2 f 2 e f . .
    . . f f f 2 2 e e 2 2 f f f . .
    . f f e f 2 f e e f 2 f e f f .
    . f e e f f e e e e f e e e f .
    . . f e e e e e e e e e e f . .
    . . . f e e e e e e e e f . . .
    . . e 4 f f f f f f f f 4 e . .
    . . 4 d f 2 2 2 2 2 2 f d 4 . .
    . . 4 4 f 4 4 4 4 4 4 f 4 4 . .
    . . . . . f f f f f f . . . . .
    . . . . . f f . . f f . . . . .
`,img`
    . . . . . . . . . . . . . . . .
    . . . . . . f f f f . . . . . .
    . . . . f f e e e e f f . . . .
    . . . f e e e f f e e e f . . .
    . . . f f f f 2 2 f f f f . . .
    . . f f e 2 e 2 2 e 2 e f f . .
    . . f e 2 f 2 f f f 2 f e f . .
    . . f f f 2 f e e 2 2 f f f . .
    . . f e 2 f f e e 2 f e e f . .
    . f f e f f e e e f e e e f f .
    . f f e e e e e e e e e e f f .
    . . . f e e e e e e e e f . . .
    . . . e f f f f f f f f 4 e . .
    . . . 4 f 2 2 2 2 2 e d d 4 . .
    . . . e f f f f f f e e 4 . . .
    . . . . f f f . . . . . . . . .
`,img`
    . . . . . . f f f f . . . . . .
    . . . . f f e e e e f f . . . .
    . . . f e e e f f e e e f . . .
    . . f f f f f 2 2 f f f f f . .
    . . f f e 2 e 2 2 e 2 e f f . .
    . . f e 2 f 2 f f 2 f 2 e f . .
    . . f f f 2 2 e e 2 2 f f f . .
    . f f e f 2 f e e f 2 f e f f .
    . f e e f f e e e e f e e e f .
    . . f e e e e e e e e e e f . .
    . . . f e e e e e e e e f . . .
    . . e 4 f f f f f f f f 4 e . .
    . . 4 d f 2 2 2 2 2 2 f d 4 . .
    . . 4 4 f 4 4 4 4 4 4 f 4 4 . .
    . . . . . f f f f f f . . . . .
    . . . . . f f . . f f . . . . .
`,img`
    . . . . . . . . . . . . . . . .
    . . . . . . f f f f . . . . . .
    . . . . f f e e e e f f . . . .
    . . . f e e e f f e e e f . . .
    . . . f f f f 2 2 f f f f . . .
    . . f f e 2 e 2 2 e 2 e f f . .
    . . f e f 2 f f f 2 f 2 e f . .
    . . f f f 2 2 e e f 2 f f f . .
    . . f e e f 2 e e f f 2 e f . .
    . f f e e e f e e e f f e f f .
    . f f e e e e e e e e e e f f .
    . . . f e e e e e e e e f . . .
    . . e 4 f f f f f f f f e . . .
    . . 4 d d e 2 2 2 2 2 f 4 . . .
    . . . 4 e e f f f f f f e . . .
    . . . . . . . . . f f f . . . .
`], 100, characterAnimations.rule(Predicate.MovingUp))

characterAnimations.loopFrames(myPlayer, [img`
    . . . . . . f f f f . . . . . .
    . . . . f f f 2 2 f f f . . . .
    . . . f f f 2 2 2 2 f f f . . .
    . . f f f e e e e e e f f f . .
    . . f f e 2 2 2 2 2 2 e e f . .
    . . f e 2 f f f f f f 2 e f . .
    . . f f f f e e e e f f f f . .
    . f f e f b f 4 4 f b f e f f .
    . f e e 4 1 f d d f 1 4 e e f .
    . . f e e d d d d d d e e f . .
    . . . f e e 4 4 4 4 e e f . . .
    . . e 4 f 2 2 2 2 2 2 f 4 e . .
    . . 4 d f 2 2 2 2 2 2 f d 4 . .
    . . 4 4 f 4 4 5 5 4 4 f 4 4 . .
    . . . . . f f f f f f . . . . .
    . . . . . f f . . f f . . . . .
`,img`
    . . . . . . . . . . . . . . . .
    . . . . . . f f f f . . . . . .
    . . . . f f f 2 2 f f f . . . .
    . . . f f f 2 2 2 2 f f f . . .
    . . f f f e e e e e e f f f . .
    . . f f e 2 2 2 2 2 2 e e f . .
    . f f e 2 f f f f f f 2 e f f .
    . f f f f f e e e e f f f f f .
    . . f e f b f 4 4 f b f e f . .
    . . f e 4 1 f d d f 1 4 e f . .
    . . . f e 4 d d d d 4 e f e . .
    . . f e f 2 2 2 2 e d d 4 e . .
    . . e 4 f 2 2 2 2 e d d e . . .
    . . . . f 4 4 5 5 f e e . . . .
    . . . . f f f f f f f . . . . .
    . . . . f f f . . . . . . . . .
`,img`
    . . . . . . f f f f . . . . . .
    . . . . f f f 2 2 f f f . . . .
    . . . f f f 2 2 2 2 f f f . . .
    . . f f f e e e e e e f f f . .
    . . f f e 2 2 2 2 2 2 e e f . .
    . . f e 2 f f f f f f 2 e f . .
    . . f f f f e e e e f f f f . .
    . f f e f b f 4 4 f b f e f f .
    . f e e 4 1 f d d f 1 4 e e f .
    . . f e e d d d d d d e e f . .
    . . . f e e 4 4 4 4 e e f . . .
    . . e 4 f 2 2 2 2 2 2 f 4 e . .
    . . 4 d f 2 2 2 2 2 2 f d 4 . .
    . . 4 4 f 4 4 5 5 4 4 f 4 4 . .
    . . . . . f f f f f f . . . . .
    . . . . . f f . . f f . . . . .
`,img`
    . . . . . . . . . . . . . . . .
    . . . . . . f f f f . . . . . .
    . . . . f f f 2 2 f f f . . . .
    . . . f f f 2 2 2 2 f f f . . .
    . . f f f e e e e e e f f f . .
    . . f e e 2 2 2 2 2 2 e f f . .
    . f f e 2 f f f f f f 2 e f f .
    . f f f f f e e e e f f f f f .
    . . f e f b f 4 4 f b f e f . .
    . . f e 4 1 f d d f 1 4 e f . .
    . . e f e 4 d d d d 4 e f . . .
    . . e 4 d d e 2 2 2 2 f e f . .
    . . . e d d e 2 2 2 2 f 4 e . .
    . . . . e e f 5 5 4 4 f . . . .
    . . . . . f f f f f f f . . . .
    . . . . . . . . . f f f . . . .
`], 100, characterAnimations.rule(Predicate.MovingDown))

function reloadMap() {
    let chunk = getOrGenerateChunk(chunkX, chunkY)
    let palette = biomeTilePalette[chunk.biome]

    for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
            let block = chunk.data[i][j]
            tiles.setTileAt(tiles.getTileLocation(i, j), palette[block])
        }
    }
}

loadWorld()
let bg_img = image.create(160, 120)
bg_img.fill(8)
scene.setBackgroundImage(bg_img)
scene.setTileMapLevel(assets.tilemap`blank`)
reloadMap()

// --- Movement + chunk switching ---
game.onUpdate(function () {
    if (myPlayer.left < 5) {
        myPlayer.right = chunkWidthPixels - 10
        chunkX--
        reloadMap()
        updatePlayerDataSaved()
    } else if (myPlayer.right > chunkWidthPixels - 5) {
        myPlayer.left = 10
        chunkX++
        reloadMap()
        updatePlayerDataSaved()
    } else if (myPlayer.top < 5) {
        myPlayer.bottom = chunkHeightPixels - 10
        chunkY--
        reloadMap()
        updatePlayerDataSaved()
    } else if (myPlayer.bottom > chunkHeightPixels - 10) {
        myPlayer.top = 10
        chunkY++
        reloadMap()
        updatePlayerDataSaved()
    }

    if (chunksLoaded > 5) {
        chunks = {}
        chunksLoaded = 0
    }
})

// --- HUD ---
game.onShade(function () {
    screen.fillRect(0, 0, 100, 10, 1)
    screen.print(`Position ${(chunkX * 8) + Math.round(myPlayer.x / 16)},${(chunkY * 8) + Math.round(myPlayer.y / 16)}`, 1, 1, 15)
})

console.log(`world is ${(settings.readBuffer("world").length) / 1024} kilobytes for ${chunkcount} chunks`)