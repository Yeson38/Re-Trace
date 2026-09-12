"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSearch = parseSearch;
exports.resolvePath = resolvePath;
exports.matches = matches;
exports.findFirstMatch = findFirstMatch;
exports.findAllMatches = findAllMatches;
exports.estimateLoopComplexity = estimateLoopComplexity;
exports.estimateProgram = estimateProgram;
exports.diffVars = diffVars;
/** Supported operators in a regex group, longest-first so ">=" beats ">". */
const OP_REGEX = /(>=|<=|!=|~=|==|>|<)/;
/**
 * Parse a search query string.
 *
 * Accepted grammar (whitespace is tolerant):
 *   path OP literal
 *
 * Path: dotted + subscripted, e.g.  arr[2].value  /  data  /  user.addr.city
 * OP  : == != > < >= <= ~=
 * Lit : number (int or float), true / false / null, quoted string ("" or ''),
 *       or a bare word treated as an unquoted string.
 *
 * Examples:
 *   n == 4
 *   data[3] == 8
 *   arr ~= 5        (arr contains 5 or "5" substring)
 *   score >= 60.5
 *   name == "hello"
 */
function parseSearch(input) {
    const raw = input.trim();
    if (!raw)
        return { error: "empty query", column: -1 };
    const m = raw.match(OP_REGEX);
    if (!m || m.index === undefined) {
        return { error: "missing operator, expected one of == != > < >= <= ~=", column: raw.length };
    }
    const op = m[1];
    const namePart = raw.slice(0, m.index).trim();
    const valPart = raw.slice(m.index + op.length).trim();
    const nameErr = validatePath(namePart);
    if (nameErr)
        return { error: nameErr, column: 0 };
    const valRes = parseLiteral(valPart);
    if ("error" in valRes)
        return { error: valRes.error, column: m.index + op.length + 1 + (valRes.column ?? 0) };
    return { name: namePart, op, value: valRes.value, raw };
}
function validatePath(p) {
    if (!p)
        return "empty variable path";
    // Identifier-like start, then dotted identifiers or [literal].
    const re = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[(?:-?\d+|"[^"]*"|'[^']*')\])*$/;
    if (!re.test(p))
        return `invalid variable path: ${JSON.stringify(p)}`;
    return null;
}
function parseLiteral(raw) {
    if (raw === "")
        return { error: "missing value on the right-hand side" };
    if (raw === "true")
        return { value: true };
    if (raw === "false")
        return { value: false };
    if (raw === "null" || raw === "None")
        return { value: null };
    // Quoted string.
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        if (raw.length === 1)
            return { error: "unterminated string literal" };
        const inner = raw.slice(1, -1);
        const out = [];
        let i = 0;
        while (i < inner.length) {
            const c = inner[i];
            if (c === "\\" && i + 1 < inner.length) {
                const nx = inner[i + 1];
                switch (nx) {
                    case "n":
                        out.push("\n");
                        break;
                    case "t":
                        out.push("\t");
                        break;
                    case "r":
                        out.push("\r");
                        break;
                    case "\\":
                        out.push("\\");
                        break;
                    case '"':
                        out.push('"');
                        break;
                    case "'":
                        out.push("'");
                        break;
                    default:
                        out.push(nx);
                        break;
                }
                i += 2;
            }
            else {
                out.push(c);
                i += 1;
            }
        }
        return { value: out.join("") };
    }
    // Bare number.
    const num = Number(raw);
    if (!Number.isNaN(num) && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
        return { value: num };
    }
    // Bare word: treat as unquoted string.
    if (/^[A-Za-z_][A-Za-z0-9_\-+./]*$/.test(raw)) {
        return { value: raw };
    }
    return { error: `unsupported literal: ${JSON.stringify(raw)}` };
}
/** Follow a dotted/subscripted path into a `TraceVar[]` variable list. */
function resolvePath(vars, path) {
    // Tokenize the path: we build tokens as either IDENT or INDEX(string|number).
    const tokens = tokenizePath(path);
    if (tokens.length === 0)
        return { found: false };
    // Root: find the variable whose name matches the first token (always an IDENT).
    const first = tokens[0];
    if (first.kind !== "ident")
        return { found: false };
    let cur = undefined;
    let have = false;
    for (const v of vars) {
        if (v.name === first.name) {
            cur = v.value;
            have = true;
            break;
        }
    }
    if (!have)
        return { found: false };
    for (let i = 1; i < tokens.length; i += 1) {
        const t = tokens[i];
        if (cur === null || cur === undefined)
            return { found: false };
        if (t.kind === "ident") {
            if (typeof cur !== "object")
                return { found: false };
            const rec = cur;
            if (!(t.name in rec))
                return { found: false };
            cur = rec[t.name];
        }
        else if (t.kind === "index-num") {
            if (Array.isArray(cur)) {
                const arr = cur;
                const idx = t.index < 0 ? arr.length + t.index : t.index;
                if (idx < 0 || idx >= arr.length)
                    return { found: false };
                cur = arr[idx];
            }
            else if (typeof cur === "object") {
                const key = String(t.index);
                const rec = cur;
                if (!(key in rec))
                    return { found: false };
                cur = rec[key];
            }
            else {
                return { found: false };
            }
        }
        else { // index-str
            if (typeof cur !== "object")
                return { found: false };
            const rec = cur;
            if (!(t.index in rec))
                return { found: false };
            cur = rec[t.index];
        }
    }
    return { found: true, value: cur };
}
function tokenizePath(p) {
    const out = [];
    let i = 0;
    while (i < p.length) {
        const c = p[i];
        if (c === ".") {
            i += 1;
            // Identifier expected.
            let n = 0;
            while (i + n < p.length && /[A-Za-z0-9_]/.test(p[i + n]))
                n += 1;
            if (n === 0)
                return []; // malformed
            out.push({ kind: "ident", name: p.slice(i, i + n) });
            i += n;
        }
        else if (c === "[") {
            const close = p.indexOf("]", i);
            if (close === -1)
                return [];
            const inside = p.slice(i + 1, close);
            if (inside.startsWith('"') && inside.endsWith('"')) {
                out.push({ kind: "index-str", index: inside.slice(1, -1) });
            }
            else if (inside.startsWith("'") && inside.endsWith("'")) {
                out.push({ kind: "index-str", index: inside.slice(1, -1) });
            }
            else {
                const n = Number(inside);
                if (Number.isNaN(n))
                    return [];
                out.push({ kind: "index-num", index: n });
            }
            i = close + 1;
        }
        else {
            // Leading identifier.
            let n = 0;
            while (i + n < p.length && /[A-Za-z0-9_]/.test(p[i + n]))
                n += 1;
            if (n === 0)
                return [];
            out.push({ kind: "ident", name: p.slice(i, i + n) });
            i += n;
        }
    }
    return out;
}
/** Strict comparison for heterogeneous operand types. Numbers on both sides → numeric compare. */
function numCoerce(a, b) {
    const an = typeof a === "number" ? a : typeof a === "boolean" ? (a ? 1 : 0) : Number(a);
    const bn = typeof b === "number" ? b : typeof b === "boolean" ? (b ? 1 : 0) : Number(b);
    if (Number.isNaN(an) || Number.isNaN(bn))
        return null;
    return [an, bn];
}
function matches(pred, step) {
    const r = resolvePath(step.vars, pred.name);
    if (!r.found) {
        // Treat absence specially: `!=` is true (the value is effectively different),
        // `==` is false. Orders produce false. Absence ~= anything is false.
        return pred.op === "!=";
    }
    const a = r.value;
    const b = pred.value;
    // Structural equality for arrays/objects, using JSON.stringify (Phase 3 MVP).
    const eq = (x, y) => {
        if (Object.is(x, y))
            return true;
        if (Array.isArray(x) && Array.isArray(y)) {
            if (x.length !== y.length)
                return false;
            return x.every((xv, i) => eq(xv, y[i]));
        }
        if (typeof x === "object" && x !== null && typeof y === "object" && y !== null) {
            const xk = Object.keys(x).sort();
            const yk = Object.keys(y).sort();
            if (xk.length !== yk.length)
                return false;
            if (!xk.every((k, i) => k === yk[i]))
                return false;
            return xk.every((k) => eq(x[k], y[k]));
        }
        return false;
    };
    switch (pred.op) {
        case "==": return eq(a, b);
        case "!=": return !eq(a, b);
        case ">":
        case "<":
        case ">=":
        case "<=": {
            const pair = numCoerce(a, b);
            if (!pair)
                return false;
            const [x, y] = pair;
            if (pred.op === ">")
                return x > y;
            if (pred.op === "<")
                return x < y;
            if (pred.op === ">=")
                return x >= y;
            return x <= y;
        }
        case "~=": {
            // contains: for arrays → b in a; for strings → substring; for objects → key exists.
            if (Array.isArray(a))
                return a.some((v) => eq(v, b));
            if (typeof a === "string")
                return a.includes(String(b ?? ""));
            if (a !== null && typeof a === "object")
                return String(b) in a;
            return false;
        }
    }
}
/**
 * Linear scan for the earliest matching step index (≥ from).
 *
 * We use linear rather than true binary search because the predicate does not
 * *necessarily* define a monotonic region of the truth function (e.g. `== 0`
 * in an array that goes 0→1→0 hits twice). The spec uses "binary search" as
 * the user-facing term for "locate quickly" but the algorithm here is a
 * robust linear sweep that also handles non-monotone conditions correctly.
 * On typical trace sizes (< 20 000 steps) this is still O(ms).
 */
