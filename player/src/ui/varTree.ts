/**
 * Variable tree pane.
 *
 * Renders the current scope's `vars` as an expandable tree. Compound values
 * (arrays / plain objects) collapse by default to a one-line summary and
 * expand on click. Expansion state is keyed by a stable value-path so it
 * survives stepping across frames (the user's open nodes stay open).
 */
import type { TraceVar } from "../types";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export class VarTree {
  private readonly host: HTMLElement;
  /** Paths (e.g. "arr[1].name") the user has expanded. */
  private expanded = new Set<string>();

  constructor(host: HTMLElement) {
    this.host = host;
  }

  render(vars: TraceVar[]): void {
    this.host.replaceChildren();
    if (vars.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "(no variables in scope)";
      this.host.append(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const v of vars) frag.append(this.renderVar(v.name, v.value, v.type, v.name));
    this.host.append(frag);
  }

  private renderVar(name: string, value: unknown, type: string, path: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "var-row";

    const json = this.toJson(value);
    const isCompound = Array.isArray(json) || (json !== null && typeof json === "object");
    const isOpen = this.expanded.has(path);

    const toggle = document.createElement("span");
    toggle.className = "var-toggle";
    toggle.textContent = isCompound ? (isOpen ? "▾" : "▸") : "";

    const nameEl = document.createElement("span");
    nameEl.className = "var-name";
    nameEl.textContent = name;

    const eq = document.createElement("span");
    eq.className = "var-eq";
    eq.textContent = "=";

    row.append(toggle, nameEl, eq, this.renderValue(json, path, !isCompound || isOpen));

    if (!isCompound) return row;
    row.classList.add("expandable");
    row.addEventListener("click", (e) => {
      // Only toggle on direct row clicks, not on nested expansions.
      if (e.target instanceof HTMLElement && e.target.closest(".var-row") !== row) return;
      e.stopPropagation();
      if (this.expanded.has(path)) this.expanded.delete(path);
      else this.expanded.add(path);
      this.rerender(row, name, value, type, path);
    });

    return row;
  }

  /** Re-render a single row after a toggle, preserving siblings. */
  private rerender(row: HTMLElement, name: string, value: unknown, type: string, path: string): void {
    const fresh = this.renderVar(name, value, type, path);
    row.replaceWith(fresh);
  }

  private renderValue(json: Json, path: string, expanded: boolean): HTMLElement {
    const el = document.createElement("span");
    el.className = "var-value";

    if (json === null) {
      el.classList.add("null");
      el.textContent = "None";
      return el;
    }
    if (typeof json === "string") {
      el.classList.add("str");
      el.textContent = JSON.stringify(json);
      return el;
    }
    if (typeof json === "number" || typeof json === "boolean") {
      el.classList.add("num");
      el.textContent = String(json);
      return el;
    }

    // Compound: array or object.
    const summary = document.createElement("span");
    summary.className = "var-type";
    if (Array.isArray(json)) {
      summary.textContent = expanded ? "[" : `list[${json.length}]`;
    } else {
      const keys = Object.keys(json as { [k: string]: Json });
      summary.textContent = expanded ? "{" : `dict{${keys.length}}`;
    }
    el.append(summary);

    if (!expanded) return el;

    const child = document.createElement("div");
    child.style.marginLeft = "16px";
    if (Array.isArray(json)) {
      json.forEach((item, i) => {
        child.append(this.renderVar(String(i), item, this.typeOf(item), `${path}[${i}]`));
      });
    } else {
      for (const [k, v] of Object.entries(json as { [k: string]: Json })) {
        child.append(this.renderVar(k, v, this.typeOf(v), `${path}.${k}`));
      }
    }
    el.append(child);
    return el;
  }

  private typeOf(v: unknown): string {
    if (v === null) return "NoneType";
    if (Array.isArray(v)) return "list";
    return typeof v;
  }

  /** Coerce adapter values into plain JSON-safe shapes for rendering. */
  private toJson(v: unknown): Json {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.map((x) => this.toJson(x));
    if (typeof v === "object") {
      const out: { [k: string]: Json } = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        try {
          out[k] = this.toJson(val);
        } catch {
          out[k] = String(val);
        }
      }
      return out;
    }
    return String(v);
  }
}
