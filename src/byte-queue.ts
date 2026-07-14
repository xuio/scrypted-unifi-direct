/**
 * FIFO byte accumulator backed by one reusable buffer. A consumer that must hold
 * a whole record (up to a ~500 KB keyframe) until the next one is confirmed, fed
 * from a `Buffer.concat([buf, chunk])` accumulator, re-copies everything pending
 * on every socket read — O(record² / chunk) per keyframe, continuously, even with
 * no viewers. Here appends land at the write offset and the front is consumed by
 * moving a read offset; data moves only when the buffer wraps (compact) or grows.
 * view() returns a window into the shared store — it is only valid until the next
 * push(), so consumers must copy anything they keep.
 *
 * Used by both the extendedFlv detrailer and the standard-FLV tag parser.
 */
export class ByteQueue {
    private store: Buffer;
    private head = 0;
    private tail = 0;

    constructor(private readonly initialCapacity = 1 << 20) {
        if (!Number.isSafeInteger(initialCapacity) || initialCapacity < 64)
            throw new Error('ByteQueue initialCapacity must be an integer >= 64');
        this.store = Buffer.allocUnsafe(initialCapacity);
    }

    get length() { return this.tail - this.head; }

    push(chunk: Buffer) {
        if (this.tail + chunk.length > this.store.length) {
            const len = this.length;
            if (len + chunk.length > this.store.length) {
                let size = this.store.length * 2;
                while (size < len + chunk.length) size *= 2;
                const ns = Buffer.allocUnsafe(size);
                this.store.copy(ns, 0, this.head, this.tail);
                this.store = ns;
            } else {
                this.store.copy(this.store, 0, this.head, this.tail);   // compact in place
            }
            this.head = 0;
            this.tail = len;
        }
        chunk.copy(this.store, this.tail);
        this.tail += chunk.length;
    }

    /** Window over the buffered bytes; valid only until the next push(). */
    view(): Buffer { return this.store.subarray(this.head, this.tail); }

    consume(n: number) {
        this.head = Math.min(this.head + n, this.tail);
        if (this.head === this.tail) {
            this.head = this.tail = 0;
            // shed an oversized store once drained, so one giant record can't pin
            // memory for the stream's lifetime.
            if (this.store.length > this.initialCapacity * 4)
                this.store = Buffer.allocUnsafe(this.initialCapacity);
        }
    }
}
