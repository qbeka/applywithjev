// Runs inside the page through the fill runner (src/browser/formRunner.ts).
// Installs window.__awj: small read-only helpers plus the two writes the
// runner cannot do with real input events. Nothing here is page-supplied code.
(() => {
  const q = (s) => document.querySelector(s);
  // An attribute value inside a quoted CSS selector: backslashes and quotes escaped.
  const attr = (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "");
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const center = (el) => {
    // Instant: a page with smooth scrolling would otherwise report the position before the scroll.
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: r.width > 0 && r.height > 0 };
  };
  // Only a dropdown's own frame counts: a looser match would land clicks on some unrelated wrapper.
  const control = (el) => (el.getAttribute("role") === "combobox" && el.closest('[class*="select__control"], [class$="-control"]')) || el;
  const optionEls = (sel) => {
    const el = q(sel);
    if (!el) return [];
    const listId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    let root = listId ? document.getElementById(listId) : null;
    if (!root) {
      const wrap = el.closest('[class*="container"], [class*="select"], [class*="field"], [class*="question"]');
      root = wrap ? wrap.querySelector('[role=listbox], [class*="menu"]') : null;
    }
    if (!root) {
      // A plain input with a suggestion list beside it: its rows are the options.
      const box = el.parentElement && el.parentElement.querySelector('[class*="dropdown-results" i], [class*="autocomplete" i] ul, [class*="typeahead" i] ul, [class*="suggestions" i]');
      if (box) return [...box.children].filter(visible);
    }
    if (!root && el.getAttribute("aria-expanded") !== "true") return [];
    const all = root ? [...root.querySelectorAll("[role=option]")] : [...document.querySelectorAll("[role=option]")].filter((o) => !o.closest(".iti"));
    return all.filter(visible);
  };
  // Dropdown components keep their option list and their select handler on their own props.
  // Reading them is instant and needs no clicking. Two shapes are known:
  //   "select": react-select (Greenhouse). options + selectOption, and loadOptions when the list is lazy.
  //   "search": a search box with results (Ashby schools and locations). onSearch + results + onSelect.
  // For anything else these return null and the runner opens the dropdown with real clicks.
  const adapter = (el) => {
    const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let f = key ? el[key] : null;
    if (!f) return null;
    // The node may hold the previous render's fiber; the live tree is the one its root points at.
    let top = f;
    while (top.return) top = top.return;
    if (top.stateNode && top.stateNode.current && top.stateNode.current !== top && f.alternate) f = f.alternate;
    for (let i = 0; f && i < 12; i++, f = f.return) {
      const p = f.memoizedProps;
      if (!p) continue;
      if (typeof p.selectOption === "function" && Array.isArray(p.options)) return { shape: "select", p };
      if (typeof p.onSelect === "function" && typeof p.onSearch === "function") return { shape: "search", p };
    }
    return null;
  };
  const loaded = {};
  const flat = (options) => options.flatMap((o) => (o && Array.isArray(o.options) ? o.options : [o]));
  const labelOf = (a, o) => {
    const get = a.shape === "select" && a.p.selectProps && a.p.selectProps.getOptionLabel;
    const l = typeof get === "function" ? get(o) : o.label;
    return String(typeof l === "string" || typeof l === "number" ? l : o.label ?? o.name ?? o.placeName ?? o.title ?? o.value ?? "").replace(/\s+/g, " ").trim();
  };
  const optionsOf = (a) => (a.shape === "select" ? flat(a.p.options) : a.p.results || []);
  window.__awj = {
    /** Option labels straight from the component, or null when the control is not one of the known shapes. */
    reactOptions(sel) {
      const a = adapter(q(sel));
      return a ? optionsOf(a).map((o) => labelOf(a, o)) : null;
    },
    /** Starts a search in a search-as-you-type dropdown without touching the keyboard. */
    reactSearch(sel, typed) {
      const a = adapter(q(sel));
      if (!a) return false;
      if (a.shape === "search") {
        a.p.onSearch(typed);
        return true;
      }
      const onInput = a.p.selectProps && a.p.selectProps.onInputChange;
      if (typeof onInput !== "function") return false;
      onInput(typed, { action: "input-change", prevInputValue: "" });
      if (!typed && typeof a.p.selectProps.onMenuClose === "function") a.p.selectProps.onMenuClose();
      return true;
    },
    /** Opens or closes a react-select's menu through its own handlers, which is what makes a lazy list load. */
    reactMenu(sel, open) {
      const a = adapter(q(sel));
      const fn = a && a.shape === "select" && a.p.selectProps && (open ? a.p.selectProps.onMenuOpen : a.p.selectProps.onMenuClose);
      if (typeof fn !== "function") return false;
      fn();
      return true;
    },
    /**
     * Asks a paginated or lazy select for its options through its own loader, with a search text.
     * Returns the labels, or null when the control has no loader. The option objects are kept for reactSelect.
     */
    async reactLoad(sel, search) {
      const a = adapter(q(sel));
      const load = a && a.shape === "select" && a.p.selectProps && a.p.selectProps.loadOptions;
      if (typeof load !== "function") return null;
      const res = await load(search, [], a.p.selectProps.additional);
      const options = flat(Array.isArray(res) ? res : (res && res.options) || []);
      loaded[sel] = options;
      return options.map((o) => labelOf(a, o));
    },
    reactSelect(sel, label) {
      const a = adapter(q(sel));
      if (!a) return false;
      const o = optionsOf(a).find((x) => labelOf(a, x) === label) || (loaded[sel] || []).find((x) => labelOf(a, x) === label);
      if (!o) return false;
      if (a.shape === "search") {
        a.p.onSelect(o);
        return true;
      }
      a.p.selectOption(o);
      if (a.p.selectProps && typeof a.p.selectProps.onMenuClose === "function") a.p.selectProps.onMenuClose();
      return true;
    },
    /** Centre of the control to click, after scrolling it into view. */
    point(sel) {
      const el = q(sel);
      return el && visible(control(el)) ? center(control(el)) : { x: 0, y: 0, ok: false };
    },
    /**
     * "on" for a control that can take a value, "off" for one the form has hidden or disabled
     * (usually because of another answer), "missing" when the selector no longer finds anything.
     */
    state(sel) {
      const el = q(sel);
      if (!el) return "missing";
      return !el.disabled && (el.type === "file" || visible(el) || visible(control(el))) ? "on" : "off";
    },
    /** True when keyboard input would land in this control right now. */
    hasFocus(sel) {
      const el = q(sel);
      return !!el && (document.activeElement === el || el.contains(document.activeElement));
    },
    selectAll() {
      const a = document.activeElement;
      if (a && typeof a.select === "function") a.select();
    },
    options(sel) {
      return optionEls(sel).map(text);
    },
    optionPoint(sel, label) {
      const o = optionEls(sel).find((x) => text(x) === label);
      return o ? center(o) : { x: 0, y: 0, ok: false };
    },
    /** What the control shows as its current value. */
    shown(sel) {
      const el = q(sel);
      if (!el) return "";
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.type === "radio" && el.name) {
          const on = [...document.querySelectorAll(`input[type=radio][name="${attr(el.name)}"]`)].find((r) => r.checked);
          return on ? text(on.closest("label") || (on.id && document.querySelector(`label[for="${CSS.escape(on.id)}"]`)) || on.parentElement) || on.value : "";
        }
        return el.checked ? "checked" : "";
      }
      if (el.type === "file") {
        const wrap = el.closest('[class*="field"], [class*="upload"], [class*="file"], fieldset, div');
        return el.files && el.files.length ? el.files[0].name : /\.pdf/i.test(text(wrap)) ? text(wrap).slice(0, 80) : "";
      }
      if (el.tagName === "SELECT") return el.selectedOptions[0] && el.value !== "" ? text(el.selectedOptions[0]) : "";
      if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.getAttribute("role") === "combobox") {
        // A dropdown drawn without an input shows its value as its own text, or a placeholder when empty.
        const t = text(el);
        return /^(select|select\.\.\.|select an option|choose|search|please select)?$/i.test(t) ? "" : t;
      }
      if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
        // A button group: the pressed button's text.
        const on = [...el.querySelectorAll("button, [role=radio], [role=option]")].find((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /selected|active|checked/i.test(b.className) || b.dataset.state === "on" || b.dataset.state === "checked");
        return on ? text(on) : "";
      }
      if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list") {
        const a = adapter(el);
        if (a && a.shape === "select" && typeof a.p.getValue === "function") return a.p.getValue().map((o) => labelOf(a, o)).join(", ");
        if (a && a.shape === "search") return a.p.selectedItemText || el.value || "";
        // Selectize keeps the picks as items beside an input that stays empty.
        const selectize = el.closest(".selectize-input");
        if (selectize) return [...selectize.querySelectorAll(".item")].map(text).join(", ") || el.value || "";
        const c = control(el);
        const single = c.querySelector('[class*="single-value"], [class*="singleValue"]');
        const multi = [...c.querySelectorAll('[class*="multi-value__label"], [class*="multiValue"]')].map(text).join(", ");
        return single ? text(single) : multi || el.value || "";
      }
      return el.value || "";
    },
    /** True when the page shows this file name, which is how an accepted upload looks once the input is replaced. */
    showsFile(name) {
      return (document.body.innerText || "").includes(name) || [...document.querySelectorAll("input[type=file]")].some((i) => i.files && [...i.files].some((f) => f.name === name));
    },
    blur() {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    },
    errors() {
      return [...document.querySelectorAll('[aria-invalid="true"], [class*="error" i]')].filter(visible).map(text).filter((t) => t && t.length < 200).slice(0, 20);
    },
    pageText() {
      return document.body ? document.body.innerText : "";
    },
    controlCount() {
      return document.readyState !== "loading" ? document.querySelectorAll("input, select, textarea").length : -1;
    },
    clickByText(pattern) {
      const re = new RegExp(pattern, "i");
      const b = [...document.querySelectorAll("a, button, [role=button]")].find((x) => visible(x) && re.test(text(x)));
      return b ? center(b) : { x: 0, y: 0, ok: false };
    },
  };
  return "ok";
})();