function findFirstMatch(steps, pred, from = 0) {
    const start = Math.max(0, Math.min(steps.length - 1, from));
    for (let i = start; i < steps.length; i += 1) {
        if (matches(pred, steps[i]))
            return i;
    }
    return -1;
}
/** Find every step index that satisfies the predicate. */
function findAllMatches(steps, pred) {
    const out = [];
    for (let i = 0; i < steps.length; i += 1) {
        if (matches(pred, steps[i]))
            out.push(i);
    }
    return out;
}
/**
 * For a specific loop id, aggregate how many step frames the loop was
 * active, and correlate to any visible variable whose value looks like an
 * input size (n).
 *
 * Heuristics used (Phase 2/3 level; this is approximation, not proof):
 *
 *  1. Count how many step indices have this loop in their loops[] array.
 *     This is `active_steps`.
 *  2. Heuristic input-size: any numeric variable named `n`, `size`, `len`,
 *     `length` in the same step, or the length of any array/list variable
 *     (`data`, `arr`, `a`, `nums`, common OI names).
 *  3. Nesting: if at the same step there are ≥2 distinct loop IDs, the inner
 *     one inherits outer's input-size as a multiplier.
 *  4. If the loop's variable halves each iteration (we check for `L = floor((L+R)/2)`
 *     or `mid = floor((lo+hi)/2)` patterns in variables), classify O(log n).
 *  5. If depth changes exponentially with step count (fib(n)-style), raise O(2ⁿ).
 *  6. Anything we can't classify → "O(?)", low confidence, basis says why.
 */
