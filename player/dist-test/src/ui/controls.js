const SPEEDS = [
    { label: "0.25×", ms: 1600 },
    { label: "0.5×", ms: 1000 },
    { label: "1×", ms: 600 },
    { label: "2×", ms: 300 },
    { label: "4×", ms: 150 },
];
export class Controls {
    constructor(host, loopsHost, player) {
        Object.defineProperty(this, "player", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "loopsHost", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "slider", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "playBtn", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "prevBtn", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "nextBtn", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "restartBtn", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "speedSel", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "stepLabel", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.player = player;
        this.loopsHost = loopsHost;
        host.replaceChildren();
        this.restartBtn = this.btn("⏮ Restart", "Restart from first step", () => player.restart());
        this.prevBtn = this.btn("◀ Step", "Step backward", () => player.prev());
        this.playBtn = this.btn("▶ Play", "Toggle autoplay", () => player.toggle());
        this.playBtn.classList.add("primary");
        this.nextBtn = this.btn("Step ▶", "Step forward", () => player.next());
        const sliderWrap = document.createElement("label");
        sliderWrap.className = "transport-label";
        sliderWrap.textContent = "Timeline";
        this.slider = document.createElement("input");
        this.slider.type = "range";
        this.slider.className = "slider";
        this.slider.min = "0";
        this.slider.max = "0";
        this.slider.value = "0";
        this.slider.addEventListener("input", () => {
            this.player.goto(Number(this.slider.value));
        });
        this.stepLabel = document.createElement("span");
        this.stepLabel.className = "transport-label";
        this.speedSel = document.createElement("select");
        this.speedSel.className = "speed-select";
        this.speedSel.title = "Playback speed";
        for (const s of SPEEDS) {
            const o = document.createElement("option");
            o.value = String(s.ms);
            o.textContent = s.label;
            if (s.ms === 600)
                o.selected = true;
            this.speedSel.append(o);
        }
        this.speedSel.addEventListener("change", () => {
            this.player.setSpeed(Number(this.speedSel.value));
        });
        host.append(this.restartBtn, this.prevBtn, this.playBtn, this.nextBtn, sliderWrap, this.slider, this.stepLabel, this.speedSel);
    }
    btn(label, title, onClick) {
        const b = document.createElement("button");
        b.className = "btn";
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", onClick);
        return b;
    }
    /** Reflect player state into the controls. */
    sync(state) {
        const max = Math.max(0, state.total - 1);
        this.slider.min = "0";
        this.slider.max = String(max);
        this.slider.value = String(Math.min(state.index, max));
        this.playBtn.textContent = state.playing ? "⏸ Pause" : "▶ Play";
        this.prevBtn.disabled = state.index <= 0;
        this.restartBtn.disabled = state.index <= 0;
        this.nextBtn.disabled = state.index >= max;
        this.stepLabel.textContent = `${state.index + 1} / ${state.total}`;
    }
    /** Render the active loop counters for a step. */
    renderLoops(loops) {
        this.loopsHost.replaceChildren();
        if (loops.length === 0) {
            const empty = document.createElement("div");
            empty.className = "loops-empty";
            empty.textContent = "(no active loops)";
            this.loopsHost.append(empty);
            return;
        }
        const frag = document.createDocumentFragment();
        for (const loop of loops) {
            const total = Math.max(1, loop.total);
            const pct = Math.max(0, Math.min(100, (loop.current / total) * 100));
            const row = document.createElement("div");
            row.className = "loop-row";
            const id = document.createElement("span");
            id.className = "loop-id";
            id.textContent = loop.id;
            const bar = document.createElement("div");
            bar.className = "loop-bar";
            const fill = document.createElement("div");
            fill.className = "loop-fill";
            fill.style.width = `${pct}%`;
            bar.append(fill);
            const txt = document.createElement("span");
            txt.className = "loop-text";
            txt.textContent = `${loop.current} / ${loop.total}`;
            row.append(id, bar, txt);
            frag.append(row);
        }
        this.loopsHost.append(frag);
    }
}
