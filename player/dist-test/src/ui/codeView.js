export class CodeView {
    constructor(host, file) {
        Object.defineProperty(this, "host", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "lineEls", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "currentLine", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: -1
        });
        this.host = host;
        this.render(file);
    }
    render(file) {
        this.host.replaceChildren();
        this.lineEls.length = 0;
        const frag = document.createDocumentFragment();
        file.source.lines.forEach((text, i) => {
            const row = document.createElement("div");
            row.className = "code-line";
            row.dataset.line = String(i + 1);
            const ln = document.createElement("span");
            ln.className = "ln";
            ln.textContent = String(i + 1);
            const code = document.createElement("span");
            code.className = "code-text";
            code.textContent = text || " ";
            row.append(ln, code);
            frag.append(row);
            this.lineEls.push(row);
        });
        this.host.append(frag);
    }
    /** Highlight the given 1-based line and scroll it into view. */
    highlight(line) {
        if (line === this.currentLine)
            return;
        this.lineEls.forEach((el) => el.classList.remove("current"));
        this.currentLine = line;
        if (line < 1 || line > this.lineEls.length)
            return;
        const el = this.lineEls[line - 1];
        el.classList.add("current");
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
}