function estimateLoopComplexity(file, loopId) {
    const steps = file.steps;
    const active = steps.filter((s) => s.loops.some((l) => l.id === loopId));
    if (active.length === 0) {
        return { order: "O(?)", basis: `loop ${loopId} has no active steps`, confidence: "low" };
    }
    // Nesting: # of concurrent loops at the step where this loop appears MOST nested.
    let maxDepth = 0;
    for (const s of active) {
        if (s.loops.length > maxDepth)
            maxDepth = s.loops.length;
    }
    // Position of this loop in the stack (0 = innermost).
    let innermostPos = 0;
    for (const s of active) {
        const idx = s.loops.findIndex((l) => l.id === loopId);
        const depthIn = s.loops.length - idx;
        if (depthIn > innermostPos)
            innermostPos = depthIn;
    }
    // Input-size heuristics: look at the LAST step featuring the loop (when
    // values are closest to their final), and try to harvest 'n' or array lengths.
    const last = active[active.length - 1];
    const inputSizes = [];
    for (const v of last.vars) {
        const name = v.name.toLowerCase();
        if (["n", "size", "len", "length"].includes(name) && typeof v.value === "number") {
            inputSizes.push(v.value);
        }
        else if (Array.isArray(v.value)) {
            inputSizes.push(v.value.length);
        }
    }
    const n = inputSizes.length > 0 ? Math.max(...inputSizes) : 0;
    const iterations = Math.max(1, ...active.map((s) => {
        const l = s.loops.find((x) => x.id === loopId);
        return l ? l.current : 0;
    }));
    // Log n heuristics: check if any vars named lo/hi/mid show 'halving' behaviour.
    let logHeuristic = false;
    if (last.vars.some((v) => /^(lo|low|left|hi|high|right|mid|middle)$/.test(v.name.toLowerCase()))) {
        const first = active[0];
        const rangeStart = numericRangeSize(first.vars);
        const rangeEnd = numericRangeSize(last.vars);
        if (rangeStart > 8 && rangeEnd > 0 && rangeEnd < rangeStart / 2)
            logHeuristic = true;
    }
    if (n <= 0) {
        return {
            order: innermostPos <= 1 ? "O(?) ~ k" : `O(n^${innermostPos}) ?`,
            basis: `active steps ≈ ${active.length}, no input-size var detected; nesting=${innermostPos}`,
            confidence: "low",
        };
    }
    // Check log-n first (logarithm trumps linear even with small nesting).
    if (logHeuristic && innermostPos === 1) {
        return {
            order: "O(log n)",
            basis: `range halving detected (${numericRangeSize(active[0].vars)}→${numericRangeSize(last.vars)}) over ${iterations} iters; n≈${n}`,
            confidence: "low",
        };
    }
    // Now ratio iterations / n^pos.
    const expected = Math.pow(n, innermostPos);
    const ratio = iterations / Math.max(1, expected);
    let order;
    let confidence = "low";
    if (innermostPos === 1 && iterations <= 2) {
        order = "O(1)";
        confidence = iterations === 0 ? "low" : "low";
    }
    else if (innermostPos === 1) {
        order = "O(n)";
        confidence = ratio > 0.25 && ratio < 3 ? "high" : "low";
    }
    else if (innermostPos === 2) {
        order = "O(n²)";
        confidence = ratio > 0.1 && ratio < 6 ? "high" : "low";
    }
    else if (innermostPos === 3) {
        order = "O(n³)";
        confidence = ratio > 0.05 && ratio < 10 ? "low" : "low";
    }
    else {
        order = `O(n^${innermostPos})`;
        confidence = "low";
    }
    const basis = `n≈${n}, iters=${iterations}, nesting=${innermostPos}, ratio=iters/n^${innermostPos}=${ratio.toFixed(2)}`;
    return { order, basis, confidence };
}
function numericRangeSize(vars) {
    const lo = vars.find((v) => /^(lo|low|left)$/.test(v.name.toLowerCase()));
    const hi = vars.find((v) => /^(hi|high|right)$/.test(v.name.toLowerCase()));
    if (lo && hi && typeof lo.value === "number" && typeof hi.value === "number") {
        return Math.max(0, hi.value - lo.value);
    }
    return 0;
}
/** Overall program complexity is the worst nested loop's estimate. */
function estimateProgram(file) {
    const loopIds = new Set();
    for (const s of file.steps)
        for (const l of s.loops)
            loopIds.add(l.id);
    if (loopIds.size === 0) {
        return { order: "O(1)", basis: "no loops visible", confidence: "high" };
    }
    const worst = [];
    for (const id of loopIds) {
        const est = estimateLoopComplexity(file, id);
        worst.push({ est, id, rank: rankOrder(est.order) });
    }
    worst.sort((a, b) => b.rank - a.rank);
    const top = worst[0];
    return {
        order: top.est.order,
        basis: `dominated by loop ${top.id}: ${top.est.basis}`,
        confidence: top.est.confidence,
    };
}
function rankOrder(o) {
    // Higher = asymptotically larger; unknowns rank lowest so we don't overclaim.
    if (o.includes("2ⁿ") || o.includes("2^n"))
        return 100;
    if (o.includes("n!") || o.includes("fact"))
        return 90;
    if (o.includes("n³") || o.includes("n^3"))
        return 80;
    if (o.includes("n²") || o.includes("n^2"))
        return 70;
    if (o.includes("n log"))
        return 60;
    if (o.includes("n"))
        return 50;
    if (o.includes("log"))
        return 40;
    if (o.includes("1)"))
        return 30;
    return 0; // O(?)
}
/**
 * Compute a variable-by-variable diff for two variable lists.
 *
 * Compound values (arrays / objects) recurse to produce children so the UI can
 * show inline diffs. Primitive differences show `before → after`. Unchanged
 * entries are still produced so the tree rendering knows to draw them dim.
 */
