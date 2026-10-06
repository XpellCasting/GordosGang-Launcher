const { resolveSrv } = require('dns/promises')
const net = require('net')

const STATUS_TIMEOUT_MS = 5000
// A status response with a 64x64 favicon is ~40 KB; anything far larger is
// not a Minecraft server.
const MAX_PACKET_BYTES = 2 * 1024 * 1024

function writeVarInt(value){
    const bytes = []
    do {
        let byte = value & 0x7F
        value >>>= 7
        if(value !== 0) byte |= 0x80
        bytes.push(byte)
    } while(value !== 0)
    return Buffer.from(bytes)
}

/**
 * Read a VarInt from `buffer` at `offset`.
 *
 * @returns {{ value: number, size: number } | null} null if the buffer ends
 * before the VarInt does.
 */
function readVarInt(buffer, offset){
    let value = 0
    for(let size = 0; size < 5; size++){
        if(offset + size >= buffer.length) return null
        const byte = buffer[offset + size]
        value |= (byte & 0x7F) << (7 * size)
        if((byte & 0x80) === 0) return { value, size: size + 1 }
    }
    throw new Error('VarInt is too big')
}

function packet(id, body){
    const data = Buffer.concat([writeVarInt(id), body])
    return Buffer.concat([writeVarInt(data.length), data])
}

async function resolveAddress(hostname, port){
    try {
        const [record] = await resolveSrv(`_minecraft._tcp.${hostname}`)
        if(record != null) return { hostname: record.name, port: record.port }
    } catch(_error) {
        // No SRV record, connect directly.
    }
    return { hostname, port }
}

/**
 * Query a server with the modern Server List Ping.
 *
 * Unlike helios-core's implementation this reads the whole packet however
 * many TCP chunks it spans, and decodes the JSON as UTF-8.
 *
 * @param {number} protocol The client's protocol version.
 * @param {string} hostname The server hostname.
 * @param {number} port The server port.
 * @returns {Promise.<Object>} The status JSON, with a string description
 * wrapped as `{ text }`.
 */
exports.getServerStatus = async function(protocol, hostname, port = 25565){
    const target = await resolveAddress(hostname, port)

    return await new Promise((resolve, reject) => {
        const socket = net.connect(target.port, target.hostname, () => {
            const host = Buffer.from(target.hostname, 'utf8')
            const portBytes = Buffer.alloc(2)
            portBytes.writeUInt16BE(target.port)
            socket.write(packet(0x00, Buffer.concat([
                writeVarInt(protocol), writeVarInt(host.length), host, portBytes, writeVarInt(1)
            ])))
            socket.write(packet(0x00, Buffer.alloc(0)))
        })

        const fail = (error) => {
            socket.destroy()
            reject(error)
        }

        socket.setTimeout(STATUS_TIMEOUT_MS, () => {
            fail(new Error(`Server status timed out (${target.hostname}:${target.port})`))
        })
        socket.on('error', fail)
        // A starting server may hang up without answering. Rejecting after
        // resolve() is a no-op, so this only fires on an incomplete response.
        socket.on('close', () => {
            reject(new Error(`Server closed the connection before sending its status (${target.hostname}:${target.port})`))
        })

        let received = Buffer.alloc(0)
        socket.on('data', (chunk) => {
            received = Buffer.concat([received, chunk])
            try {
                const length = readVarInt(received, 0)
                if(length == null) return
                if(length.value > MAX_PACKET_BYTES){
                    fail(new Error(`Server status packet too large (${length.value} bytes)`))
                    return
                }
                const end = length.size + length.value
                if(received.length < end) return

                const id = readVarInt(received, length.size)
                if(id.value !== 0x00){
                    fail(new Error(`Invalid response. Expected packet type 0, received ${id.value}!`))
                    return
                }
                const jsonLength = readVarInt(received, length.size + id.size)
                const start = length.size + id.size + jsonLength.size
                const status = JSON.parse(received.toString('utf8', start, start + jsonLength.value))
                if(typeof status.description === 'string'){
                    status.description = { text: status.description }
                }
                socket.end()
                resolve(status)
            } catch(error) {
                fail(error)
            }
        })
    })
}
