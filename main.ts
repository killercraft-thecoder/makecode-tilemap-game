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
    pause(100)
    statusbar.destroy()
}

function entertransmitMode() {
    NetWorking.init()
    let myDisplay = miniMenu.createMenu(miniMenu.createMenuItem("Finding Peers..."))
    let waitableips = NetWorking.GetPeers()
    waitableips.then(function (ips) {
        let myMenu = miniMenu.createMenuFromArray(ips.map((a) => miniMenu.createMenuItem(a)))
        myMenu.onButtonPressed(controller.A,function(selection,index) {
            game.splash("Attempting Tranfer")
            try {
                worldtransfer.sendWorld(selection,settings.readBuffer("world"))
            } catch (e) {
                game.splash("Tranfer Failed With Error:",e)
            }
        })
    })
}

function enterreciveMode() {
    NetWorking.init()
    let myDisplay = miniMenu.createMenu(miniMenu.createMenuItem("Finding Peers..."))
    let waitableips = NetWorking.GetPeers()
    myDisplay.setFlag(SpriteFlag.Invisible,true)
    waitableips.then(function (ips) {
        let myMenu = miniMenu.createMenuFromArray(ips.map((a) => miniMenu.createMenuItem(a)))
        myMenu.onButtonPressed(controller.A, function (selection, index) {
            myMenu.close()
            myDisplay.setFlag(SpriteFlag.Invisible,false)
            myDisplay.items[0].text = "Waiting For Transmit"
            pause(10)
            worldtransfer.initReceiver(selection,function(ip,data) {
                myDisplay.items[0].text = "Writing World to Storage..."
                pause(10)
                settings.writeBuffer("world",data)
                loadWorld()
                chunkX = 0; chunkY = 0;
                reloadMap()
                myDisplay.items[0].text = "Process Complete."
                pause(100)
                myDisplay.close()
            })
        })
    })
}

controller.menu.onEvent(ControllerButtonEvent.Pressed, function () {
    let myMenu = miniMenu.createMenuFromArray([miniMenu.createMenuItem("Gen Chunks in 10x10 radius"), miniMenu.createMenuItem("Delete World"),miniMenu.createMenuItem("Tranfer World (From Here)"),miniMenu.createMenuItem("Recive World (From Tranferer)")])
    controller.moveSprite(myPlayer, 0, 0)
    myMenu.onButtonPressed(controller.A, function (selection, index) {
        if (index == 0) {
            myMenu.close()
            genChunksInRadius()
        }
        if (index == 1) {
            myMenu.close()
            settings.remove("world")
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
let chunks: { [key: string]: number[][] } = {}
let chunksLoaded: number = 0
let indexTable: { [key: string]: { offset: number, length: number } } = {}

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
        let buf = chunkToBuffer(chunks[k])
        oldChunks[k] = compressBuffer(buf)
    }

    // Step 3: Build new buffer
    let keys = Object.keys(oldChunks)
    let all: number[] = []
    all.push(keys.length & 0xFF)
    all.push((keys.length >> 8) & 0xFF)
    all.push((keys.length >> 16) & 0xFF)

    // Reserve index space (5 bytes per entry)
    let indexSize = keys.length * 5
    for (let i = 0; i < indexSize; i++) all.push(0)

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
}

let chunkcount = 0

function loadWorld() {
    let buf = settings.readBuffer("world")
    if (!buf) return

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

}

function loadChunkFromWorld(x: number, y: number): number[][] {
    let entry = indexTable[`${x}:${y}`]
    if (!entry) return null

    // Read world buffer fresh (no global worldData)
    let buf = settings.readBuffer("world")
    if (!buf) return null

    // Slice compressed data using offset+length from indexTable
    let comp = buf.slice(entry.offset, entry.length)
    let decompressed = decompressBuffer(comp)
    return bufferToChunk(decompressed)
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

function generateChunk(): number[][] {
    let map: number[][] = []
    for (let i = 0; i < 8; i++) {
        let row: number[] = []
        for (let j = 0; j < 8; j++) {
            row.push(Math.percentChance(20) ? 1 : Math.percentChance(3) ? 2 : 0)
        }
        map.push(row)
    }
    return map
}


function getOrGenerateChunk(x: number, y: number): number[][] {
    if (chunks[`${x}:${y}`]) return chunks[`${x}:${y}`]

    let loaded = loadChunkFromWorld(x, y)
    if (loaded) {
        chunks[`${x}:${y}`] = loaded
        chunksLoaded++
        return loaded
    }

    let generated = generateChunk()
    chunks[`${x}:${y}`] = generated
    saveWorld()
    return generated
}

// --- Player + map reload ---
const chunkWidthPixels = 16 * 8
const chunkHeightPixels = 16 * 8

let myPlayer = sprites.create(assets.image`myPlayer`)
myPlayer.setFlag(SpriteFlag.StayInScreen, true)
controller.moveSprite(myPlayer, 100, 100)

function reloadMap() {
    let map = getOrGenerateChunk(chunkX, chunkY)
    for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
            let block = map[i][j]
            if (block == 0) {
                tiles.setTileAt(tiles.getTileLocation(i, j), assets.tile`Grass`)
            } else if (block == 1) {
                tiles.setTileAt(tiles.getTileLocation(i, j), assets.tile`dark-grass`)
            } else {
                tiles.setTileAt(tiles.getTileLocation(i, j), assets.tile`rocks`)
            }
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
    } else if (myPlayer.right > chunkWidthPixels - 5) {
        myPlayer.left = 10
        chunkX++
        reloadMap()
    } else if (myPlayer.top < 5) {
        myPlayer.bottom = chunkHeightPixels - 10
        chunkY--
        reloadMap()
    } else if (myPlayer.bottom > chunkHeightPixels - 10) {
        myPlayer.top = 10
        chunkY++
        reloadMap()
    }

    if (chunksLoaded > 5) {
        chunks = {}
        chunksLoaded = 0
    }
})

// --- HUD ---
game.onShade(function () {
    screen.fillRect(0, 0, 100, 10, 1)
    screen.print(`Position ${chunkX},${chunkY}`, 1, 1, 15)
})

console.log(`world is ${(settings.readBuffer("world").length) / 1024} kilobytes for ${chunkcount} chunks`)