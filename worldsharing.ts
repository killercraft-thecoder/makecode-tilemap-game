namespace worldtransfer {

    // Packet types
    const PKT_START = 0x01;  // begin transfer
    const PKT_DATA = 0x02;  // data chunk
    const PKT_END = 0x03;  // end transfer
    const PKT_ACK = 0x04;  // acknowledges a data chunk

    // Sizes
    const MAX_PACKET = 227;          // hard cap before truncation
    const HEADER_SIZE = 7;           // type(1) + chunk#(2) + total(2) + len(2)
    const CHECKSUM_SIZE = 1;         // trailing XOR checksum
    const MAX_PAYLOAD = MAX_PACKET - HEADER_SIZE - CHECKSUM_SIZE; // 219 bytes

    // Reliability
    const SEND_DELAY_US = 4000; // small pacing delay between packets
    const ACK_TIMEOUT_MS = 80; // wait per-chunk for ACK before retry
    const MAX_RETRIES = 4;      // bounded retransmissions per chunk
    const REDUNDANT_SENDS = 2;  // fire each packet twice (helps on noisy radios)

    function makeDataPacket(chunkNo: number, total: number, payload: Buffer): Buffer {
        const len = payload.length;
        const pkt = Buffer.create(HEADER_SIZE + len + CHECKSUM_SIZE);

        // Header
        pkt.setNumber(NumberFormat.UInt8LE, 0, PKT_DATA);
        pkt.setNumber(NumberFormat.UInt16LE, 1, chunkNo);
        pkt.setNumber(NumberFormat.UInt16LE, 3, total);
        pkt.setNumber(NumberFormat.UInt16LE, 5, len);

        // Payload
        pkt.write(HEADER_SIZE, payload);

        // Checksum (XOR of header+payload)
        let sum = 0;
        for (let i = 0; i < HEADER_SIZE + len; i++) sum ^= pkt[i];
        pkt.setNumber(NumberFormat.UInt8LE, HEADER_SIZE + len, sum);

        return pkt;
    }

    function makeStartPacket(totalChunks: number, totalBytes: number): Buffer {
        const pkt = Buffer.create(HEADER_SIZE + CHECKSUM_SIZE);
        pkt.setNumber(NumberFormat.UInt8LE, 0, PKT_START);
        pkt.setNumber(NumberFormat.UInt16LE, 1, 0); // chunkNo=0 for START
        pkt.setNumber(NumberFormat.UInt16LE, 3, totalChunks);
        pkt.setNumber(NumberFormat.UInt16LE, 5, totalBytes & 0xFFFF); // lower 16 bits (simple hint)

        let sum = 0; for (let i = 0; i < HEADER_SIZE; i++) sum ^= pkt[i];
        pkt.setNumber(NumberFormat.UInt8LE, HEADER_SIZE, sum);
        return pkt;
    }

    function makeEndPacket(): Buffer {
        const pkt = Buffer.create(HEADER_SIZE + CHECKSUM_SIZE);
        pkt.setNumber(NumberFormat.UInt8LE, 0, PKT_END);
        pkt.setNumber(NumberFormat.UInt16LE, 1, 0);
        pkt.setNumber(NumberFormat.UInt16LE, 3, 0);
        pkt.setNumber(NumberFormat.UInt16LE, 5, 0);

        let sum = 0; for (let i = 0; i < HEADER_SIZE; i++) sum ^= pkt[i];
        pkt.setNumber(NumberFormat.UInt8LE, HEADER_SIZE, sum);
        return pkt;
    }

    function makeAckPacket(chunkNo: number): Buffer {
        const pkt = Buffer.create(HEADER_SIZE + CHECKSUM_SIZE);
        pkt.setNumber(NumberFormat.UInt8LE, 0, PKT_ACK);
        pkt.setNumber(NumberFormat.UInt16LE, 1, chunkNo);
        pkt.setNumber(NumberFormat.UInt16LE, 3, 0);
        pkt.setNumber(NumberFormat.UInt16LE, 5, 0);

        let sum = 0; for (let i = 0; i < HEADER_SIZE; i++) sum ^= pkt[i];
        pkt.setNumber(NumberFormat.UInt8LE, HEADER_SIZE, sum);
        return pkt;
    }

    function verifyChecksum(pkt: Buffer): boolean {
        const total = pkt.length;
        if (total < HEADER_SIZE + CHECKSUM_SIZE) return false;
        const last = total - 1;
        let sum = 0; for (let i = 0; i < last; i++) sum ^= pkt[i];
        return (sum & 0xFF) === pkt[last];
    }

    function isPacketType(pkt: Buffer, type: number): boolean {
        return pkt.length >= HEADER_SIZE + CHECKSUM_SIZE && pkt.getNumber(NumberFormat.UInt8LE, 0) === type;
    }

    // Break into MAX_PAYLOAD-sized chunks
    function chunkBuffer(buf: Buffer): Buffer[] {
        const chunks: Buffer[] = [];
        for (let i = 0; i < buf.length; i += MAX_PAYLOAD) {
            const end = Math.min(i + MAX_PAYLOAD, buf.length);
            chunks.push(buf.slice(i, end));
        }
        return chunks;
    }

    // Start connection: send handshake
    export function startConnection(ipTarget: string): boolean {
        NetWorking.SendDataTo(ipTarget, makeStartPacket(0, 0)); // you already have makeStartPacket
        return true;
    }

    // Wait for ACK for a specific chunk
    export function waitForAck(ip: string, chunkNo: number): boolean {
        let start = control.millis();
        let acked = false;

        while (control.millis() - start < ACK_TIMEOUT_MS) {
            const data = NetWorking.WaitForData(ip);
            let end = false
            data.then(function (data) {
                if (data) {
                    const pkt = Buffer.fromUTF8(data as string);
                    if (verifyChecksum(pkt) && pkt.getNumber(NumberFormat.UInt8LE, 0) === PKT_ACK) {
                        const ackNo = pkt.getNumber(NumberFormat.UInt16LE, 1);
                        if (ackNo === chunkNo) {
                            acked = true;
                            end = true;
                        }
                    }
                }
            })
            if (end) {
                break
            }
            control.waitMicros(2000);
        }
        return acked;
    }

    // Send a packet multiple times for redundancy
    export function sendWithRedundancy(ip: string, pkt: Buffer): void {
        for (let i = 0; i < REDUNDANT_SENDS; i++) {
            NetWorking.SendDataTo(ip, pkt);
            control.waitMicros(SEND_DELAY_US);
        }
    }

    // Transfer data: chunk buffer, send each with redundancy, wait for ACK, retry if needed
    export function transferData(ipTarget: string, buf: Buffer): void {
        const chunks: Buffer[] = [];
        for (let i = 0; i < buf.length; i += MAX_PAYLOAD) {
            chunks.push(buf.slice(i, Math.min(i + MAX_PAYLOAD, buf.length)));
        }
        const total = chunks.length;

        // Inform receiver of total
        sendWithRedundancy(ipTarget, makeStartPacket(total, buf.length));

        for (let i = 0; i < total; i++) {
            const pkt = makeDataPacket(i, total, chunks[i]);
            let attempts = 0;
            let acked = false;

            while (attempts < MAX_RETRIES && !acked) {
                attempts++;
                sendWithRedundancy(ipTarget, pkt);
                acked = waitForAck(ipTarget, i);
                if (!acked) control.waitMicros(8000); // backoff
            }
            // If not acked after retries, continue anyway
        }
    }

    // End connection: send closing signal
    export function endConnection(ipTarget: string): void {
        sendWithRedundancy(ipTarget, makeEndPacket());
    }

    // Full send world flow
    export function sendWorld(ipTarget: string, world: Buffer): void {
        if (!startConnection(ipTarget)) return;
        transferData(ipTarget, world);
        endConnection(ipTarget);
    }

    // Session state per IP
    class RxSession {
        totalChunks: number;
        received: boolean[];
        payloads: Buffer[];
        done: boolean;

        constructor() {
            this.totalChunks = -1;
            this.received = [];
            this.payloads = [];
            this.done = false;
        }

        reset(total: number) {
            this.totalChunks = total;
            this.received = Array.repeat(0,total);
            this.payloads = Array.repeat(0,total);
            this.done = false;
        }
    }

    const sessions: { [ip: string]: RxSession } = {};

    // Initialize receiver
    export function initReceiver(fromIp: string, onComplete: (ip: string, data: Buffer) => void): void {
        NetWorking.WaitForData(fromIp).then((data: any) => {
            const pkt = data as Buffer;
            if (!pkt || pkt.length < HEADER_SIZE + CHECKSUM_SIZE) return;
            if (!verifyChecksum(pkt)) return;

            const type = pkt.getNumber(NumberFormat.UInt8LE, 0);
            const ip = fromIp;
            if (!sessions[ip]) sessions[ip] = new RxSession();
            const sess = sessions[ip];

            if (type === PKT_START) {
                const total = pkt.getNumber(NumberFormat.UInt16LE, 3);
                sess.reset(total);
                return;
            }

            if (type === PKT_DATA) {
                const chunkNo = pkt.getNumber(NumberFormat.UInt16LE, 1);
                const total = pkt.getNumber(NumberFormat.UInt16LE, 3);
                const len = pkt.getNumber(NumberFormat.UInt16LE, 5);

                if (sess.totalChunks < 0) sess.reset(total);
                if (chunkNo >= total) return;

                // Dedup
                if (sess.received[chunkNo]) {
                    NetWorking.SendDataTo(ip, makeAckPacket(chunkNo));
                    return;
                }

                const payload = pkt.slice(HEADER_SIZE, HEADER_SIZE + len);
                sess.payloads[chunkNo] = payload;
                sess.received[chunkNo] = true;

                // ACK back
                NetWorking.SendDataTo(ip, makeAckPacket(chunkNo));

                // Check completion
                let complete = true;
                for (let i = 0; i < sess.totalChunks; i++) {
                    if (!sess.received[i]) { complete = false; break; }
                }
                if (complete && !sess.done) {
                    sess.done = true;
                    let totalLen = 0;
                    for (let i = 0; i < sess.totalChunks; i++) totalLen += sess.payloads[i].length;
                    const result = Buffer.create(totalLen);
                    let offset = 0;
                    for (let i = 0; i < sess.totalChunks; i++) {
                        result.write(offset, sess.payloads[i]);
                        offset += sess.payloads[i].length;
                    }
                    onComplete(ip, result);
                }
            }

            if (type === PKT_END) {
                // Optional: mark closed
                return;
            }
        });
    }


}