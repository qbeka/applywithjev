// Runs inside the page. A function, called by the fill runner with the fills
// of a plan produced by mapForm: [{ selector, kind, value }]. Returns a JSON
// report of what was applied and what failed. To use it by hand in a browser
// console, wrap it in parentheses and call it with the array.
(fills) => {
  const report = { applied: [], failed: [] };
  // An attribute value inside a quoted CSS selector: backslashes and quotes escaped.
  const attr = (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const setNative = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  };
  const fire = (el, types) => types.forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true, cancelable: true })));
  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

  for (const f of fills) {
    try {
      const el = document.querySelector(f.selector);
      if (!el) { report.failed.push({ selector: f.selector, why: "not found" }); continue; }
      el.scrollIntoView({ block: "center" });
      if (f.kind === "select") {
        const opt = [...el.options].find((o) => o.value === f.value) || [...el.options].find((o) => norm(o.text) === norm(f.value)) || [...el.options].find((o) => norm(o.text).includes(norm(f.value)));
        if (!opt) { report.failed.push({ selector: f.selector, why: "option not found: " + f.value }); continue; }
        setNative(el, opt.value);
        fire(el, ["input", "change"]);
      } else if (f.kind === "radio" && el.tagName !== "INPUT") {
        // A button group: click the button whose text matches.
        const buttons = [...el.querySelectorAll("button, [role=radio], [role=option]")];
        const want = norm(f.value);
        const btn = buttons.find((b) => norm(b.innerText || b.textContent) === want) || buttons.find((b) => norm(b.innerText || b.textContent).includes(want));
        if (!btn) { report.failed.push({ selector: f.selector, why: "button option not found: " + f.value }); continue; }
        btn.click();
      } else if (f.kind === "radio") {
        const name = el.name;
        const group = name ? document.querySelectorAll(`input[type=radio][name="${attr(name)}"]`) : [el];
        const labelOf = (r) => { const l = (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) || r.closest("label") || r.parentElement; return norm(l && (l.innerText || l.textContent)); };
        let target = [...group].find((r) => labelOf(r) === norm(f.value));
        if (!target) target = [...group].find((r) => labelOf(r).includes(norm(f.value)));
        if (!target) target = [...group].find((r) => r.value === f.value && r.value !== "on");
        if (!target) { report.failed.push({ selector: f.selector, why: "radio option not found: " + f.value }); continue; }
        target.click();
        if (!target.checked) { target.checked = true; fire(target, ["input", "change", "click"]); }
      } else if (f.kind === "checkbox") {
        const want = /^(true|yes|1|on|checked)$/i.test(f.value);
        if (el.checked !== want) { el.click(); if (el.checked !== want) { el.checked = want; fire(el, ["input", "change", "click"]); } }
      } else if (f.kind === "combobox") {
        el.focus();
        el.click();
        setNative(el, f.value);
        fire(el, ["input", "change"]);
        // Most comboboxes (react-select, Ashby, Lever) render options synchronously after input.
        const options = [...document.querySelectorAll("[role=option], [class*=option i][id*=option i], li[class*=option i]")].filter((o) => o.offsetParent !== null);
        const want = norm(f.value);
        const opt = options.find((o) => norm(o.innerText || o.textContent) === want) || options.find((o) => norm(o.innerText || o.textContent).startsWith(want)) || options.find((o) => norm(o.innerText || o.textContent).includes(want)) || options[0];
        if (opt) {
          opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          opt.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          opt.click();
        } else {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        }
        report.applied.push(f.selector + (opt ? " → " + (opt.innerText || "").trim().slice(0, 40) : " (typed, no option list seen)"));
        continue;
      } else {
        el.focus();
        setNative(el, f.value);
        fire(el, ["input", "change"]);
        el.blur();
      }
      report.applied.push(f.selector);
    } catch (e) {
      report.failed.push({ selector: f.selector, why: String(e) });
    }
  }
  return JSON.stringify(report);
};
