const DEFAULT_SPEED_MS = 600;
const MIN_SPEED_MS = 80;
export class Player {
    constructor() {
        Object.defineProperty(this, "file", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "index", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: -1
        });
        Object.defineProperty(this, "playing", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "speedMs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: DEFAULT_SPEED_MS
        });
        Object.defineProperty(this, "timer", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "listeners", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Set()
        });
        Object.defineProperty(this, "tick", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => {
                if (!this.playing || !this.file)
                    return;
                if (this.index >= this.total - 1) {
                    this.pause();
                    return;
                }
                this.index += 1;
                this.emit();
                if (this.index >= this.total - 1) {
                    this.pause();
                    return;
                }
                this.scheduleTick();
            }
        });
    }
    /** Load a trace file and reset the cursor to the first step. */
    load(file) {
        this.pause();
        this.file = file;
        this.index = file.steps.length > 0 ? 0 : -1;
        this.emit();
    }
    get total() {
        return this.file ? this.file.steps.length : 0;
    }
    getState() {
        return {
            index: this.index,
            total: this.total,
            playing: this.playing,
            speedMs: this.speedMs,
        };
    }
    /** Subscribe to state changes. Returns an unsubscribe function. */
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    /** The step under the cursor, or null. */
    currentStep() {
        if (!this.file || this.index < 0)
            return null;
        return this.file.steps[this.index] ?? null;
    }
    /** Jump to an absolute step index (clamped). */
    goto(target) {
        if (!this.file || this.total === 0)
            return;
        const clamped = Math.max(0, Math.min(this.total - 1, Math.trunc(target)));
        if (clamped === this.index)
            return;
        this.index = clamped;
        // Reaching the end via manual jump pauses autoplay.
        if (this.index >= this.total - 1)
            this.pause();
        this.emit();
    }
    next() {
        this.goto(this.index + 1);
    }
    prev() {
        this.goto(this.index - 1);
    }
    restart() {
        this.pause();
        this.goto(0);
    }
    play() {
        if (!this.file || this.total === 0)
            return;
        if (this.index >= this.total - 1)
            this.index = 0;
        this.playing = true;
        this.emit();
        this.scheduleTick();
    }
    pause() {
        if (!this.playing && this.timer === null)
            return;
        this.playing = false;
        this.clearTimer();
        this.emit();
    }
    toggle() {
        if (this.playing)
            this.pause();
        else
            this.play();
    }
    /** Set step delay in ms (clamped to a sane floor). */
    setSpeed(ms) {
        this.speedMs = Math.max(MIN_SPEED_MS, Math.trunc(ms));
        if (this.playing) {
            this.clearTimer();
            this.scheduleTick();
        }
        this.emit();
    }
    scheduleTick() {
        this.clearTimer();
        this.timer = setTimeout(this.tick, this.speedMs);
    }
    clearTimer() {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    emit() {
        const state = this.getState();
        for (const fn of this.listeners)
            fn(state);
    }
}
