namespace worldtransfer {

    // Packet types
    const PKT_START = 0x01;
    const PKT_DATA = 0x02;
    const PKT_END = 0x03;
    const PKT_ACK = 0x04;

    // Sizes
    const MAX_PACKET = 227;
    const HEADER_SIZE = 7;
    const CHECKSUM_SIZE = 1;
    const MAX_PAYLOAD = MAX_PACKET - HEADER_SIZE - CHECKSUM_SIZE;

    // Reliability
    const SEND_DELAY_US = 4000;
    const ACK_TIMEOUT_MS = 300;   // increased for radio stability
    const MAX_RETRIES = 4;
    const REDUNDANT_SENDS = 2;

    // -------------------------------------------------------------
    // Utility: Base64-safe send
    // -------------------------------------------------------------
    function sendPacket(ip: string, pkt: Buffer) {
        NetWorking.SendDataTo(ip, pkt.toBase64());
    }

    // -------------------------------------------------------------
    // Packet builders
    // -------------------------------------------------------------
    function makeDataPacket(chunkNo: number, total: number, payload: Buffer): Buffer {
        const len = payload.length;
        const pkt = Buffer.create(HEADER_SIZE + len + CHECKSUM_SIZE);

        pkt.setNumber(NumberFormat.UInt8LE, 0, PKT_DATA);
        pkt.setNumber(NumberFormat.UInt16LE, 1, chunkNo);
        pkt.setNumber(NumberFormat.UInt16LE, 3, total);
        pkt.setNumber(NumberFormat.UInt16LE, 5, len);

        pkt.write(HEADER_SIZE, payload);

        let sum = 0;
        for (let i = 0; i < HEADER_SIZE + len; i++) sum ^= pkt[i];
        pkt.setNumber(NumberFormat.UInt8LE, HEADER_SIZE + len, sum);

        return pkt;
    }

    function makeStartPacket(totalChunks: number, totalBytes: number): Buffer {
        const pkt = Buffer.create(HEADER_SIZE + CHECKSUM_SIZE);
        pkt.setNumber(NumberFormat.UInt8LE, 0, PKT_START);
        pkt.setNumber(NumberFormat.UInt16LE, 1, 0);
        pkt.setNumber(NumberFormat.UInt16LE, 3, totalChunks);
        pkt.setNumber(NumberFormat.UInt16LE, 5, totalBytes & 0xFFFF);

        let sum = 0;
        for (let i = 0; i < HEADER_SIZE; i++) sum ^= pkt[i];
        pkt.setNumber(NumberFormat.UInt8LE, HEADER_SIZE, sum);

        return pkt;
    }

    function makeEndPacket(): Buffer {
        const pkt = Buffer.create(HEADER_SIZE + CHECKSUM_SIZE);
        pkt.setNumber(NumberFormat.UInt8LE, 0, PKT_END);
        pkt.setNumber(NumberFormat.UInt16LE, 1, 0);
        pkt.setNumber(NumberFormat.UInt16LE, 3, 0);
        pkt.setNumber(NumberFormat.UInt16LE, 5, 0);

        let sum = 0;
        for (let i = 0; i < HEADER_SIZE; i++) sum ^= pkt[i];
        pkt.setNumber(NumberFormat.UInt8LE, HEADER_SIZE, sum);

        return pkt;
    }

    function makeAckPacket(chunkNo: number): Buffer {
        const pkt = Buffer.create(HEADER_SIZE + CHECKSUM_SIZE);
        pkt.setNumber(NumberFormat.UInt8LE, 0, PKT_ACK);
        pkt.setNumber(NumberFormat.UInt16LE, 1, chunkNo);
        pkt.setNumber(NumberFormat.UInt16LE, 3, 0);
        pkt.setNumber(NumberFormat.UInt16LE, 5, 0);

        let sum = 0;
        for (let i = 0; i < HEADER_SIZE; i++) sum ^= pkt[i];
        pkt.setNumber(NumberFormat.UInt8LE, HEADER_SIZE, sum);

        return pkt;
    }