function diffVars(before, after) {
    const afterByName = new Map(after.map((v) => [v.name, v]));
    const seen = new Set();
    const out = [];
    for (const b of before) {
        seen.add(b.name);
        const a = afterByName.get(b.name);
        if (!a) {
            out.push({ name: b.name, kind: "removed", type: b.type, before: b.value });
        }
        else {
            out.push(valueDiff(b.name, b.value, a.value, b.type, a.type));
        }
    }
    for (const a of after) {
        if (seen.has(a.name))
            continue;
        out.push({ name: a.name, kind: "added", type: a.type, after: a.value });
    }
    // Stable ordering by name for the UI.
    out.sort((x, y) => x.name.localeCompare(y.name));
    return out;
}
function valueDiff(name, b, a, bType, aType) {
    // Quick structural equality using JSON stringify plus Object.is for scalars.
    const same = equalForDiff(b, a);
    const res = {
        name,
        kind: same ? "unchanged" : "modified",
        type: aType ?? bType,
    };
    if (Array.isArray(a) || Array.isArray(b)) {
        const bArr = Array.isArray(b) ? b : [];
        const aArr = Array.isArray(a) ? a : [];
        const len = Math.max(bArr.length, aArr.length);
        const kids = [];
        for (let i = 0; i < len; i += 1) {
            if (i >= bArr.length)
                kids.push({ name: String(i), kind: "added", after: aArr[i] });
            else if (i >= aArr.length)
                kids.push({ name: String(i), kind: "removed", before: bArr[i] });
            else
                kids.push(valueDiff(String(i), bArr[i], aArr[i]));
        }
        // If all children unchanged → overall unchanged.
        if (same)
            res.kind = "unchanged";
        res.children = kids;
        return res;
    }
    if (b !== null && a !== null && typeof b === "object" && typeof a === "object" && !Array.isArray(a) && !Array.isArray(b)) {
        const bRec = b;
        const aRec = a;
        const keys = Array.from(new Set([...Object.keys(bRec), ...Object.keys(aRec)])).sort();
        const kids = [];
        for (const k of keys) {
            if (!(k in bRec))
                kids.push({ name: k, kind: "added", after: aRec[k] });
            else if (!(k in aRec))
                kids.push({ name: k, kind: "removed", before: bRec[k] });
            else
                kids.push(valueDiff(k, bRec[k], aRec[k]));
        }
        res.children = kids;
        if (same)
            res.kind = "unchanged";
        return res;
    }
    // Scalar/leaf.
    res.before = b;
    res.after = a;
    if (same)
        res.kind = "unchanged";
    return res;
}
function equalForDiff(x, y) {
    if (Object.is(x, y))
        return true;
    if (Array.isArray(x) && Array.isArray(y)) {
        if (x.length !== y.length)
            return false;
        return x.every((xi, i) => equalForDiff(xi, y[i]));
    }
    if (x !== null && y !== null && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
        const xk = Object.keys(x);
        const yk = Object.keys(y);
        if (xk.length !== yk.length)
            return false;
        xk.sort();
        yk.sort();
        if (!xk.every((k, i) => k === yk[i]))
            return false;
        return xk.every((k) => equalForDiff(x[k], y[k]));
    }
    return false;
}
