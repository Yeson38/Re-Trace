export class Terminal {
    constructor(host) {
        Object.defineProperty(this, "host", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.host = host;
    }
    render(steps, upToIndex) {
        let text = "";
        const end = Math.min(upToIndex, steps.length - 1);
        for (let i = 0; i <= end; i++)
            text += steps[i]?.output ?? "";
        // textContent avoids reflow churn and is XSS-safe for recorded output.
        this.host.textContent = text.replace(/\n$/, "");
    }
}