    // -------------------------------------------------------------
    // Checksum
    // -------------------------------------------------------------
    function verifyChecksum(pkt: Buffer): boolean {
        const last = pkt.length - 1;
        let sum = 0;
        for (let i = 0; i < last; i++) sum ^= pkt[i];
        return (sum & 0xFF) === pkt[last];
    }

    // -------------------------------------------------------------
    // Sending logic
    // -------------------------------------------------------------
    function sendWithRedundancy(ip: string, pkt: Buffer) {
        for (let i = 0; i < REDUNDANT_SENDS; i++) {
            sendPacket(ip, pkt);
            control.waitMicros(SEND_DELAY_US);
        }
    }

    export function startConnection(ip: string): boolean {
        sendWithRedundancy(ip, makeStartPacket(0, 0));
        return true;
    }

    export function waitForAck(ip: string, chunkNo: number): boolean {
        const start = control.millis();
        let acked = false;

        while (control.millis() - start < ACK_TIMEOUT_MS) {
            const p = NetWorking.WaitForData(ip);

            p.then((str: string) => {
                try {
                    const pkt = Buffer.fromBase64(str);
                    if (!verifyChecksum(pkt)) return;

                    if (pkt.getNumber(NumberFormat.UInt8LE, 0) === PKT_ACK) {
                        if (pkt.getNumber(NumberFormat.UInt16LE, 1) === chunkNo) {
                            acked = true;
                        }
                    }
                } catch { }
            });

            if (acked) break;
            control.waitMicros(2000);
        }

        return acked;
    }

    export function transferData(ip: string, buf: Buffer) {
        const chunks: Buffer[] = [];
        for (let i = 0; i < buf.length; i += MAX_PAYLOAD)
            chunks.push(buf.slice(i, Math.min(i + MAX_PAYLOAD, buf.length)));

        const total = chunks.length;

        sendWithRedundancy(ip, makeStartPacket(total, buf.length));

        for (let i = 0; i < total; i++) {
            const pkt = makeDataPacket(i, total, chunks[i]);
            let attempts = 0;
            let acked = false;

            while (attempts < MAX_RETRIES && !acked) {
                attempts++;
                sendWithRedundancy(ip, pkt);
                acked = waitForAck(ip, i);
                if (!acked) control.waitMicros(8000);
            }
        }
    }

    export function endConnection(ip: string) {
        sendWithRedundancy(ip, makeEndPacket());
    }

    export function sendWorld(ip: string, world: Buffer) {
        if (!startConnection(ip)) return;
        transferData(ip, world);
        endConnection(ip);
    }

    // -------------------------------------------------------------
    // Receiving logic
    // -------------------------------------------------------------
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
            this.received = Array.repeat(false, total);
            this.payloads = Array.repeat(Buffer.create(0),total)
            this.done = false;
        }
    }

    const sessions: { [ip: string]: RxSession } = {};

    // -------------------------------------------------------------
    // Persistent receiver
    // -------------------------------------------------------------
    export function initReceiver(ip: string, onComplete: (ip: string, data: Buffer) => void) {

        function listen() {
            NetWorking.WaitForData(ip).then((str: string) => {
                if (str) processPacket(ip, str, onComplete);
                listen(); // keep listening forever
            });
        }

        listen();
    }

    function processPacket(ip: string, str: string, onComplete: (ip: string, data: Buffer) => void) {
        let pkt: Buffer;

        try {
            pkt = Buffer.fromBase64(str);
        } catch {
            return;
        }

        if (!verifyChecksum(pkt)) return;

        const type = pkt.getNumber(NumberFormat.UInt8LE, 0);

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

            if (sess.received[chunkNo]) {
                sendPacket(ip, makeAckPacket(chunkNo));
                return;
            }

            const payload = pkt.slice(HEADER_SIZE, HEADER_SIZE + len);
            sess.payloads[chunkNo] = payload;
            sess.received[chunkNo] = true;

            sendPacket(ip, makeAckPacket(chunkNo));

            let complete = true;
            for (let i = 0; i < sess.totalChunks; i++)
                if (!sess.received[i]) complete = false;

            if (complete && !sess.done) {
                sess.done = true;

                let totalLen = 0;
                for (let i = 0; i < sess.totalChunks; i++)
                    totalLen += sess.payloads[i].length;

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
            return;
        }
    }
}